import type { Context, Hono } from "hono";
import {
  errorMessage,
  LANGUAGE_KEY,
  type Locale,
  type LumiscaCore,
  MCP_OAUTH_CALLBACK_PATH,
  parseAcceptLanguage,
  parseLocale,
  resolveLocale,
  systemLanguageTags,
  THEME_KEY,
  type ThemeSetting,
} from "@lumisca/core";
import type { InitialData } from "@lumisca/core/shared";
import type { Assets } from "./assets.ts";
import { renderHtmlDocument } from "./render.ts";

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
        pageHost: pageHostOf(c),
        token: options.token,
        language,
      }),
      200,
      { "content-type": "text/html; charset=utf-8" },
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
    });
  });

  app.get("/assets/app.js", async (c) => {
    try {
      const js = await assets.getAppJs();
      return c.body(js, 200, {
        "content-type": "application/javascript; charset=utf-8",
      });
    } catch (error) {
      return c.text(
        `Client bundle build failed: ${errorMessage(error)}`,
        500,
      );
    }
  });

  app.get("/styles.css", async (c) => {
    try {
      const css = await assets.getCss();
      return c.body(css, 200, { "content-type": "text/css; charset=utf-8" });
    } catch (error) {
      return c.text(`Stylesheet build failed: ${errorMessage(error)}`, 500);
    }
  });

  app.get("/favicon.png", async (c) => {
    try {
      const png = await assets.getFavicon();
      return c.newResponse(png.buffer as ArrayBuffer, 200, {
        "content-type": "image/png",
      });
    } catch {
      return c.text("not found", 404);
    }
  });

  return { renderPage };
}

/** The page's own host, so the CSP can name the WebSocket endpoint even when
 * the page is served remotely. Re-parsed (not the raw header) so userinfo or
 * quotes can never reach the CSP attribute. */
function pageHostOf(c: Context): string {
  const host = c.req.header("host");
  if (!host) return "";
  try {
    return new URL(`http://${host}`).host;
  } catch {
    return "";
  }
}

/** Paths the token guard lets through: the app's bundle and icon (no secret
 * in them) and the MCP OAuth callback. `/assets/initial-data.js` carries the
 * token itself and is deliberately absent. */
export function unguardedPath(path: string): boolean {
  return path === "/assets/app.js" || path === "/styles.css" ||
    path === "/favicon.png" || path === MCP_OAUTH_CALLBACK_PATH;
}
