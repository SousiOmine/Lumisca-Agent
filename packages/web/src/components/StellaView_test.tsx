import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import {
  emptyStellaState,
  type StellaConversationState,
} from "../stella-state.ts";
import type { StellaAgentSummary, StellaStatus } from "../types.ts";
import { StellaView } from "./StellaView.tsx";

/** One agent, so the header (and the screen toggle it holds) is drawn. The
 * other props are the App's job, not the subject. */
const agent: StellaAgentSummary = {
  id: "a1",
  name: "Aide",
  icon: "",
  model: null,
  createdAt: 0,
  updatedAt: 0,
  preview: null,
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
    conversation?: Partial<StellaConversationState> | null;
    loading?: boolean;
    /** The reader's choice for the screen pane (see StellaViewProps). */
    screenOpen?: boolean;
  } = {},
): string {
  initLocale("ja");
  return renderToString(
    createElement(StellaView, {
      agent,
      conversation:
        overrides.conversation === null
          ? null
          : { ...emptyStellaState("Aide"), ...overrides.conversation },
      sessionId: "s1",
      conversationError: null,
      status: overrides.status ?? status(),
      screenOpen: overrides.screenOpen ?? false,
      onScreenOpenChange: () => {},
      input: "",
      onInputChange: () => {},
      loading: overrides.loading ?? false,
      images: [],
      onImagesChange: () => {},
      files: [],
      onFilesChange: () => {},
      onPrompt: () => {},
      onAbort: () => {},
      onRewind: () => Promise.resolve(),
      onModelChange: () => Promise.resolve(),
      onThinkingLevelChange: () => {},
      onLoadOlder: () => false,
      loadingOlder: false,
      onFinishHandover: () => Promise.resolve(),
      onProvideEnv: () => Promise.resolve(),
      onDeclineEnv: () => Promise.resolve(),
      onOpenSettings: () => {},
    }),
  );
}

Deno.test("StellaView: the pane opens only when the machine can show it", () => {
  // Nothing of the pane is drawn before the reader asks for it: no column,
  // and with it no VNC connection (StellaPane connects on mount).
  assertEquals(render().includes("stella-pane"), false);
  // The choice is the caller's, so opening it has to be enough to draw it.
  const opened = render({ screenOpen: true });
  assertStringIncludes(opened, "stella-pane");
  // Watching is not driving: the clipboard controls belong to the hand-over
  // (the server refuses a write outside it, and the buttons would be dead).
  assertEquals(opened.includes("stella-handover-clipboard"), false);
  // A machine that is not running has no picture to show, whatever the
  // reader asked for: the toggle is not drawn in that state (see
  // StellaTitleBarHeader), and a pane here would be an empty rectangle.
  assertEquals(
    render({
      screenOpen: true,
      status: status({ state: "stopped", vncPort: null }),
    }).includes("stella-pane"),
    false,
  );
});

Deno.test("StellaView: a hand-over draws the pane whatever the caller chose", () => {
  const html = render({
    conversation: {
      handover: {
        toolCallId: "t1",
        reason: "ログインが必要です",
        instructions: "パスワードを入力してください",
        expiresAt: Date.now() + 15 * 60_000,
      },
    },
  });
  // The run is blocked on this pane, so it is drawn regardless of the user's
  // choice, and there is nothing to close it into.
  assertStringIncludes(html, "stella-pane");
  // The bar says when the wait ends by itself: a user who returns after the
  // deadline finds the run already moving and needs to have been told (#36).
  assertStringIncludes(html, "stella-handover-deadline");
  // The screen is the user's, and so is its clipboard: the two words are
  // drawn with the hand-over.
  assertStringIncludes(html, "stella-handover-clipboard");
});

Deno.test("StellaView: the env request is a card in the conversation", () => {
  // The run is blocked on this request, but it is drawn as a card at the live
  // edge of the transcript rather than as a sheet over the window: reading
  // the conversation, or writing a sentence of one's own, must stay possible
  // while the value is fetched from somewhere else.
  const expiresAt = Date.now() + 15 * 60_000;
  const html = render({
    conversation: {
      envRequest: {
        toolCallId: "t1",
        name: "OPENAI_API_KEY",
        exists: false,
        expiresAt,
      },
    },
  });
  assertStringIncludes(html, "env-request-card");
  assertStringIncludes(html, "stella-column");
  assertStringIncludes(html, "OPENAI_API_KEY");
  // Nothing covers the conversation: no backdrop, no dialog role.
  assertEquals(html.includes("modal-backdrop"), false);
  assertEquals(html.includes('role="dialog"'), false);
  // A password field: the value is not meant to be read off the screen, and
  // the browser must not offer to remember it.
  assertStringIncludes(html, 'type="password"');
  assertStringIncludes(html, 'autocomplete="off"');
  // A first entry says nothing about replacing; an existing one does.
  assertEquals(html.includes("env-request-existing"), false);
  assertStringIncludes(
    render({
      conversation: {
        envRequest: {
          toolCallId: "t1",
          name: "GITHUB_TOKEN",
          exists: true,
          expiresAt,
        },
      },
    }),
    "env-request-existing",
  );
});

Deno.test("StellaView: a failed send leaves the conversation on screen", () => {
  // The hook puts a prompt/abort failure on the conversation, not on the
  // "could not open it" error: replacing the transcript with an error screen
  // because one send failed throws away the history the user retries from.
  const html = render({
    conversation: {
      entries: [
        {
          role: "user",
          text: "README を直して",
          segments: [{ type: "text", text: "README を直して" }],
          attachments: [],
          files: [],
          timestamp: 1,
        },
      ],
      error: "サーバー側でエラーが起きました",
    },
  });
  // The conversation is still drawn, and the failure sits inside it.
  assertStringIncludes(html, "README を直して");
  assertStringIncludes(html, "stella-column");
  assertStringIncludes(html, "サーバー側でエラーが起きました");
  assertEquals(html.includes("会話を開けませんでした"), false);
});

Deno.test("StellaView: opening a conversation shows the wait, not an empty pane", () => {
  // Opening means starting the machine, so the pane has a placeholder while
  // it is in flight. An empty transcript reads as "the tap did nothing".
  const waiting = render({ conversation: null, loading: true });
  assertStringIncludes(waiting, "stella-loading");
  assertStringIncludes(waiting, "読み込んでいます");
  // Once nothing is in flight the same spot carries the empty state's hint.
  const idle = render({ conversation: null, loading: false });
  assertStringIncludes(idle, "依頼を入力してください");
});
