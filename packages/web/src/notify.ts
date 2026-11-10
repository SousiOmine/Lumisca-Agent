import { withTimeout } from "@lumisca/core/shared";
import type { Translator } from "@lumisca/core/shared";
import { notifyApi, type WindowState, windowStateApi } from "./shell.ts";
import { t } from "./i18n.ts";
import type { AskQuestion } from "./types.ts";

/** Background agent-event notifications (desktop only).
 *
 * The agent loop lives in the server process; its events reach this page
 * over the WebSocket. When a run ends (`agent_end`), the agent asks a
 * question (the ask tool), or it hands the machine's screen over
 * (`vm_ask_user`) while the main window has no focus — minimized, behind
 * another app, on another virtual desktop — the event would otherwise go
 * unnoticed, so it is forwarded to the desktop shell, which shows it as an
 * OS notification (plus a taskbar flash).
 *
 * Visibility comes from the shell bridge (`window/state`): the DOM
 * `document.hidden` check alone cannot see a virtual-desktop switch,
 * while the native `is_focused()` can. Outside the desktop shell the
 * bridge rejects and everything degrades to the DOM check, with the final
 * `notify` call failing silently — notifications are a desktop-only
 * feature, mirroring auto-update.
 */

const ENABLED_KEY = "lumisca.notify.enabled";

/** How long the visibility query may take before the DOM state is used
 * instead. The bridge answers synchronously from local state, so a
 * timeout means "no shell" (plain browser) rather than slowness. */
const WINDOW_STATE_TIMEOUT_MS = 1500;

const MAX_NAME_CHARS = 60;
const MAX_QUESTION_CHARS = 80;
/** How much of a hand-over reason a toast carries. The agent writes up to
 * 500 characters for the model; the first sentence is what says whether the
 * user has to come now. */
const MAX_HANDOVER_CHARS = 120;
/** How much of the finished run's reply the notification carries. One line of
 * a toast: enough to judge whether opening the app is worth it, short enough
 * to read without expanding it. */
const MAX_DETAIL_CHARS = 120;

/** Whether background notifications are enabled. Defaults to on; the
 * settings UI persists the choice under ENABLED_KEY. Never throws. */
export function isNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Persist the background-notification choice. Never throws. */
export function setNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    // Private mode etc: the in-memory default (on) stays.
  }
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** A session name for a notification: trimmed, capped, and named by the
 * catalogue when the session has no title yet. */
function sessionLabel(name: string, tr: Translator): string {
  const trimmed = name.trim();
  return truncate(
    trimmed === "" ? tr("notify.sessionName") : trimmed,
    MAX_NAME_CHARS,
  );
}

/** Display text for a finished run. Pure (unit-tested; `tr` defaults to the
 * app language at call time).
 *
 * `detail` is the beginning of what the run said: "finished" alone does not
 * tell the user whether it is worth opening the app, and a routine's result
 * is exactly the case where the answer is in the words. It comes after `tr`
 * because that is where every existing call site already passes its
 * translator. */
export function buildAgentEndNotification(
  sessionName: string,
  tr: Translator = t,
  detail?: string,
): {
  title: string;
  body: string;
} {
  const head = tr("notify.agentFinished", {
    name: sessionLabel(sessionName, tr),
  });
  // One line: a reply can be a document, and its first paragraph is what a
  // toast has room for. Whitespace is folded so a markdown reply does not
  // arrive as a stack of empty lines.
  const gist = truncate(
    (detail ?? "").replace(/\s+/g, " ").trim(),
    MAX_DETAIL_CHARS,
  );
  return { title: "Lumisca", body: gist === "" ? head : `${head}\n${gist}` };
}

/** Display text for an ask-tool question. The first question carries the
 * gist; the UI shows the rest once the window is back. Pure
 * (unit-tested). */
export function buildQuestionNotification(
  sessionName: string,
  questions: AskQuestion[],
  tr: Translator = t,
): { title: string; body: string } {
  const first = questions[0];
  const gist = first === undefined
    ? ""
    : (first.header?.trim() || first.question.trim());
  const detail = gist === "" ? "" : tr("notify.questionDetail", {
    gist: truncate(gist, MAX_QUESTION_CHARS),
  });
  return {
    title: "Lumisca",
    body: tr("notify.question", {
      name: sessionLabel(sessionName, tr),
      detail,
    }),
  };
}

/** Display text for a screen hand-over: the run is blocked at the machine
 * until the user acts, so the reason is what the toast leads with. Pure
 * (unit-tested). */
