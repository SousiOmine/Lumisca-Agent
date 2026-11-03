import { dirname, join, relative } from "node:path";
import { contentEtag } from "./app-file-headers.ts";
import { bundleClient } from "./bundle.ts";
import { webClientEntry, webFaviconPath, webStylesPath } from "./paths.ts";

/**
 * The frontend assets a server can serve: the bundled client (the entry chunk
 * and the chunks its dynamic imports fetch), the styles, and the favicon
 * (binary assets base64-encoded so the manifest is text). This module is the
 * single owner of those assets — both the pre-build script
 * (scripts/build-server.ts) and the runtime Assets class use it, so the
 * packaged and dev asset sources cannot drift.
 */

/** One file of the client build. */
export interface AssetFile {
  /** The file's contents. */
  body: string;
  /** The validator of `body` (see app-file-headers.ts), recorded at build
   * time so serving the file is a lookup rather than a scan of ~450 KB. */
  etag: string;
}

export interface AssetsManifest {
  /** The client build, keyed by the name its `/assets/*` URL serves: the
   * entry chunk (`app.js`, the one render.ts loads) and every chunk a dynamic
   * import fetches later. */
  client: Record<string, AssetFile>;
  "styles.css": string;
  "favicon.png": string;
}

/** Resolve the styles entry (`styles.css`) into a single stylesheet.
 * The entry is a manifest of relative `@import "./styles/<part>.css";`
 * lines (see `packages/web/src/styles/README.md`); the imports are inlined
 * in order so the cascade matches what Vite serves in dev. A plain
 * stylesheet without imports is returned as-is (backwards compatible). */
export async function bundleStylesCss(entryPath: string): Promise<string> {
  const entry = await Deno.readTextFile(entryPath);
  const importPattern = /@import\s+"([^"]+)";/g;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(entry)) !== null) {
    const rel = match[1];
    if (rel !== undefined) parts.push(rel);
  }
  if (parts.length === 0) return entry;
  const rest = entry
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(importPattern, "")
    .trim();
  if (rest !== "") {
    throw new Error(
      `${entryPath}: only comments and relative @import lines are allowed`,
    );
  }
  const dir = dirname(entryPath);
  const bodies = await Promise.all(parts.map(async (rel) => {
    if (!rel.endsWith(".css")) {
      throw new Error(`${entryPath}: non-css import is not allowed: ${rel}`);
    }
    // join() normalizes `..`; anything left pointing outside the web
    // sources is rejected instead of read.
    const resolved = join(dir, rel);
    if (relative(dir, resolved).startsWith("..")) {
      throw new Error(`${entryPath}: import escapes the web sources: ${rel}`);
    }
    return await Deno.readTextFile(resolved);
  }));
  return bodies.join("\n");
}

/** Bundle the client into `outdir` and read every file the build wrote. The
 * returned map is the client's whole serving surface: a name the build did
 * not produce has no entry, so the `/assets/*` route cannot reach a file it
 * should not serve. */
async function bundleClientFiles(
  repoRoot: string,
  outdir: string,
): Promise<Record<string, AssetFile>> {
  await Deno.mkdir(outdir, { recursive: true });
  const bundle = await bundleClient({
    cwd: repoRoot,
    entry: webClientEntry(repoRoot),
    outdir,
  });
  const files: Record<string, AssetFile> = {};
  for (const name of bundle.files) {
    const body = await Deno.readTextFile(join(outdir, name));
    files[name] = { body, etag: contentEtag(body) };
  }
  return files;
}

/** The client's size as it goes on the wire: the manifest is text, so each
 * file costs its UTF-8 encoding. */
function clientBytesOf(client: Record<string, AssetFile>): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const file of Object.values(client)) {
    bytes += encoder.encode(file.body).length;
  }
  return bytes;
}

/** Bundle the client and read the static assets into a manifest. This is
 * the only producer of embedded assets; the runtime Assets class serves
 * either these or the repository sources. */
export async function buildAssetsManifest(
  repoRoot: string,
): Promise<{ manifest: AssetsManifest; clientBytes: number }> {
  const outdir = await Deno.makeTempDir({ prefix: "lumisca-client-" });
  try {
    const client = await bundleClientFiles(repoRoot, outdir);
    const css = await bundleStylesCss(webStylesPath(repoRoot));
    const faviconBytes = await Deno.readFile(webFaviconPath(repoRoot));
    // Chunked so any icon size stays within the call-stack limits of
    // spread + String.fromCharCode.
    let faviconB64 = "";
    for (let i = 0; i < faviconBytes.length; i += 0x8000) {
      faviconB64 += btoa(
        String.fromCharCode(...faviconBytes.subarray(i, i + 0x8000)),
      );
    }
    return {
      manifest: {
        client,
        "styles.css": css,
        "favicon.png": faviconB64,
      },
      clientBytes: clientBytesOf(client),
    };
  } finally {
    await Deno.remove(outdir, { recursive: true }).catch(() => {});
  }
}

/** Load a prebuilt manifest from a JSON file (LUMISCA_ASSETS_FILE). */
export function readAssetsManifest(path: string): AssetsManifest {
  return JSON.parse(Deno.readTextFileSync(path)) as AssetsManifest;
}

