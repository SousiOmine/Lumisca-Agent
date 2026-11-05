/**
 * The canvas colour of each theme.
 *
 * `--bg` in packages/web/src/styles/tokens.css is the single source of the
 * value; this copy exists because the server cannot read CSS. The Web App
 * Manifest's `theme_color` (and the page's first-paint `theme-color`, written
 * into the same document) are answered before any stylesheet applies, and an
 * installed app paints its splash screen and its system bars from them.
 *
 * `styles_test.ts` fails when the two disagree, so the pair cannot drift.
 */
export const THEME_COLORS = {
  dark: "#0c0c11",
  light: "#f4f5f9",
} as const;
