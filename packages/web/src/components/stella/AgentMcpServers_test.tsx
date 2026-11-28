import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import type { AgentMcpView, McpServerInfo } from "../../types.ts";
import { AgentMcpServers, mcpPanelSections } from "./AgentMcpServers.tsx";

function server(
  name: string,
  overrides: Partial<McpServerInfo> = {},
): McpServerInfo {
  return {
    name,
    type: "stdio",
    enabled: true,
    args: [],
    env: {},
    headers: {},
    toolCount: 0,
    status: "ok",
    ...overrides,
  };
}

function view(
  own: McpServerInfo[],
  shared: McpServerInfo[] = [],
): AgentMcpView {
  return {
    agent: {
      filePath: "agent settings a1",
      exists: own.length > 0,
      servers: own,
    },
    global: {
      filePath: "app settings",
      exists: shared.length > 0,
      servers: shared,
    },
    errors: [],
  };
}

test("the panel puts the agent's own list first and hides overridden shared rows", () => {
  // The conversation uses the agent's own server when both lists have the
  // name, so the shared row must not be drawn as if it were the one running.
  const sections = mcpPanelSections(
    view(
      [server("github", { type: "http", url: "https://e/mcp", toolCount: 3 })],
      [
        server("github", { type: "http", url: "https://e/mcp" }),
        server("time"),
      ],
    ),
  );
  assertEquals(
    sections.own.map((s) => s.name),
    ["github"],
  );
  assertEquals(
    sections.shared.map((s) => s.name),
    ["time"],
  );
  assertEquals(sections.overshadowed, 1);
  assertEquals(sections.empty, false);
});

test("a view with nothing configured is empty", () => {
  const sections = mcpPanelSections(view([], []));
  assertEquals(sections.empty, true);
  assertEquals(sections.overshadowed, 0);
});

test("the panel renders the read-only list, with no add or remove control", () => {
  // Renders the state before the read lands: the body is mounted by its
  // disclosure, and nothing in it changes either list.
  initLocale("ja");
  const html = renderToString(
    createElement(AgentMcpServers, { agentId: "a1" }),
  );
  assertEquals(html.includes("追加"), false);
  assertEquals(html.includes("削除"), false);
});
