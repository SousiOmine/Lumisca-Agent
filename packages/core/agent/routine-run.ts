import type { AgentMessage } from "../ai/types.ts";
import type { MessageIdentity } from "../domain/event.ts";
import { contentText } from "../shared/content.ts";
import { TOOL_SEND_CHAT } from "../shared/mod.ts";
import { assistantTextVerdict } from "./silent-reply.ts";

/** The text of a message's content blocks, joined (what the conversation
 * shows for it). */
function textOfMessage(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return contentText(content as Array<{ type: string; text?: string }>);
}

/** What dropping a silent routine run needs from the session it ran in. */
export interface RoutineDropHost {
  messages(): AgentMessage[];
  /** The store position of the model's first in-memory message. */
  baseIndex(): number;
  forgetFrom(messages: AgentMessage[], from: number): void;
  truncateFrom(storePosition: number): MessageIdentity[];
  rebaseContexts(messages: AgentMessage[]): void;
  emitTruncated(removed: MessageIdentity[]): void;
}

/**
 * A routine's run: which routine is in flight, whether it said anything, and
 * how a silent one is removed.
 *
 * A routine that found nothing to report must leave the conversation exactly
 * as it found it. The model says so with the silence sentinel
 * (silent-reply.ts), which the projection already refuses to draw, but the
 * ROW would still be there and every later turn would pay for it. Silence is
 * therefore spelled as an absence: the prompt and the reply are removed.
 */
export class RoutineRun {
  private activeId: string | null = null;
  /** Where the run's own prompt sits in the view (see wasSilent). */
  private promptIndex = -1;

  /** A run of this routine is starting (its stop button only interrupts its
   * own run). `promptIndex` is the view's length before the prompt is
   * appended, so the run's own rows can be recognised while it is still in
   * flight. */
  begin(id: string, promptIndex: number): void {
    this.activeId = id;
    this.promptIndex = promptIndex;
  }

  /** The run finished, successfully or not. */
  end(): void {
    this.activeId = null;
    this.promptIndex = -1;
  }

  /** Whether the run in flight has said nothing so far (see wasSilent). The
   * run's end needs this BEFORE it is removed: a silent routine must not
   * notify, and the notification is decided while the rows are still
   * there. */
  saidNothingSoFar(messages: readonly AgentMessage[]): boolean {
    if (this.activeId === null || this.promptIndex < 0) return false;
    return this.wasSilent(messages, this.promptIndex);
  }

  /** The routine whose run is in flight, or null. */
  runningId(): string | null {
    return this.activeId;
  }

  /** Whether the rows after `from` say nothing: no assistant text, no sent
   * message, and no user steer. */
  wasSilent(messages: readonly AgentMessage[], from: number): boolean {
    if (from < 0 || messages.length <= from + 1) return false;
    for (let i = from + 1; i < messages.length; i++) {
      const message = messages[i];
      if (message === undefined) continue;
      if (message.role === "assistant") {
        if (message.stopReason === "toolUse") continue;
        const verdict = assistantTextVerdict(textOfMessage(message));
        if (verdict.kind === "message") return false;
        continue;
      }
      if (
        message.role === "notification" ||
        message.role === "context" ||
        message.role === "checkpoint"
      ) {
        continue;
      }
      if (message.role === "toolResult") {
        // A send_chat that went out is the routine speaking, whatever the
        // assistant's own text says.
        if (message.toolName === TOOL_SEND_CHAT && !message.isError) {
          return false;
        }
        continue;
      }
      // A user row after the prompt is a steer the user sent mid-run: that
      // is a conversation, so nothing is removed.
      if (message.role === "user") return false;
    }
    return true;
  }

  /** Remove a silent run: memory first, then the store, then the clients. */
  drop(host: RoutineDropHost, from: number): void {
    const messages = host.messages();
    const storePosition = host.baseIndex() + from;
    messages.splice(from);
    host.forgetFrom(messages, from);
    const removed = host.truncateFrom(storePosition);
    host.rebaseContexts(messages);
    if (removed.length > 0) host.emitTruncated(removed);
  }
}
