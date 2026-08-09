import { useCallback, useLayoutEffect, useState } from "react";
import { api } from "../api.ts";
import { THEME_KEY } from "@lumisca/core/shared";
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
 * follows OS changes while "system" is selected. */
export function useTheme(initial: ThemeSetting = "dark") {
  const [setting, setSetting] = useState<ThemeSetting>(initial);

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
    setSetting((current) => {
      if (current === next) return current;
      api.setSetting(THEME_KEY, next).catch(console.error);
      return next;
    });
  }, []);

  return { theme: setting, setTheme };
}
