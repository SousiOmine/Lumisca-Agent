/**
 * What a run said to the user, carried by its `agent_end`.
 *
 * A notification has to answer "is this worth opening the app for?", and
 * "finished" alone does not: a routine's result, or a long answer, is exactly
 * the case where the words matter. The reply is not read back from the store
 * because the store cannot tell this run's answer from the previous one's:
 * the end of a run that said nothing would then repeat an old message.
 *
 * Which messages count is not decided here. The projection that decides what
 * the conversation shows ({@link stellaEntryOf}) is the rule the user already
 * sees, so a notification can never offer text the conversation hid: a
 * `NO_RESPONSE` turn (the agent chose silence), the narration before a tool
 * call ("checking the file"), the context messages steering the model. What
 * it adds is the `send_chat` result, which in stella IS the reply — an agent
 * that answered through the tool said nothing in its assistant text.
 */
import type { AgentMessage } from "../ai/types.ts";
import { stellaEntryOf } from "./stella-stream.ts";

/** Longest reply a client is handed. A notification shows a line or two and
 * the transcript has the whole answer, so this is sized for reading, not for
 * fidelity; the notifiers cut again to their own width. */
export const MAX_REPLY_CHARS = 200;

export class RunReply {
  private text = "";

  /** Record one message of the run, keeping the last thing it said. The
   * answer does not always come last: a run can close with a tool call whose
   * message is model-only, so the previous reply stands. */
  observe(message: AgentMessage): void {
    const entry = stellaEntryOf(message);
    if (entry === null || entry.role !== "assistant") return;
    const text = entry.text.trim();
    if (text.length > 0) this.text = text;
  }

  /** Forget what was said: a run's reply belongs to that run only. */
  reset(): void {
    this.text = "";
  }

  /** The reply to carry, capped, or undefined when the run said nothing to
   * the user (silence, or an end before any message). */
  gist(): string | undefined {
    if (this.text.length === 0) return undefined;
    return Array.from(this.text).slice(0, MAX_REPLY_CHARS).join("");
  }
}
