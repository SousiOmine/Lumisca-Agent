import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";
import type { UpdateStatus } from "../shell.ts";
import { UpdateBanner } from "./UpdateBanner.tsx";

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

function controls(overrides: Partial<UpdateControls> = {}): UpdateControls {
  return {
    status: status(),
    source: "server",
    setAuto: () => {},
    check: () => {},
    download: () => {},
    install: () => {},
    restart: () => {},
    setAutoRestart: () => {},
    error: null,
    ...overrides,
  };
}

function banner(overrides: Partial<UpdateControls> = {}): string {
  return renderToString(createElement(UpdateBanner, {
    update: controls(overrides),
  }));
}

Deno.test("a downloaded package offers the install", () => {
  const html = banner();
  assertStringIncludes(html, "今すぐインストール");
  assertStringIncludes(html, "v0.11.0");
});

Deno.test("installing hides the button and says what is happening", () => {
  // The click used to leave the strip untouched until the restart offer
  // appeared: replacing the files takes seconds and moves nothing else in
  // the status.
  const html = banner({ status: status({ installing: true }) });
  assertStringIncludes(html, "インストールしています");
  assertStringIncludes(html, "インストール中…");
  assertStringIncludes(html, "spin");
  assertStringIncludes(html, "disabled");
  assertEquals(html.includes("今すぐインストール"), false);
});

Deno.test("an applied update offers the restart, not the install", () => {
  const html = banner({
    status: status({
      ready: false,
      restartPending: true,
      appliedVersion: "0.11.0",
    }),
  });
  assertStringIncludes(html, "今すぐ再起動");
  assertEquals(html.includes("今すぐインストール"), false);
});

Deno.test("a restart the operator has to do offers no button", () => {
  const html = banner({
    status: status({
      ready: false,
      restartPending: true,
      appliedVersion: "0.11.0",
      restartMode: "none",
    }),
  });
  assertStringIncludes(html, "次回の起動時に適用されます");
  assertEquals(html.includes("今すぐ再起動"), false);
});

Deno.test("nothing to install renders nothing", () => {
  const html = banner({ status: status({ available: false, ready: false }) });
  assertEquals(html, "");
});
