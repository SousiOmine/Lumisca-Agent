import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { THEME_KEY } from "@lumisca/core/shared";

/** Theme state: applied to <html data-theme> and persisted to the server
 * settings on toggle. */
export function useTheme(initial: "light" | "dark" = "dark") {
  const [theme, setTheme] = useState<"light" | "dark">(initial);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      api.setSetting(THEME_KEY, next).catch(console.error);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
