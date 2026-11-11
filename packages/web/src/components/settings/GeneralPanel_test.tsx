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

Deno.test("the install button turns into the work it started", () => {
  // Pressing install replaces files for seconds with nothing else moving in
  // the status; the panel must say so instead of looking frozen.
  const html = panel(status({ installing: true }));
  assertStringIncludes(html, "インストール中…");
  assertStringIncludes(html, "disabled");
  assertEquals(html.includes(">インストール<"), false);
  // The note says what installing will do next; that is behind, not now.
  assertEquals(html.includes("次回の起動で新しいバージョンが有効"), false);
});

Deno.test("a downloaded package shows the install and its note", () => {
  const html = panel(status());
  assertStringIncludes(html, ">インストール<");
  assertStringIncludes(html, "次回の起動で新しいバージョンが有効");
});

Deno.test("an applied update shows the restart", () => {
  const html = panel(
    status({ ready: false, restartPending: true, appliedVersion: "0.11.0" }),
  );
  assertStringIncludes(html, ">再起動<");
  assertEquals(html.includes("インストール中…"), false);
});

Deno.test("no updater says which reason it is", () => {
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

Deno.test("before the first answer the panel says it is asking", () => {
  // The poll starts on mount; claiming "no updater" in that first moment is
  // what made an installed app look unsupported on every visit.
  assertStringIncludes(panel(null, null, null), "アップデートを確認中");
});

Deno.test("the PWA notification row is drawn only where the channel exists", () => {
  // "This browser cannot use PWA notifications" is a switch the reader cannot
  // use and an explanation they did not ask for; the row is left out instead.
  assertEquals(panel(status()).includes("PWA 通知"), false);
  assertStringIncludes(panel(status(), "server", null, "on"), "PWA 通知");
});