export function buildHandoverNotification(
  sessionName: string,
  reason: string,
  tr: Translator = t,
): { title: string; body: string } {
  const gist = truncate(reason.replace(/\s+/g, " ").trim(), MAX_HANDOVER_CHARS);
  const detail = gist === "" ? "" : tr("notify.handoverDetail", { gist });
  return {
    title: "Lumisca",
    body: tr("notify.handover", {
      name: sessionLabel(sessionName, tr),
      detail,
    }),
  };
}

/** Display text for the `vm_env` dialog: the run is blocked until the user
 * types a value, and the variable's name is what tells them whether they
 * can. Pure (unit-tested). */
export function buildEnvNotification(
  sessionName: string,
  variable: string,
  tr: Translator = t,
): { title: string; body: string } {
  return {
    title: "Lumisca",
    body: tr("notify.env", {
      name: sessionLabel(sessionName, tr),
      variable,
    }),
  };
}

/** Decide from already-known state whether the app is hidden from the
 * user (notify-worthy). Pure (unit-tested):
 * - a hidden document is always hidden (minimized WebView, background
 *   tab);
 * - without a shell answer the DOM focus is the only signal;
 * - with a shell answer, anything but "focused, visible, not minimized"
 *   counts as hidden — including another virtual desktop, where the
 *   window exists but the user looks elsewhere. */
export function shouldNotifyFromState(
  state: WindowState | null,
  docHidden: boolean,
  docFocused: boolean,
): boolean {
  if (docHidden) return true;
  if (state === null) return !docFocused;
  return !state.focused || state.minimized || !state.visible;
}

/** Whether the app is currently hidden from the user. Never throws. */
export async function isAppHidden(): Promise<boolean> {
  if (document.hidden) return true;
  const state = await withTimeout(
    windowStateApi.getState().then(
      (s) => s as WindowState | null,
      () => null,
    ),
    WINDOW_STATE_TIMEOUT_MS,
    null,
  );
  try {
    return shouldNotifyFromState(state, document.hidden, document.hasFocus());
  } catch {
    return true;
  }
}

/** The session name a notification shows: the tab's title when the caller
 * has it, or a function that reads it on demand. A session whose tab was
 * closed while its run kept going ("close and keep running") has no title
 * in this page — only the server knows it — and the raw session id the
 * event carries is not a name a user recognizes. The function is called
 * after the checks that drop the notification, so the extra request is
 * never made for a toast nobody would see. */
type SessionName = string | (() => Promise<string>);

/** Forward one notification to the shell when the app is hidden.
 * Fire-and-forget: every failure (disabled, visible, no shell, denied OS
 * permission) resolves silently — the event itself was already applied to
 * the UI state by the caller. */
async function maybeNotify(
  sessionName: SessionName,
  urgent: boolean,
  build: (name: string) => { title: string; body: string },
): Promise<void> {
  try {
    if (!isNotifyEnabled()) return;
    if (!await isAppHidden()) return;
    const name = typeof sessionName === "string"
      ? sessionName
      : await sessionName();
    const { title, body } = build(name);
    await notifyApi.notify(title, body, urgent);
  } catch {
    // Best-effort only.
  }
}

/** Notify that a session's run ended. Call on every `agent_end` event;
 * `detail` is the start of the reply when the caller has it. */
export function maybeNotifyAgentEnd(
  sessionName: SessionName,
  detail?: string,
): Promise<void> {
  return maybeNotify(
    sessionName,
    false,
    (name) => buildAgentEndNotification(name, t, detail),
  );
}

/** Notify that the agent asked the user a question. Call on every
 * `question` event (the run is still waiting, so this one is urgent —
 * the toast stays on screen longer). */
export function maybeNotifyQuestion(
  sessionName: SessionName,
  questions: AskQuestion[],
): Promise<void> {
  return maybeNotify(
    sessionName,
    true,
    (name) => buildQuestionNotification(name, questions),
  );
}

/** Notify that the run handed the machine's screen to the user. Call when a
 * `handover` begins (never when it ends, and not on a snapshot resync: the
 * user is in the app by then). Urgent for the same reason as a question. */
export function maybeNotifyHandover(
  sessionName: SessionName,
  reason: string,
): Promise<void> {
  return maybeNotify(
    sessionName,
    true,
    (name) => buildHandoverNotification(name, reason),
  );
}

/** Notify that the run is waiting for an environment variable's value
 * (`vm_env`). Urgent like a question: the run cannot continue without it. */
export function maybeNotifyEnv(
  sessionName: SessionName,
  variable: string,
): Promise<void> {
  return maybeNotify(
    sessionName,
    true,
    (name) => buildEnvNotification(name, variable),
  );
}
