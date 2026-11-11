/**
 * The Web App Manifest: the document that makes this page installable.
 *
 * It is generated per request rather than kept as a file, because the values
 * it shares with the page come from this server's own state: the canvas
 * colour of the theme the page starts in (`theme_color` paints the splash
 * screen and the installed app's bars) and the app language (`lang`, and the
 * description under the app's name in the install dialog).
 *
 * `start_url` names no token. The manifest is one of the files the token
 * guard lets through (security.ts's `unguardedPath`): its contents are
 * public to anyone who can reach this server, so a capability must never be
 * written into it. An installed app authenticates the way a browser tab
 * does — with the cookie this origin stored when the token was first
 * presented.
 */
import { type Locale, THEME_COLORS, translate } from "@lumisca/core/shared";

/** The icons every build ships under `/pwa/` (packages/web/public/pwa),
 * embedded in `assets.json` and served by pages.ts. `apple-touch-icon.png`
 * is not named by the manifest — iOS reads it from the page's `<link>` —
 * but it is packaged and served the same way, so it lives in the same list. */
export const PWA_ICON_FILES: readonly string[] = [
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];

/** What the manifest says about the icons it names. `sizes` has to match the
 * file: a browser that decodes one at a different size reports the app as
 * not installable.
 *
 * Chromium wants a 192 and a 512; the maskable 512 is the one Android crops
 * to its own shape (a circle on most launchers), which is why its artwork is
 * inset to the maskable safe zone instead of touching the edges. */
const MANIFEST_ICONS = [
  { file: "icon-192.png", sizes: "192x192", purpose: "any" },
  { file: "icon-512.png", sizes: "512x512", purpose: "any" },
  { file: "icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
];

export interface ManifestOptions {
  /** The theme the page paints its first frame in (the same value the shell
   * writes to `<html data-theme>` and to its `theme-color`). */
  theme: "light" | "dark";
  language: Locale;
}

/** The manifest document, as the JSON text its route answers with. */
export function renderManifest({ theme, language }: ManifestOptions): string {
  const color = THEME_COLORS[theme];
  return JSON.stringify({
    // A stable identity: without it the browser derives one from start_url,
    // and moving the app to another path would install it a second time.
    id: "/",
    name: "Lumisca Agent",
    // The label under the home-screen icon; short enough not to truncate.
    short_name: "Lumisca",
    description: translate(language, "common.pwa.description"),
    lang: language,
    dir: "ltr",
    start_url: "/",
    scope: "/",
    // No browser chrome: the app draws its own title bar and tab strip.
    display: "standalone",
    background_color: color,
    theme_color: color,
    icons: MANIFEST_ICONS.map((icon) => ({
      src: `/pwa/${icon.file}`,
      sizes: icon.sizes,
      type: "image/png",
      purpose: icon.purpose,
    })),
    prefer_related_applications: false,
  });
}