/** Lazily built/loaded frontend assets (client files, css, favicon). */
export class Assets {
  // A single memoized promise: a resolved promise keeps returning the same
  // value, and a failed build nulls the slot so the next request retries.
  private clientPromise: Promise<Record<string, AssetFile>> | null = null;
  private cssCache: string | null = null;
  private faviconCache: Uint8Array | null = null;
  /** Memoized embedded manifest (undefined = not read yet, or the last read
   * failed and the next request may try again). */
  private manifestCache: AssetsManifest | undefined = undefined;

  constructor(
    private readonly repoRoot: string,
    private readonly cacheDir: string,
    private readonly assetsFile?: string,
  ) {}

  /** Packaged builds (deno compile, no repository layout) serve the
   * prebuilt assets from the manifest staged beside the binary
   * (scripts/build-server.ts), or from the path given by
   * LUMISCA_ASSETS_FILE (the desktop shell passes its resource copy).
   *
   * Read once per process: the manifest is the whole client build and the
   * stylesheet (several hundred KB) and never changes while the server
   * runs — and after an update the *new* manifest must not start leaking
   * into the still-running old server (the updater replaces it in place; see
   * packages/server/update/install.ts), which would pair a new UI with an old
   * API. A read that FAILS is not memoized (the real manifest may be
   * mid-replace, or the desktop bundle not unpacked yet): the next request
   * retries, like the sibling caches, so a transient failure cannot leave the
   * process unable to serve its UI until it is restarted. */
  private embedded(): AssetsManifest | undefined {
    if (!this.assetsFile) return undefined;
    if (this.manifestCache === undefined) {
      try {
        this.manifestCache = readAssetsManifest(this.assetsFile);
      } catch {
        // Retried on the next request (see above).
        return undefined;
      }
    }
    return this.manifestCache;
  }

  private hasWebSources(): boolean {
    try {
      return Deno.statSync(webClientEntry(this.repoRoot)).isFile;
    } catch {
      return false;
    }
  }

  /** Build once; concurrent first requests share the same build. */
  private getClient(): Promise<Record<string, AssetFile>> {
    if (this.clientPromise === null) {
      this.clientPromise = this.buildClient().catch((error) => {
        // A failed build must not poison the cache: the next request
        // retries.
        this.clientPromise = null;
        throw error;
      });
    }
    return this.clientPromise;
  }

  /** One file of the client build by the name its `/assets/*` URL carries,
   * or undefined when this build has no such file. The manifest is the whole
   * authority: an unknown (or path-like) name never reaches the file
   * system.
   *
   * `hasOwn` because the manifest is a plain object: without it a request
   * for `/assets/constructor` would find `Object`'s member rather than a
   * file. */
  async getClientFile(name: string): Promise<AssetFile | undefined> {
    const client = await this.getClient();
    return Object.hasOwn(client, name) ? client[name] : undefined;
  }

  private buildClient(): Promise<Record<string, AssetFile>> {
    return this.source(
      async () => {
        const outdir = join(this.cacheDir, "client");
        await Deno.mkdir(outdir, { recursive: true });
        return await bundleClientFiles(this.repoRoot, outdir);
      },
      (manifest) => manifest.client,
      "Frontend sources not found and no embedded assets " +
        "(set LUMISCA_ASSETS_FILE or run from the repository)",
    );
  }

  async getCss(): Promise<string> {
    if (this.cssCache === null) {
      this.cssCache = await this.source(
        () => bundleStylesCss(webStylesPath(this.repoRoot)),
        (manifest) => manifest["styles.css"],
        "styles.css not found and no embedded assets",
      ).catch((error) => {
        // A failed build must not poison the cache: the next request
        // retries (same rule as the client bundle).
        this.cssCache = null;
        throw error;
      });
    }
    return this.cssCache;
  }

  async getFavicon(): Promise<Uint8Array> {
    if (this.faviconCache === null) {
      this.faviconCache = await this.source(
        () => Deno.readFile(webFaviconPath(this.repoRoot)),
        // The packaged manifest stores binary assets as base64 text.
        (manifest) => {
          const encoded = manifest["favicon.png"];
          return encoded === undefined
            ? undefined
            : Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        },
        "favicon.png not found and no embedded assets",
      ).catch((error) => {
        this.faviconCache = null;
        throw error;
      });
    }
    return this.faviconCache;
  }

  /**
   * Resolve one asset from this checkout, or from the packaged manifest when
   * there is no checkout to build from.
   *
   * Every asset makes the same two-way decision (`hasWebSources`), and each
   * used to carry its own copy of the `if` plus its own "no embedded assets"
   * message — three branches, three error strings, three chances for one of
   * them to forget the retry-after-failure rule. What differs is only where
   * the asset comes from: this is that half.
   *
   * `readEmbedded` gets the whole manifest because the three assets are read
   * from different keys (a client map, a stylesheet string, a base64 icon);
   * a missing entry is the caller's own failure message.
   */
  private async source<T>(
    build: () => Promise<T> | T,
    readEmbedded: (manifest: AssetsManifest) => T | undefined,
    missing: string,
  ): Promise<T> {
    if (this.hasWebSources()) return await build();
    const manifest = this.embedded();
    const value = manifest === undefined ? undefined : readEmbedded(manifest);
    if (value === undefined) throw new Error(missing);
    return value;
  }
}
