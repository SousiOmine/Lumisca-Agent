import { hydrateRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { InitialData } from "./types.ts";

declare global {
  /** Initial data injected by the SSR server (window.__INITIAL_DATA__). */
  var __INITIAL_DATA__: InitialData | undefined;
}

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

hydrateRoot(root, <App initialData={globalThis.__INITIAL_DATA__} />);
