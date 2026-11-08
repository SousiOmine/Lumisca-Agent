import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { UpdateSource } from "../../hooks/useUpdateStatus.ts";
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
  update: UpdateStatus,
  source: UpdateSource = "server",
): string {
  return renderToString(
    createElement(GeneralPanel, {
      status: update,
      source,
      bridgeError: null,
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
        state: "unsupported",
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
