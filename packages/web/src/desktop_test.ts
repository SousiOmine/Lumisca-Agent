import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { apiBase, apiUrl, withToken, wsUrl } from "./api-client.ts";
import { adoptDesktopLaunch } from "./desktop.ts";

/** Clean the globals the API module reads at use time. */
function reset(): void {
  delete globalThis.__LUMISCA_API__;
  delete globalThis.__LUMISCA_TOKEN__;
}

/** One test at a time: the globals are process-wide. */
function withGlobals(
  api: string | undefined,
  token: string | undefined,
  run: () => void,
): void {
  reset();
  globalThis.__LUMISCA_API__ = api;
  globalThis.__LUMISCA_TOKEN__ = token;
  try {
    run();
  } finally {
    reset();
  }
}

test("a page the server served keeps its API paths relative", () => {
  withGlobals(undefined, "tok", () => {
    assertEquals(apiBase(), "");
    assertEquals(apiUrl("/api/health"), "/api/health");
    // The page's own markup compares against the relative base (see
    // MarkdownBlock), so the token is appended without an origin.
    assertEquals(
      withToken("/api/sessions/s/visual/a.png"),
      "/api/sessions/s/visual/a.png?token=tok",
    );
  });
});

test("the bundled UI addresses the selected server absolutely", () => {
  withGlobals("http://127.0.0.1:8000/", "tok", () => {
    assertEquals(apiBase(), "http://127.0.0.1:8000");
    assertEquals(apiUrl("/api/health"), "http://127.0.0.1:8000/api/health");
    assertEquals(
      withToken("/api/sessions/s/visual/a.png"),
      "http://127.0.0.1:8000/api/sessions/s/visual/a.png?token=tok",
    );
  });
});

test("a URL that already carries a token is not given a second one", () => {
  withGlobals("https://host.tailnet.ts.net", "tok", () => {
    assertEquals(
      withToken("https://host.tailnet.ts.net/api/x?token=other"),
      "https://host.tailnet.ts.net/api/x?token=other",
    );
  });
});

test("a WebSocket names the API origin and carries the token", () => {
  withGlobals("https://host.tailnet.ts.net", "tok", () => {
    assertEquals(wsUrl("/ws"), "wss://host.tailnet.ts.net/ws?token=tok");
  });
});

/** A minimal sessionStorage the launch code can write to. */
interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): FakeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** Install the browser globals `adoptDesktopLaunch` reads. The same storage
 * is reused across calls, as a reload of one window would. */
function installLaunch(search: string, storage: FakeStorage): void {
  const location = {
    search,
    pathname: "/index.html",
    hash: "",
    href: `tauri://localhost/index.html${search}`,
    protocol: "tauri:",
    host: "localhost",
  };
  const history = {
    state: null,
    replaceState: (_state: unknown, _title: string, url: string) => {
      location.href = `tauri://localhost${url}`;
    },
  };
  Object.defineProperty(globalThis, "location", {
    value: location,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: history,
    configurable: true,
  });
}

function removeBrowserGlobals(): void {
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "sessionStorage");
  Reflect.deleteProperty(globalThis, "history");
}

test("a new server without a token does not inherit the old token", () => {
  const storage = memoryStorage();
  reset();
  try {
    installLaunch("?api=http://127.0.0.1:8000&token=first", storage);
    adoptDesktopLaunch();
    assertEquals(globalThis.__LUMISCA_TOKEN__, "first");

    // Switching servers: the second launch names the new origin and carries
    // no token. The first server's credential must not travel to it.
    installLaunch("?api=http://127.0.0.1:9000", storage);
    adoptDesktopLaunch();
    assertEquals(apiBase(), "http://127.0.0.1:9000");
    assertEquals(globalThis.__LUMISCA_TOKEN__, undefined);
    assertEquals(storage.getItem("lumisca.desktop.token"), null);
  } finally {
    removeBrowserGlobals();
    reset();
  }
});

test("a reload without the launch query keeps the server and its token", () => {
  const storage = memoryStorage();
  reset();
  try {
    installLaunch("?api=http://127.0.0.1:8000&token=first", storage);
    adoptDesktopLaunch();

    // A reload drops the query but keeps sessionStorage.
    installLaunch("", storage);
    adoptDesktopLaunch();
    assertEquals(apiBase(), "http://127.0.0.1:8000");
    assertEquals(globalThis.__LUMISCA_TOKEN__, "first");
  } finally {
    removeBrowserGlobals();
    reset();
  }
});
