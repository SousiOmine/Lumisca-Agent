import { dirname, join, relative } from "node:path";
import { bundleClient } from "./bundle.ts";
import { webClientEntry, webFaviconPath, webStylesPath } from "./paths.ts";

/**
 * The frontend assets a server can serve: the bundled client, the styles,
 * and the favicon (binary assets base64-encoded so the manifest is text).
 * This module is the single owner of those assets — both the pre-build
 * script (scripts/build-server.ts) and the runtime Assets class use it, so
 * the packaged and dev asset sources cannot drift.
 */

export interface AssetsManifest {
  "app.js": string;
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

/** Bundle the client and read the static assets into a manifest. This is
 * the only producer of embedded assets; the runtime Assets class serves
 * either these or the repository sources. */
export async function buildAssetsManifest(
  repoRoot: string,
): Promise<{ manifest: AssetsManifest; appJsBytes: number }> {
  const tmp = join(
    Deno.env.get("TMPDIR") ?? Deno.env.get("TEMP") ?? "/tmp",
    `lumisca-app-${crypto.randomUUID()}.js`,
  );
  try {
    await bundleClient({
      cwd: repoRoot,
      entry: webClientEntry(repoRoot),
      outfile: tmp,
    });
    const appJs = await Deno.readTextFile(tmp);
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
        "app.js": appJs,
        "styles.css": css,
        "favicon.png": faviconB64,
      },
      appJsBytes: appJs.length,
    };
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

/** Load a prebuilt manifest from a JSON file (LUMISCA_ASSETS_FILE). */
export function readAssetsManifest(path: string): AssetsManifest {
  return JSON.parse(Deno.readTextFileSync(path)) as AssetsManifest;
}

/** Lazily built/loaded frontend assets (client bundle, css, favicon). */
export class Assets {
  // A single memoized promise: a resolved promise keeps returning the same
  // value, and a failed build nulls the slot so the next request retries.
  private appJsPromise: Promise<string> | null = null;
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
   * Read once per process: the manifest is ~350 KB and never changes while
   * the server runs — and after an update the *new* manifest must not start
   * leaking into the still-running old server (the updater replaces it in
   * place; see packages/server/update/install.ts), which would pair a new
   * UI with an old API. A read that FAILS is not memoized (the real
   * manifest may be mid-replace, or the desktop bundle not unpacked yet):
   * the next request retries, like the sibling caches, so a transient
   * failure cannot leave the process unable to serve its UI until it is
   * restarted. */
  private embedded(name: keyof AssetsManifest): string | undefined {
    if (!this.assetsFile) return undefined;
    if (this.manifestCache === undefined) {
      try {
        this.manifestCache = readAssetsManifest(this.assetsFile);
      } catch {
        // Retried on the next request (see above).
        return undefined;
      }
    }
    return this.manifestCache?.[name];
  }

  private hasWebSources(): boolean {
    try {
      return Deno.statSync(webClientEntry(this.repoRoot)).isFile;
    } catch {
      return false;
    }
  }

  /** Build once; concurrent first requests share the same build. */
  getAppJs(): Promise<string> {
    if (this.appJsPromise === null) {
      this.appJsPromise = this.buildAppJs().catch((error) => {
        // A failed build must not poison the cache: the next request
        // retries (in dev, invalidate() also clears it).
        this.appJsPromise = null;
        throw error;
      });
    }
    return this.appJsPromise;
  }

  private buildAppJs(): Promise<string> {
    return (async (): Promise<string> => {
      if (!this.hasWebSources()) {
        // Packaged build: serve the prebuilt bundle.
        const embedded = this.embedded("app.js");
        if (embedded !== undefined) return embedded;
        throw new Error(
          "Frontend sources not found and no embedded assets " +
            "(set LUMISCA_ASSETS_FILE or run from the repository)",
        );
      }
      await Deno.mkdir(this.cacheDir, { recursive: true });
      const outfile = join(this.cacheDir, "app.js");
      await bundleClient({
        cwd: this.repoRoot,
        entry: webClientEntry(this.repoRoot),
        outfile,
      });
      return Deno.readTextFile(outfile);
    })();
  }

  async getCss(): Promise<string> {
    if (this.cssCache === null) {
      if (this.hasWebSources()) {
        this.cssCache = await bundleStylesCss(webStylesPath(this.repoRoot));
      } else {
        const embedded = this.embedded("styles.css");
        if (embedded === undefined) {
          throw new Error("styles.css not found and no embedded assets");
        }
        this.cssCache = embedded;
      }
    }
    return this.cssCache;
  }

  async getFavicon(): Promise<Uint8Array> {
    if (this.faviconCache === null) {
      if (this.hasWebSources()) {
        this.faviconCache = await Deno.readFile(webFaviconPath(this.repoRoot));
      } else {
        const embedded = this.embedded("favicon.png");
        if (embedded === undefined) {
          throw new Error("favicon.png not found and no embedded assets");
        }
        // The packaged manifest stores binary assets as base64 text.
        this.faviconCache = Uint8Array.from(
          atob(embedded),
          (c) => c.charCodeAt(0),
        );
      }
    }
    return this.faviconCache;
  }
}
