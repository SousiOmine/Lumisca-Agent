import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { ConnectionSwitch } from "../../hooks/useConnectionSwitch.ts";
import type { ShellState } from "../../shell.ts";
import { ServerCard } from "./ServerCard.tsx";

function connection(
  overrides: Partial<ConnectionSwitch> = {},
): ConnectionSwitch {
  return {
    desktop: false,
    state: null,
    entries: [],
    busy: null,
    error: null,
    currentId: null,
    currentLabel: () => "127.0.0.1:8123",
    connect: async () => true,
    ...overrides,
  };
}

function card(overrides: Partial<ConnectionSwitch> = {}): string {
  return renderToString(
    createElement(ServerCard, {
      connection: connection(overrides),
      onManage: () => {},
    }),
  );
}

test("a browser's card names the server and says it cannot switch", () => {
  // The address bar is the switch in a browser; a control here would do
  // nothing, and the reader still has to know whose settings these are.
  const html = card();
  assertStringIncludes(html, "127.0.0.1:8123");
  assertStringIncludes(html, "このページの配信元");
  assertStringIncludes(html, "表示中");
  assertEquals(html.includes("切り替え"), false);
  assertEquals(html.includes("接続先を管理"), false);
});

test("the shell's card names the server and offers the switch", () => {
  const state: ShellState = {
    mode: "remote",
    url: "http://192.168.1.5:7777/?token=secret",
    name: "Lumisca",
    maximized: false,
  };
  const html = card({
    desktop: true,
    state,
    currentLabel: () => "Lumisca",
    entries: [
      {
        id: "work",
        name: "Work",
        url: "http://10.0.0.2:8000",
        token: "t",
      },
    ],
  });
  assertStringIncludes(html, "Lumisca");
  // The host, not the page URL: the query carries the auth token.
  assertStringIncludes(html, "192.168.1.5:7777");
  assertEquals(html.includes("secret"), false);
  assertStringIncludes(html, "切り替え");
  assertStringIncludes(html, "接続先を管理");
});

test("a local window shows the loopback address, not its name twice", () => {
  const state: ShellState = {
    mode: "local",
    url: "http://127.0.0.1:8000/?token=secret",
    name: null,
    maximized: false,
  };
  const html = card({
    desktop: true,
    state,
    currentLabel: () => "このPC",
  });
  assertStringIncludes(html, "このPC");
  assertStringIncludes(html, "127.0.0.1:8000");
  // A remote without a recorded name would otherwise draw the same host as
  // its name and as its address.
  const unnamed = card({
    desktop: true,
    state: {
      mode: "remote",
      url: "http://10.0.0.2:8000/?token=secret",
      name: null,
      maximized: false,
    },
    currentLabel: () => "10.0.0.2:8000",
  });
  assertEquals(unnamed.includes('class="settings-server-card-address"'), false);
});
