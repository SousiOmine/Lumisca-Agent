import { useCallback, useLayoutEffect, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorMessage as errorText, THEME_KEY } from "@lumisca/core/shared";
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
 * A failed persist reverts the choice and reports the error: the applied
 * scheme is what the server stored, so a silent failure would make the
 * setting vanish on the next reload. */
export function useTheme(initial: ThemeSetting = "dark"): {
  theme: ThemeSetting;
  setTheme: (next: ThemeSetting) => void;
  error: string | null;
} {
  const [setting, setSetting] = useState<ThemeSetting>(initial);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(setting);
    if (setting !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [setting]);

  const setTheme = useCallback((next: ThemeSetting) => {
    if (setting === next) return;
    setError(null);
    // Optimistic: the scheme applies immediately; a failed persist rolls
    // back to the value the server still holds.
    setSetting(next);
    api.setSetting(THEME_KEY, next).catch((failure) => {
      setError(errorText(failure));
      setSetting(setting);
    });
  }, [setting]);

  return { theme: setting, setTheme, error };
}
