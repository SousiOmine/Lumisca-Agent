import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import {
  emptyStellaState,
  type StellaConversationState,
} from "../stella-state.ts";
import type { StellaAgent, StellaStatus } from "../types.ts";
import { StellaView } from "./StellaView.tsx";

/** One agent, so the header (and the screen toggle it holds) is drawn. The
 * other props are the App's job, not the subject. */
const agent: StellaAgent = {
  id: "a1",
  name: "Aide",
  role: "",
  identity: "",
  icon: "",
  createdAt: 0,
  updatedAt: 0,
};

function status(overrides: Partial<StellaStatus> = {}): StellaStatus {
  return {
    availability: { available: true },
    state: "running",
    vncPort: 6080,
    reason: "",
    starting: false,
    ...overrides,
  };
}

function render(
  overrides: {
    status?: StellaStatus;
    conversation?: Partial<StellaConversationState>;
  } = {},
): string {
  initLocale("ja");
  return renderToString(
    createElement(StellaView, {
      agent,
      onAgentChanged: () => {},
      conversation: {
        ...emptyStellaState("Aide"),
        ...overrides.conversation,
      },
      sessionId: "s1",
      conversationError: null,
      status: overrides.status ?? status(),
      input: "",
      onInputChange: () => {},
      onPrompt: () => {},
      onAbort: () => {},
      onRewind: () => Promise.resolve(),
      onLoadOlder: () => false,
      loadingOlder: false,
      onFinishHandover: () => Promise.resolve(),
      onOpenSettings: () => {},
    }),
  );
}

/** The toggle's opening tag, or "" when it is not drawn. The attributes come
 * out in render order (not source order), so the tag is located by the class
 * it carries. */
function toggleTag(html: string): string {
  const at = html.indexOf("stella-screen-toggle");
  if (at < 0) return "";
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

Deno.test("StellaView: the screen pane starts closed", () => {
  const html = render();
  // Nothing of the pane is drawn before the user asks for it: no column, and
  // with it no VNC connection (StellaPane connects on mount).
  assertEquals(html.includes("stella-pane"), false);
  const tag = toggleTag(html);
  assert(tag !== "", "the toggle is missing while the machine runs");
  // Closed reads as "not pressed" *and* as the crossed-out monitor; the
  // label says what the next click does.
  assertStringIncludes(tag, 'aria-pressed="false"');
  assertStringIncludes(tag, 'title="画面を表示"');
  assert(!tag.includes(" on "), `closed must not carry .on: ${tag}`);
  assertStringIncludes(
    html,
    'class="tabler-icon tabler-icon-device-desktop-off"',
  );
});

Deno.test("StellaView: a hand-over opens the pane and hides the toggle", () => {
  const html = render({
    conversation: {
      handover: {
        toolCallId: "t1",
        reason: "ログインが必要です",
        instructions: "パスワードを入力してください",
      },
    },
  });
  // The run is blocked on this pane, so it is drawn regardless of the user's
  // choice, and there is nothing to close it into.
  assertStringIncludes(html, "stella-pane");
  assertEquals(toggleTag(html), "");
});

Deno.test("StellaView: no toggle while the machine cannot show a screen", () => {
  const html = render({ status: status({ state: "stopped", vncPort: null }) });
  assertEquals(html.includes("stella-pane"), false);
  assertEquals(toggleTag(html), "");
});
