import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
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

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// The app is rendered client-side; the server only serves a static shell.
createRoot(root).render(<App initialData={globalThis.__INITIAL_DATA__} />);
