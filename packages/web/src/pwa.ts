/**
 * Service-worker registration.
 *
 * The worker exists so Chromium offers the install prompt
 * (`beforeinstallprompt`, and with it a WebAPK): that prompt is the only
 * place the browser offers the app as an app rather than as a shortcut. Every
 * other platform installs without a worker, which is why nothing here is
 * required for the app to work — what it adds is the prompt, plus a
 * last-known copy of the static files. `public/sw.js` owns what is cached.
 *
 * Registration is limited to https pages. A PWA can only be installed from a
 * secure origin anyway, and the rule keeps the worker out of the two places
 * where it would be a liability:
 *
 *   - the desktop shell's WebView: it loads this server over
 *     `http://127.0.0.1`, which IS a secure context, so the protocol is what
 *     excludes it. A worker there would outlive the app's own update with a
 *     cached client bundle.
 *   - the Vite dev server (`http://localhost`), where a cached bundle would
 *     outlive the edit that changed it.
 */
import { inDesktopShell } from "./shell.ts";

/** Whether this page should register the worker. Pure, so the rule is
 * testable without a browser. */
export function shouldRegisterServiceWorker(
  protocol: string,
  shell: boolean,
): boolean {
  return protocol === "https:" && !shell;
}

/** Register the worker where it belongs; do nothing elsewhere. A failure is
 * reported, not thrown: the app is complete without the worker (only the
 * install prompt is missing), and an uncaught error here would keep the UI
 * from rendering at all. */
export function registerServiceWorker(): void {
  if (!shouldRegisterServiceWorker(location.protocol, inDesktopShell())) {
    return;
  }
  // A WebView without the API would make `register` throw synchronously.
  if (navigator.serviceWorker === undefined) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
    console.warn("service worker registration failed", error);
  });
}
