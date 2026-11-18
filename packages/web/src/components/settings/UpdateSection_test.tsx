import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type {
  UpdateFailureKind,
  UpdateSource,
} from "../../hooks/useUpdateStatus.ts";
import type { UpdateStatus } from "../../shell.ts";
import { UpdateSection } from "./UpdateSection.tsx";

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    autoUpdate: false,
    checking: false,
    available: true,
    latestVersion: "0.11.0",
    downloading: false,
    progress: null,
    downloaded: null,
    total: null,
    installing: false,
    ready: true,
    error: null,
    currentVersion: "0.10.18",
    supported: true,
    unsupportedReason: null,
    restartPending: false,
    appliedVersion: null,
    restartMode: "self",
    autoRestart: false,
    ...overrides,
  };
}

function section(
  update: UpdateStatus | null,
  source: UpdateSource | null = "server",
  failure: UpdateFailureKind | null = null,
): string {
  return renderToString(
    createElement(UpdateSection, {
      status: update,
      source,
      bridgeError: null,
      failure,
      onSetAuto: () => {},
      onSetAutoRestart: () => {},
      onCheck: () => {},
      onDownload: () => {},
      onInstall: () => {},
      onRestart: () => {},
    }),
  );
}

test("the install button turns into the work it started", () => {
  // Pressing install replaces files for seconds with nothing else moving in
  // the status; the section must say so instead of looking frozen.
  const html = section(status({ installing: true }));
  assertStringIncludes(html, "インストール中…");
  assertEquals(html.includes(">インストール<"), false);
  // Nothing to press while the files are being replaced, and the check is
  // out too (one update request at a time).
  assertEquals(html.includes("btn push"), false);
  assertStringIncludes(html, "disabled");
  assertStringIncludes(html, "アップデートを確認</button>");
  // The note says what installing will do next; that is behind, not now.
  assertEquals(html.includes("次回の起動で新しいバージョンが有効"), false);
});

test("a downloaded package shows the install and its note", () => {
  const html = section(status());
  assertStringIncludes(html, ">インストール<");
  assertStringIncludes(html, "次回の起動で新しいバージョンが有効");
});

test("an applied update shows the restart", () => {
  const html = section(
    status({ ready: false, restartPending: true, appliedVersion: "0.11.0" }),
  );
  assertStringIncludes(html, ">再起動<");
  assertEquals(html.includes("インストール中…"), false);
});

test("the desktop app's updater has no restart of its own", () => {
  // A restart only exists when the server replaces its own files: the
  // desktop shell restarts when its installer runs, so the same status read
  // through the shell must not offer one.
  const html = section(
    status({ ready: false, restartPending: true, appliedVersion: "0.11.0" }),
    "shell",
  );
  assertEquals(html.includes(">再起動<"), false);
});

test("no updater says which reason it is", () => {
  // One sentence ("auto-update is not available in this environment") used
  // to answer a 404, a 401 and an unreachable server alike, and sent the
  // reader to the desktop app for a server that simply had no updater.
  assertStringIncludes(
    section(null, null, "no-updater"),
    "このサーバーには更新機能がありません",
  );
  assertStringIncludes(
    section(null, null, "unauthorized"),
    "認証が切れています",
  );
  assertStringIncludes(section(null, null, "unreachable"), "接続できない");
});

test("before the first answer the section says it is asking", () => {
  // The poll starts on mount; claiming "no updater" in that first moment is
  // what made an installed app look unsupported on every visit.
  assertStringIncludes(section(null, null, null), "アップデートを確認中");
});

test("the check for updates sits beside the version it is about", () => {
  // The status row says what the last check found; the question "is there
  // anything new?" belongs to the number it answers about, so the button is
  // in the version row and not among the actions at the bottom.
  const html = section(status({ available: false, ready: false }));
  const version = html.indexOf("v0.10.18");
  const check = html.indexOf(">アップデートを確認<");
  const statusText = html.indexOf("最新バージョンです。");
  assertEquals(version >= 0 && check > version && statusText > check, true);
  // The answer is read under that number too, above the settings that only
  // decide how the update is applied.
  assertEquals(statusText < html.indexOf("自動アップデート"), true);
});

test("an available update is shown under the current version", () => {
  const html = section(status({ ready: false, latestVersion: "0.12.0" }));
  const statusText = html.indexOf("v0.12.0が利用可能です。");
  assertEquals(statusText > html.indexOf("v0.10.18"), true);
  assertEquals(statusText < html.indexOf("自動アップデート"), true);
  // Its action travels with it, so the button is never apart from the line.
  assertEquals(html.indexOf(">ダウンロード<") > statusText, true);
});
