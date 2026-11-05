import type { Context, Hono } from "hono";
import {
  errorMessage,
  LANGUAGE_KEY,
  type Locale,
  type LumiscaCore,
  parseAcceptLanguage,
  parseLocale,
  resolveLocale,
  systemLanguageTags,
  THEME_KEY,
  type ThemeSetting,
} from "@lumisca/core";
import type { InitialData } from "@lumisca/core/shared";
import type { AssetFile, Assets } from "./assets.ts";
import { safePageHost } from "./security.ts";
import { renderHtmlDocument } from "./render.ts";
import { renderManifest } from "./manifest.ts";
import {
  appFileHeaders,
  bytesEtag,
  contentEtag,
  etagMatches,
} from "./app-file-headers.ts";

/** Theme preference from the core settings ("system" when unset/unknown).
 * The client resolves "system" via prefers-color-scheme; the shell falls back
 * to dark for the first paint. */
function themeOf(core: LumiscaCore): ThemeSetting {
  const stored = core.getSetting(THEME_KEY);
  return stored === "light" ? "light" : stored === "system" ? "system" : "dark";
}

/** Resolved theme for the shell's first paint (no client-side flash). */
function resolvedThemeOf(core: LumiscaCore): "light" | "dark" {
  return themeOf(core) === "light" ? "light" : "dark";
}

/** The app language of one request: the stored setting when the user chose
 * one, else the browser's preference (Accept-Language), else the machine's
 * locale. Shared with the MCP routes (their OAuth page renders the same way). */
export function languageForRequest(
  core: LumiscaCore,
  c: Context,
): Locale {
  return resolveLocale(core.getSetting(LANGUAGE_KEY), [
    ...parseAcceptLanguage(c.req.header("accept-language")),
    ...systemLanguageTags(),
  ]);
}

/** Register the page, the bootstrap script and the static assets. Error
 * policy differs from the API on purpose: an asset failure answers plain text
 * (a browser shows it directly; a JSON body would be a blob). */
