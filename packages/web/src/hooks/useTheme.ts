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
  }, []);
  const { value, set, error } = usePreference<ThemeSetting>({
    key: THEME_KEY,
    initial,
    apply,
  });

  // "system" follows the OS while it is selected: the preference only says
  // which scheme to use, the media query is what changes it.
  useLayoutEffect(() => {
    apply(value);
    if (value !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [value, apply]);

  return { theme: value, setTheme: set, error };
}
