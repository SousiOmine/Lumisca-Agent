import { request } from "./api-client.ts";
import type { InitialData } from "./types.ts";

declare global {
  /** Initial data injected by the server bootstrap script. */
  var __INITIAL_DATA__: InitialData | undefined;
}

/** The desktop shell's launch parameters.
 *
 * The shell navigates to the bundled UI with the server's origin as `api=`
 * and its auth token as `token=` (see packages/desktop/src-tauri/src/window.rs).
 * The page keeps them in `sessionStorage` so a reload or an in-app
 * navigation, which the address does not need to carry, still finds them.
 * A page the server served has neither: its API is its own origin and its
 * bootstrap script set the token global.
 */
const API_KEY = "lumisca.desktop.api";
const TOKEN_KEY = "lumisca.desktop.token";

function readStored(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    // Storage can be disabled; the query parameter still works for this load.
    return undefined;
  }
}

function store(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // See readStored.
  }
}

function remove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // See readStored.
  }
}

/** Drop the token from the address bar without touching anything else. */
function cleanAddress(params: URLSearchParams): void {
  params.delete("api");
  params.delete("token");
  const query = params.toString();
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${query === "" ? "" : `?${query}`}${location.hash}`,
  );
}

/** Adopt the launch parameters before the app renders, and drop them from
 * the address bar: the token must not linger in history.
 *
 * A page the server served carries only `?token=`, and its bootstrap script
 * has already set the token global; the query is still cleaned here so it
 * does not stay in the address bar or in a screenshot. */
export function adoptDesktopLaunch(): void {
  if (typeof location === "undefined") return;
  const params = new URLSearchParams(location.search);
  if (!params.has("api")) {
    // A reload of the bundled UI (or an in-app navigation), where the query
    // is gone: the launch parameters are still in sessionStorage.
    const storedApi = readStored(API_KEY);
    if (storedApi !== undefined && storedApi !== "") {
      globalThis.__LUMISCA_API__ = storedApi;
      const storedToken = readStored(TOKEN_KEY);
      if (storedToken !== undefined && storedToken !== "") {
        globalThis.__LUMISCA_TOKEN__ = storedToken;
      }
    }
    if (params.has("token")) cleanAddress(params);
    return;
  }
  const api = params.get("api");
  if (api !== null && api !== "") {
    globalThis.__LUMISCA_API__ = api;
    store(API_KEY, api);
    // The token belongs to the server in the same launch URL. A server
    // without one must not inherit the token of the server shown before:
    // that credential is not this server's.
    const token = params.get("token");
    if (token !== null && token !== "") {
      globalThis.__LUMISCA_TOKEN__ = token;
      store(TOKEN_KEY, token);
    } else {
      delete globalThis.__LUMISCA_TOKEN__;
      remove(TOKEN_KEY);
    }
  }
  cleanAddress(params);
}

/** Paint the document from the server's initial data before the first
 * render: the language decides font fallback and hyphenation, and the theme
 * decides the colour behind the app. */
export function applyInitialData(data: InitialData): void {
  document.documentElement.lang = data.language;
  const prefersLight =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: light)").matches;
  const resolved =
    data.theme === "system" ? (prefersLight ? "light" : "dark") : data.theme;
  document.documentElement.dataset.theme =
    resolved === "light" ? "light" : "dark";
}

/** The initial data for this client: the page's own bootstrap script when
 * the server served it, else the API the desktop shell named. */
export async function loadInitialData(): Promise<InitialData | undefined> {
  const embedded = globalThis.__INITIAL_DATA__;
  if (embedded !== undefined) return embedded;
  if (globalThis.__LUMISCA_API__ === undefined) return undefined;
  return await request<InitialData>("/api/initial-data");
}