export function registerPages(
  app: Hono,
  core: LumiscaCore,
  assets: Assets,
  options: { token?: string },
): { renderPage: (c: Context) => Promise<Response> } {
  const initialData = (language: Locale): InitialData => ({
    workspaces: core.listWorkspaces(),
    theme: themeOf(core),
    language,
  });

  /** Render the app shell for one request (also the SPA fallback). */
  const renderPage = async (c: Context): Promise<Response> => {
    const css = await assets.getCss();
    const language = languageForRequest(core, c);
    // First run (no language chosen yet): remember what this request asked
    // for. Idempotent and deliberate about happening on a GET: the value has
    // to exist before the first session is created. From here on the settings
    // dialog is the only writer.
    if (parseLocale(core.getSetting(LANGUAGE_KEY)) === undefined) {
      core.setSetting(LANGUAGE_KEY, language);
    }
    // Through the context (`c.newResponse`) rather than a raw Response: only
    // then do headers a middleware set — the token cookie included — reach
    // the final response.
    return c.newResponse(
      renderHtmlDocument(css, resolvedThemeOf(core), {
        pageHost: safePageHost(c.req.header("host")),
        token: options.token,
        language,
      }),
      200,
      {
        "content-type": "text/html; charset=utf-8",
        // The document carries the auth token: a shared cache (or the
        // browser's own on-disk copy) must not keep it.
        ...appFileHeaders("no-store"),
      },
    );
  };

  app.get("/", (c) => renderPage(c));
  app.get("/assets/initial-data.js", (c) => {
    // `<` is escaped so the JSON can never close the script tag.
    const safeData = JSON.stringify(initialData(languageForRequest(core, c)))
      .replace(/</g, "\\u003c");
    const tokenLine = options.token
      ? `\nwindow.__LUMISCA_TOKEN__ = ${JSON.stringify(options.token)};`
      : "";
    return c.body(`window.__INITIAL_DATA__ = ${safeData};${tokenLine}`, 200, {
      "content-type": "application/javascript; charset=utf-8",
      // This one carries the token itself.
      ...appFileHeaders("no-store"),
    });
  });

  /** Answer a revalidatable app file, or 304 when the client already has
   * this exact build. The bundle is ~450 KB and its URL is stable across
   * builds, so the round trip is what a reload costs instead of the payload
   * — the difference between opening the app over a tailnet in a second and
   * in several. `etag` comes from the file: the manifest records it at build
   * time, the stylesheet is hashed here. */
  const serveRevalidatable = (
    c: Context,
    body: string,
    contentType: string,
    etag: string,
  ): Response => {
    const headers = {
      "content-type": contentType,
      ...appFileHeaders("revalidate", etag),
    };
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      // A 304 keeps the validator and the policy (the browser reuses its
      // copy), and carries no body.
      return c.body(null, 304, headers);
    }
    return c.body(body, 200, headers);
  };

  /** Answer a PNG with a validator, or 304 when the client already has it.
   * The favicon and the PWA icons share this: all are on the token-free
   * list (a browser may ask for them on any page, and the install pipeline
   * asks without a cookie), and all change only with a release. */
  const servePng = (c: Context, png: Uint8Array): Response => {
    const etag = bytesEtag(png);
    const headers = {
      "content-type": "image/png",
      ...appFileHeaders("revalidate", etag),
    };
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      // A 304 keeps the validator and the policy (the browser reuses its
      // copy), and carries no body.
      return c.body(null, 304, headers);
    }
    // `c.body` wants a body whose buffer is an ArrayBuffer; the bytes
    // come from the bundle and are copied exactly as they are.
    return c.newResponse(
      new Uint8Array(png).buffer as ArrayBuffer,
      200,
      headers,
    );
  };

  /** The client build: the entry chunk the page loads (`app.js`) and the
   * chunks its dynamic imports fetch later (`@novnc/novnc` for the stella
   * screen, `motion/mini`). The name is looked up in the manifest, never
   * joined to a path, so a path-like or stale name is simply not this
   * build's file. */
  app.get("/assets/:file", async (c) => {
    let file: AssetFile | undefined;
    try {
      file = await assets.getClientFile(c.req.param("file"));
    } catch (error) {
      return c.text(
        `Client bundle build failed: ${errorMessage(error)}`,
        500,
      );
    }
    if (file === undefined) return c.text("Not found", 404);
    return serveRevalidatable(
      c,
      file.body,
      "application/javascript; charset=utf-8",
      file.etag,
    );
  });

  app.get("/favicon.png", async (c) => {
    let png: Uint8Array;
    try {
      png = await assets.getFavicon();
    } catch {
      return c.text("not found", 404);
    }
    // Revalidated like every other app file: it changes only with a release,
    // which rebuilds the bundle.
    return servePng(c, png);
  });

  /** The web app manifest: what makes this page installable. Built per
   * request so the install screen matches the theme the page starts in and
   * the language this browser asked for (see manifest.ts).
   *
   * The PWA surface below — this, its icons and the service worker — is on
   * security.ts's token-free list: a browser's install pipeline fetches them
   * by itself, and none of them carries a secret. */
  app.get("/manifest.webmanifest", (c) => {
    const body = renderManifest({
      theme: resolvedThemeOf(core),
      language: languageForRequest(core, c),
    });
    return serveRevalidatable(
      c,
      body,
      "application/manifest+json",
      contentEtag(body),
    );
  });

  /** The icons the manifest names, plus the one iOS reads from the page's
   * `<link>`. The name is looked up in the build's own list, never joined to
   * a path, so a path-like or unknown name is not this build's file. */
  app.get("/pwa/:name", async (c) => {
    let png: Uint8Array | undefined;
    try {
      png = await assets.getPwaIcon(c.req.param("name"));
    } catch (error) {
      return c.text(`PWA icon unavailable: ${errorMessage(error)}`, 500);
    }
    if (png === undefined) return c.text("Not found", 404);
    return servePng(c, png);
  });

  /** The service worker. A worker is fetched by the browser itself, outside
   * any page's cache policy, so it is answered from this build (packaged
   * builds carry it in assets.json). The revalidate policy is what makes the
   * browser check this file on every load: a changed byte here is the whole
   * update mechanism of the worker. */
  app.get("/sw.js", async (c) => {
    let body: string;
    try {
      body = await assets.getServiceWorker();
    } catch (error) {
      return c.text(
        `Service worker unavailable: ${errorMessage(error)}`,
        500,
      );
    }
    return serveRevalidatable(
      c,
      body,
      "application/javascript; charset=utf-8",
      contentEtag(body),
    );
  });

  return { renderPage };
}
