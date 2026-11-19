import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { ConnectionSwitch } from "../../hooks/useConnectionSwitch.ts";
import type { ShellState } from "../../shell.ts";
import { ServerHeading } from "./ServerHeading.tsx";

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

function heading(overrides: Partial<ConnectionSwitch> = {}): string {
  return renderToString(
    createElement(ServerHeading, {
      connection: connection(overrides),
    }),
  );
}

test("a browser's heading names the server", () => {
  // The address bar is the switch in a browser; the heading still says whose
  // settings these are.
  const html = heading();
  assertStringIncludes(html, "127.0.0.1:8123");
  assertStringIncludes(html, "このページの配信元");
  assertEquals(html.includes("表示中"), false);
  assertEquals(html.includes("切り替え"), false);
});

test("the shell's heading shows the address without the query token", () => {
  const state: ShellState = {
    mode: "remote",
    url: "http://192.168.1.5:7777/?token=secret",
    name: "Lumisca",
    maximized: false,
  };
  const html = heading({
    desktop: true,
    state,
    currentLabel: () => "Lumisca",
  });
  assertStringIncludes(html, "Lumisca");
  // The host, not the page URL: the query carries the auth token.
  assertStringIncludes(html, "192.168.1.5:7777");
  assertEquals(html.includes("secret"), false);
  assertEquals(html.includes("切り替え"), false);
});

test("a local window shows the loopback address, not its name twice", () => {
  const state: ShellState = {
    mode: "local",
    url: "http://127.0.0.1:8000/?token=secret",
    name: null,
    maximized: false,
  };
  const html = heading({
    desktop: true,
    state,
    currentLabel: () => "このPC",
  });
  assertStringIncludes(html, "このPC");
  assertStringIncludes(html, "127.0.0.1:8000");
  // A remote without a recorded name would otherwise draw the same host as
  // its name and as its address.
  const unnamed = heading({
    desktop: true,
    state: {
      mode: "remote",
      url: "http://10.0.0.2:8000/?token=secret",
      name: null,
      maximized: false,
    },
    currentLabel: () => "10.0.0.2:8000",
  });
  assertEquals(unnamed.includes('class="settings-server-address"'), false);
});
