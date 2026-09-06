import { withTimeout } from "@lumisca/core/shared";
import { notifyApi, type WindowState, windowStateApi } from "./shell.ts";
import type { AskQuestion } from "./types.ts";

/** Background agent-event notifications (desktop only).
 *
 * The agent loop lives in the server process; its events reach this page
 * over the WebSocket. When a run ends (`agent_end`) or the agent asks a
 * question (the ask tool) while the main window has no focus — minimized,
 * behind another app, on another virtual desktop — the event would
 * otherwise go unnoticed, so it is forwarded to the desktop shell, which
 * shows it as an OS notification (plus a taskbar flash).
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

function sessionLabel(name: string): string {
  const trimmed = name.trim();
  return truncate(trimmed === "" ? "セッション" : trimmed, MAX_NAME_CHARS);
}

/** Display text for a finished run. Pure (unit-tested). */
export function buildAgentEndNotification(sessionName: string): {
  title: string;
  body: string;
} {
  return {
    title: "Lumisca",
    body: `「${sessionLabel(sessionName)}」の応答が完了しました`,
  };
}

/** Display text for an ask-tool question. The first question carries the
 * gist; the UI shows the rest once the window is back. Pure
 * (unit-tested). */
export function buildQuestionNotification(
  sessionName: string,
  questions: AskQuestion[],
): { title: string; body: string } {
  const first = questions[0];
  const gist = first === undefined
    ? ""
    : (first.header?.trim() || first.question.trim());
  const suffix = gist === "" ? "" : `：${truncate(gist, MAX_QUESTION_CHARS)}`;
  return {
    title: "Lumisca",
    body: `「${sessionLabel(sessionName)}」に質問があります${suffix}`,
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

/** Forward one event's display text to the shell when the app is hidden.
 * Fire-and-forget: every failure (disabled, visible, no shell, denied OS
 * permission) resolves silently — the event itself was already applied to
 * the UI state by the caller. */
async function maybeNotify(
  title: string,
  body: string,
  urgent: boolean,
): Promise<void> {
  try {
    if (!isNotifyEnabled()) return;
    if (!await isAppHidden()) return;
    await notifyApi.notify(title, body, urgent);
  } catch {
    // Best-effort only.
  }
}

/** Notify that a session's run ended. Call on every `agent_end` event. */
export function maybeNotifyAgentEnd(sessionName: string): Promise<void> {
  const { title, body } = buildAgentEndNotification(sessionName);
  return maybeNotify(title, body, false);
}

/** Notify that the agent asked the user a question. Call on every
 * `question` event (the run is still waiting, so this one is urgent —
 * the toast stays on screen longer). */
export function maybeNotifyQuestion(
  sessionName: string,
  questions: AskQuestion[],
): Promise<void> {
  const { title, body } = buildQuestionNotification(sessionName, questions);
  return maybeNotify(title, body, true);
}
