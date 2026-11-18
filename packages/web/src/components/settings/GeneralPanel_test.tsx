import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { PushControls } from "../../hooks/usePush.ts";
import type {
  UpdateFailureKind,
  UpdateSource,
} from "../../hooks/useUpdateStatus.ts";
import type { UpdateStatus } from "../../shell.ts";
import { GeneralPanel } from "./GeneralPanel.tsx";

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

function panel(
  update: UpdateStatus | null,
  source: UpdateSource | null = "server",
  failure: UpdateFailureKind | null = null,
  pushState: PushControls["state"] = "unsupported",
): string {
  return renderToString(
    createElement(GeneralPanel, {
      status: update,
      source,
      bridgeError: null,
      failure,
      language: "ja",
      languageError: null,
      onLanguageChange: () => {},
      onSetAuto: () => {},
      onSetAutoRestart: () => {},
      onCheck: () => {},
      onDownload: () => {},
      onInstall: () => {},
      onRestart: () => {},
      notifyEnabled: false,
      onNotifyEnabledChange: () => {},
      push: {
        state: pushState,
        error: null,
        tested: false,
        toggle: () => {},
        sendTest: () => {},
      },
    }),
  );
}

test("the install button turns into the work it started", () => {
  // Pressing install replaces files for seconds with nothing else moving in
  // the status; the panel must say so instead of looking frozen.
  const html = panel(status({ installing: true }));
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
  const html = panel(status());
  assertStringIncludes(html, ">インストール<");
  assertStringIncludes(html, "次回の起動で新しいバージョンが有効");
});

test("an applied update shows the restart", () => {
  const html = panel(
    status({ ready: false, restartPending: true, appliedVersion: "0.11.0" }),
  );
  assertStringIncludes(html, ">再起動<");
  assertEquals(html.includes("インストール中…"), false);
});

test("no updater says which reason it is", () => {
  // One sentence ("auto-update is not available in this environment") used
  // to answer a 404, a 401 and an unreachable server alike, and sent the
  // reader to the desktop app for a server that simply had no updater.
  assertStringIncludes(
    panel(null, null, "no-updater"),
    "このサーバーには更新機能がありません",
  );
  assertStringIncludes(panel(null, null, "unauthorized"), "認証が切れています");
  assertStringIncludes(panel(null, null, "unreachable"), "接続できない");
});

test("before the first answer the panel says it is asking", () => {
  // The poll starts on mount; claiming "no updater" in that first moment is
  // what made an installed app look unsupported on every visit.
  assertStringIncludes(panel(null, null, null), "アップデートを確認中");
});

test("the PWA notification row is drawn only where the channel exists", () => {
  // "This browser cannot use PWA notifications" is a switch the reader cannot
  // use and an explanation they did not ask for; the row is left out instead.
  assertEquals(panel(status()).includes("PWA通知"), false);
  assertStringIncludes(panel(status(), "server", null, "on"), "PWA通知");
});

test("the check for updates sits beside the version it is about", () => {
  // The status row says what the last check found; the question "is there
  // anything new?" belongs to the number it answers about, so the button is
  // in the version row and not among the actions at the bottom.
  const html = panel(status({ available: false, ready: false }));
  const version = html.indexOf("v0.10.18");
  const check = html.indexOf(">アップデートを確認<");
  const statusText = html.indexOf("最新バージョンです。");
  assertEquals(version >= 0 && check > version && statusText > check, true);
  // The answer is read under that number too, above the settings that only
  // decide how the update is applied.
  assertEquals(statusText < html.indexOf("自動アップデート"), true);
});

test("an available update is shown under the current version", () => {
  const html = panel(status({ ready: false, latestVersion: "0.12.0" }));
  const statusText = html.indexOf("v0.12.0が利用可能です。");
  assertEquals(statusText > html.indexOf("v0.10.18"), true);
  assertEquals(statusText < html.indexOf("自動アップデート"), true);
  // Its action travels with it, so the button is never apart from the line.
  assertEquals(html.indexOf(">ダウンロード<") > statusText, true);
});

test("the notification row follows the language", () => {
  // Notifications are an app preference like the language, not part of the
  // update controls they used to be listed under.
  const html = panel(status(), "shell");
  const language = html.indexOf(">言語<");
  const notify = html.indexOf("バックグラウンド通知");
  const appInfo = html.indexOf("アプリ情報");
  assertEquals(language >= 0 && notify > language && appInfo > notify, true);
});

test("the notification row is drawn without an updater too", () => {
  // The toggle is not about updating, so a server with no updater (or a
  // shell bridge that did not answer) must not hide it.
  assertStringIncludes(
    panel(null, "shell", "no-updater"),
    "バックグラウンド通知",
  );
});
