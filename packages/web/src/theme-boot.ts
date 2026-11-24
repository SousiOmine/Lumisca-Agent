/**
 * Apply this client's stored theme before the stylesheet paints.
 *
 * The document loads this file as a classic script in the head, so it runs
 * before the first frame; doing it from the app bundle would show the
 * default theme for a moment on every load. It is deliberately separate
 * from the app entry and built without splitting, so it carries no imports.
 */
import { applyTheme, readStoredTheme } from "./theme.ts";

applyTheme(readStoredTheme());
