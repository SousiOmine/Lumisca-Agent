import { hydrateRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { InitialData } from "./types.ts";

declare global {
  interface Window {
    __INITIAL_DATA__?: InitialData;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

hydrateRoot(root, <App initialData={globalThis.__INITIAL_DATA__} />);
