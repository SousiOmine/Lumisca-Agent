import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { RecentSessionItem } from "../hooks/useRecentSessions.ts";
import { initLocale } from "../i18n.ts";
import type { SessionInfo } from "../types.ts";
import { RecentSessionsList } from "./RecentSessionsList.tsx";

/**
 * The list refreshes itself while it is on screen (see useRecentSessions), so
 * a failed refresh is the ordinary case: the rows stay usable and the failure
 * is stated above them. What the reader must never see is a failure that
 * replaces the list with an error line, or the empty state over a server that
 * did not answer — both read as "there is nothing here".
 */

const NOW = Date.now();

function row(
  id: string,
  options: { name?: string; peerId?: string; peerName?: string } = {},
): RecentSessionItem {
  return {
    key: options.peerId === undefined ? id : `${options.peerId}:${id}`,
    info: {
      id,
      workspaceId: "ws",
      name: options.name ?? id,
      modelProvider: "faux",
      modelId: "small",
      createdAt: NOW,
      updatedAt: NOW,
    } satisfies SessionInfo,
    peerId: options.peerId ?? "",
    peerName: options.peerName ?? "",
  };
}

function render(
  props: Partial<Parameters<typeof RecentSessionsList>[0]> = {},
): string {
  initLocale("ja");
  return renderToString(
    createElement(RecentSessionsList, {
      items: [],
      loading: false,
      openKeys: new Set<string>(),
      onSelect: () => {},
      ...props,
    }),
  );
}

Deno.test("RecentSessionsList: a failed refresh keeps the rows", () => {
  const html = render({
    items: [row("s1", { name: "ログイン画面の修正" })],
    error: "サーバーに接続できません",
    onReload: () => {},
  });
  // The failure is stated, with the way to ask again...
  assertStringIncludes(html, "recent-error");
  assertStringIncludes(html, "サーバーに接続できません");
  assertStringIncludes(html, "更新");
  // ...and the row the reader was about to click is still there.
  assertStringIncludes(html, "ログイン画面の修正");
  assertStringIncludes(html, "recent-item");
});

Deno.test("RecentSessionsList: a failure with no rows is not the empty state", () => {
  const html = render({ error: "サーバーに接続できません" });
  assertStringIncludes(html, "recent-error");
  assertEquals(
    html.includes("履歴はありません"),
    false,
    "no claim about the server",
  );
});

Deno.test("RecentSessionsList: the empty state waits for the first read", () => {
  // Before the first answer lands, "履歴はありません" would be a guess.
  assertStringIncludes(render({ loading: true }), "読み込み中…");
  assertStringIncludes(render({ loading: false }), "履歴はありません");
});

Deno.test("RecentSessionsList: no error line once a read succeeded", () => {
  const html = render({ items: [row("s1")] });
  assertEquals(html.includes("recent-error"), false);
});

Deno.test("RecentSessionsList: rows of open tabs are omitted, the cap applies", () => {
  const html = render({
    items: [
      row("s1", { name: "one" }),
      row("s2", { name: "two" }),
      row("s3", { name: "three" }),
    ],
    openKeys: new Set(["s2"]),
    limit: 1,
  });
  assertStringIncludes(html, "one");
  assertEquals(html.includes("two"), false, "an open tab's row is not listed");
  assertEquals(html.includes("three"), false, "the cap is the visible rows");
});

Deno.test("RecentSessionsList: a peer's session names the peer", () => {
  const html = render({
    items: [row("s1", { name: "remote", peerId: "p1", peerName: "buildbox" })],
  });
  assertStringIncludes(html, "buildbox");
});
