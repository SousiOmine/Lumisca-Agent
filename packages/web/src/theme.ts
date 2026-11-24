import { THEME_COLORS } from "@lumisca/core/shared/theme-colors";
import type { ThemeSetting } from "./types.ts";

/** Where this client keeps the chosen theme. Per browser profile and per
 * origin, which is the scope the choice has: the theme describes the window
 * in front of the reader, not the server it shows. The desktop window keeps
 * one value across every server it connects to, because its UI has one
 * origin. */
export const THEME_STORAGE_KEY = "lumisca.theme";

/** The theme a client that has never chosen starts in. Dark is the app's
 * canvas; light is a choice, not the default. */
export const DEFAULT_THEME: ThemeSetting = "dark";

/** Whether a stored string is one of the theme values this version knows.
 * A value from an older version or a hand-edited profile reads as no
 * choice, never as an error screen. */
export function isThemeSetting(value: unknown): value is ThemeSetting {
  return value === "light" || value === "dark" || value === "system";
}

/** localStorage, or undefined where the webview refuses it. Accessing the
 * property itself can throw (a storage-disabled profile), not only reads. */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The theme this client stored, or the default. Never throws. */
export function readStoredTheme(): ThemeSetting {
  try {
    const stored = storage()?.getItem(THEME_STORAGE_KEY);
    return isThemeSetting(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist the chosen theme on this client. Never throws: a storage that
 * refuses writes only costs the choice at the next launch, while the
 * in-memory selection stays in effect for this page. */
export function storeTheme(setting: ThemeSetting): void {
  try {
    storage()?.setItem(THEME_STORAGE_KEY, setting);
  } catch {
    // See the doc comment.
  }
}

/** Resolve a theme setting to the color scheme applied to <html data-theme>.
 * "system" follows the OS color scheme via prefers-color-scheme. */
export function resolveTheme(setting: ThemeSetting): "light" | "dark" {
  if (setting !== "system") return setting;
  if (typeof matchMedia !== "function") return "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Paint the scheme and the browser's own chrome from one resolved value:
 * <html data-theme> decides the app's colours, and the theme-color meta tag
 * decides the address bar and the installed app's status bar. The colours
 * come from THEME_COLORS, the same constants the manifest and styles_test
 * use, so the tag cannot drift from the stylesheet. */
export function applyTheme(setting: ThemeSetting): "light" | "dark" {
  const resolved = resolveTheme(setting);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute("content", THEME_COLORS[resolved]);
  return resolved;
}
