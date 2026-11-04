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
import { appFileHeaders, bytesEtag, etagMatches } from "./app-file-headers.ts";

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
    // The favicon is the one app file that used to answer with a bare
    // content-type: no validator and no policy, so every page load fetched
    // it again (and it is on the token-free list, so a browser may ask for
    // it on any page). It changes only with a release, which rebuilds the
    // bundle: revalidate like the other app files.
    const etag = bytesEtag(png);
    const headers = {
      "content-type": "image/png",
      ...appFileHeaders("revalidate", etag),
    };
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      return c.body(null, 304, headers);
    }
    // `c.body` wants a body whose buffer is an ArrayBuffer; the bytes
    // come from the bundle and are copied exactly as they are.
    return c.newResponse(
      new Uint8Array(png).buffer as ArrayBuffer,
      200,
      headers,
    );
  });

  return { renderPage };
}
