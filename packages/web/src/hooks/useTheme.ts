import { useCallback, useLayoutEffect, useState } from "preact/hooks";
import { applyTheme, readStoredTheme, storeTheme } from "../theme.ts";
import type { ThemeSetting } from "../types.ts";

/**
 * Theme state for this client. The choice is stored in this browser profile
 * (see theme.ts), not in the server's settings: it describes the window the
 * reader is looking at, and two clients showing one server may want
 * different themes.
 *
 * The stored value is applied before the first paint by theme-boot.ts; this
 * hook keeps it in step while the page is open, including an OS switch while
 * "system" is selected.
 */
export function useTheme(): {
  theme: ThemeSetting;
  setTheme: (next: ThemeSetting) => void;
} {
  const [theme, setThemeState] = useState<ThemeSetting>(readStoredTheme);

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeState(next);
    storeTheme(next);
    applyTheme(next);
  }, []);

  useLayoutEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme };
}
