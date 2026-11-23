/**
 * The `<head>` both page shells share.
 *
 * The dev server's `index.html` and the served page (`server/render.ts`) are
 * two documents for one app. Every tag below was written twice, and the file
 * that held the first copy asked the reader to keep them identical; a meta
 * tag added to one and not the other is a difference nobody looks for until
 * a phone misbehaves in production only.
 *
 * The function returns the tags from `charset` through the icon links. The
 * caller adds what is its own: the production page inlines the stylesheet
 * and the scripts, the dev page leaves them to the bundle.
 */

/** The viewport is the same everywhere: `interactive-widget` keeps the
 * layout viewport unchanged on Android when the keyboard opens (the app
 * height then shrinks by itself); iOS is handled by `useAppHeight`. */
const VIEWPORT =
  "width=device-width, initial-scale=1.0, viewport-fit=cover, " +
  "interactive-widget=resizes-content";

export interface ShellHeadOptions {
  /** The page's own canvas colour: the browser paints its chrome with it,
   * and `useTheme` keeps it in step. */
  themeColor: string;
  /** The document's CSP. The dev page has none: the reload loop needs inline scripts
   * for HMR, and the dev server is not this app's server. */
  csp?: string;
}

export function shellHeadTags(options: ShellHeadOptions): string {
  const lines = [
    `    <meta charset="UTF-8" />`,
    `    <meta name="viewport" content="${VIEWPORT}" />`,
  ];
  if (options.csp !== undefined) {
    lines.push(
      `    <meta http-equiv="Content-Security-Policy" content="${options.csp}" />`,
    );
  }
  lines.push(
    `    <title>Lumisca Agent</title>`,
    `    <!-- The page's canvas colour: the browser paints its chrome (the`,
    `         address bar, an installed app's system bars) with it. -->`,
    `    <meta name="theme-color" content="${options.themeColor}" />`,
    `    <!-- Installable as a PWA. The manifest is generated per request, so`,
    `         its theme colour and language are this document's own. iOS reads`,
    `         the touch icon from this link. -->`,
    `    <link rel="manifest" href="/manifest.webmanifest" />`,
    `    <link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png" />`,
    `    <link rel="icon" href="/favicon.png" />`,
  );
  return lines.join("\n");
}
