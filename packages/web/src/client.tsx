import { DEFAULT_LOCALE } from "@lumisca/core/shared";
import { Component } from "preact/compat";
import { createRoot } from "preact/compat/client";
import { App } from "./App.tsx";
import { installFileDropGuard } from "./drop-guard.ts";
import { initLocale, t } from "./i18n.ts";
import { registerServiceWorker } from "./pwa.ts";
import type { InitialData } from "./types.ts";

declare global {
  /** Initial data injected by the server bootstrap script
   * (window.__INITIAL_DATA__). */
  var __INITIAL_DATA__: InitialData | undefined;
}

// The auth token arrives as `?token=` on the page URL (the desktop shell
// and browsers open the page that way). Drop it from the address bar so it
// does not linger in history or screenshots; api.ts reads the embedded
// window.__LUMISCA_TOKEN__ instead.
if (location.search.includes("token=")) {
  history.replaceState(null, "", location.pathname);
}

// The app language must be known before the first render: every component
// reads it from the store, and the server already resolved it (the stored
// setting, else the browser's Accept-Language — see server/app.ts).
initLocale(globalThis.__INITIAL_DATA__?.language ?? DEFAULT_LOCALE);

// Register the PWA's service worker where it belongs (https, outside the
// desktop shell). Fire and forget: the registration is asynchronous, adds
// nothing the app waits for, and reports its own failures (see pwa.ts).
registerServiceWorker();

// A file dropped outside the composer must not replace the app with the file
// (see drop-guard.ts). Installed once, before the first render, so a drop
// during startup is already covered.
installFileDropGuard(document);

/**
 * The last net under the app: a throw in a component's render unmounts the
 * whole tree, and without this the window goes white with nothing to click —
 * no title bar, no way back, and no hint that reloading helps. One boundary at
 * the root rather than per view: the failure is a bug in the render code, so
 * there is nothing per-surface to say about it, and rendering nothing at all
 * (the alternative) is the white screen this exists to prevent.
 *
 * The message is deliberately not shown: an exception's text describes the
 * component's internals, and the reader can do nothing with it. Reloading is
 * the only action that helps, so it is the only one offered.
 */
class AppErrorBoundary extends Component<
  { children: unknown },
  { failed: boolean }
> {
  override state = { failed: false };

  static override getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // Still reported: the boundary replaces the screen, not the diagnosis.
    console.error(error);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    // The classes are the empty state's: a screen with nothing to show, and
    // the one line it says — no new stylesheet rule for a state the app is
    // never supposed to be in.
    return (
      <div className="chat-empty" role="alert">
        <div className="chat-empty-inner">
          <p className="error-text">{t("common.crash.title")}</p>
          <p>{t("common.crash.hint")}</p>
          <button
            type="button"
            className="btn"
            onClick={() => location.reload()}
          >
            {t("common.crash.reload")}
          </button>
        </div>
      </div>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// The app is rendered client-side; the server only serves a static shell.
createRoot(root).render(
  <AppErrorBoundary>
    <App initialData={globalThis.__INITIAL_DATA__} />
  </AppErrorBoundary>,
);
