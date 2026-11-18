import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { PushControls } from "../../hooks/usePush.ts";
import type { UpdateSource } from "../../hooks/useUpdateStatus.ts";
import { NotificationsPanel } from "./NotificationsPanel.tsx";

function panel(
  source: UpdateSource | null,
  pushState: PushControls["state"] = "unsupported",
): string {
  return renderToString(
    createElement(NotificationsPanel, {
      source,
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

test("the desktop notification row is drawn only by the shell", () => {
  // The same browser page has no desktop window to notify, so the row would
  // be a switch with no effect.
  assertStringIncludes(panel("shell"), "バックグラウンド通知");
  assertEquals(panel("server").includes("バックグラウンド通知"), false);
  assertEquals(panel(null).includes("バックグラウンド通知"), false);
});

test("the PWA notification row is drawn only where the channel exists", () => {
  // "This browser cannot use PWA notifications" is a switch the reader cannot
  // use and an explanation they did not ask for; the row is left out instead.
  assertEquals(panel("server").includes("PWA通知"), false);
  assertStringIncludes(panel("server", "on"), "PWA通知");
});

test("a browser with no notification channel says so", () => {
  // The page's subject is this device's channels. With neither the shell's
  // window nor the Push API, an empty page would leave the reader wondering
  // whether the dialog was still loading.
  assertStringIncludes(panel("server"), "この端末で使える通知はありません");
  assertEquals(
    panel("server", "on").includes("この端末で使える通知はありません"),
    false,
  );
});
