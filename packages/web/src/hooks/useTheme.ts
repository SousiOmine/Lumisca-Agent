import { useCallback, useLayoutEffect } from "preact/compat";
import { THEME_KEY } from "@lumisca/core/shared";
import { usePreference } from "./usePreference.ts";
import type { ThemeSetting } from "../types.ts";

/** Resolve a theme setting to the color scheme applied to <html data-theme>.
 * "system" follows the OS color scheme via prefers-color-scheme. */
export function resolveTheme(setting: ThemeSetting): "light" | "dark" {
  if (setting !== "system") return setting;
  if (typeof matchMedia !== "function") return "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Paint the browser's own chrome with the app's canvas.
 *
 * `theme-color` is what a browser colours its address bar with and what an
 * installed app paints its status bar with. The server writes the theme this
 * document starts in (render.ts); this keeps that value in step when the
 * reader switches theme. The colour is read back from the stylesheet rather
 * than repeated in code: `--bg` in tokens.css is the one source of it, and
 * the resolved value is whatever the current `data-theme` block declares. */
function applyThemeColor(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta === null) return;
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  // No token resolved: the stylesheet is missing, and the value the server
  // wrote is better than an empty attribute.
  if (color === "") return;
  meta.setAttribute("content", color);
}

/** Theme state: the chosen setting (light/dark/system) is persisted to the
 * server settings; the resolved scheme is applied to <html data-theme> and
 * follows OS changes while "system" is selected.
 *
 * A failed persist reverts the choice and reports the error (see
 * usePreference): the applied scheme is what the server stored, so a silent
 * failure would make the setting vanish on the next reload. */
export function useTheme(initial: ThemeSetting = "dark"): {
  theme: ThemeSetting;
  setTheme: (next: ThemeSetting) => void;
  error: string | null;
} {
  const apply = useCallback((next: ThemeSetting) => {
    document.documentElement.dataset.theme = resolveTheme(next);
    applyThemeColor();
  }, []);
  const { value, set, error } = usePreference<ThemeSetting>({
    key: THEME_KEY,
    initial,
    apply,
  });

  // "system" follows the OS while it is selected: the preference only says
  // which scheme to use, the media query is what changes it. `apply` resolves
  // "system" through the query again, so the OS switch travels the same path
  // as a manual choice (data-theme and theme-color together).
  useLayoutEffect(() => {
    apply(value);
    if (value !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply(value);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [value, apply]);

  return { theme: value, setTheme: set, error };
}
