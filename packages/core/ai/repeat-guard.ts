/**
 * Loop hygiene: the advisory reminder for a model that keeps calling the same
 * tool with the same arguments.
 *
 * Nothing here blocks a call. The guard counts consecutive identical calls and,
 * at the configured repeat counts, appends one reminder telling the model to
 * inspect the result it already has (the DeepSeek Harness's
 * repeat-tool-reminder; a stuck model is nudged to change approach). Kept out
 * of agent.ts so the counting and the wording are readable together, apart
 * from the loop that calls them.
 */

import type { NotificationMessage, ToolCall } from "../domain/message.ts";
import { canonicalJson } from "../shared/digest.ts";

/** Consecutive identical tool calls that earn an advisory reminder. The
 * escalation mirrors the DeepSeek Harness's repeat-tool-reminder: a gentle
 * nudge on the third, a detailed one (naming the call and its arguments) on
 * the fifth and eighth. */
const REPEAT_REMINDER_AT: readonly number[] = [3, 5, 8];

/** Characters of the repeated arguments shown by the detailed reminder. */
const REPEAT_ARGUMENTS_PREVIEW = 500;

/** The advisory message for a repeated call. */
function repeatReminder(call: ToolCall, count: number): NotificationMessage {
  const repeated = `${count} times in a row with identical arguments`;
  const body =
    count >= REPEAT_REMINDER_AT[1]!
      ? `You called ${call.name} ${repeated}. The repeats are not making ` +
        "progress: inspect the latest result and choose a different action, " +
        "different arguments, or finish the task instead of calling it " +
        "again.\n- arguments: " +
        canonicalJson(call.arguments).slice(0, REPEAT_ARGUMENTS_PREVIEW)
      : `You called ${call.name} ${repeated}. Inspect the previous result ` +
        "before calling it again: if the task is not complete, change the " +
        "approach or the arguments instead of repeating the call.";
  return {
    role: "notification",
    kind: "notice",
    title: `[Repeated tool call: ${call.name}]`,
    body,
    status: "neutral",
    // The loop appends it while the run is active: it joins that run's turn
    // like a tool result (see the web's buildTurns — a message that did not
    // start a run must not split the running turn).
    steered: true,
    timestamp: Date.now(),
  };
}

/** Counts consecutive identical calls and answers with the reminder to append,
 * once the count reaches one of {@link REPEAT_REMINDER_AT}. Runs after the
 * calls' results landed, so the reminder follows them in the transcript and in
 * the next request. Any other call resets the count, and so does a new prompt
 * (see Agent.append, which calls {@link reset}). */
export class RepeatGuard {
  /** The last call seen and how many times it has repeated back to back. */
  private signature: string | undefined;
  private count = 0;

  /** The reminder one turn's calls earn, or undefined when none does. */
  note(calls: readonly ToolCall[]): NotificationMessage | undefined {
    let reminder: NotificationMessage | undefined;
    for (const call of calls) {
      const signature = `${call.name}\u0000${canonicalJson(call.arguments)}`;
      this.count = signature === this.signature ? this.count + 1 : 1;
      this.signature = signature;
      if (REPEAT_REMINDER_AT.includes(this.count)) {
        reminder = repeatReminder(call, this.count);
      }
    }
    return reminder;
  }

  /** A new instruction must never be read as a loop. */
  reset(): void {
    this.signature = undefined;
    this.count = 0;
  }
}
