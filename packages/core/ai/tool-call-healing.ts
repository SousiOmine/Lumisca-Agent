/**
 * Transcript healing after a stop: the tool calls a run never got to answer,
 * given a result so the next request is one a provider accepts.
 *
 * A run can be closed outside its turn boundary (see Agent.abort): a tool
 * that ignores its abort signal holds the loop, and the assistant message with
 * its tool calls is already in the transcript. A provider rejects the NEXT
 * request when an assistant message's tool calls have no results
 * (AI_MissingToolResultsError), so the calls get a "stopped" result here,
 * while the stop is still ours to record.
 */

import type { AgentMessage, ToolResultMessage } from "../domain/message.ts";
import type { AgentEvent } from "./agent-types.ts";

/** What healing needs from the agent that owns the transcript. */
export interface HealingHost {
  /** The stamp of the next appended message (see Agent.nextTimestamp): a
   * result must follow the assistant message it answers in time as well as
   * in order. */
  nextTimestamp(): number;
  emit(event: AgentEvent): void;
  /** Tell subscribers the result landed (a `message_end`). */
  announce(message: AgentMessage): void;
}

/** Give every tool call at the transcript's end a result, for a run that was
 * stopped before its tool could answer. Only the trailing assistant message
 * is considered: an earlier turn's calls already have their results (anything
 * else would be a transcript the provider refuses, and rewriting history here
 * would hide the real bug). */
export function healUnansweredToolCalls(
  messages: AgentMessage[],
  host: HealingHost,
): void {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.role === "toolResult") index--;
  const tail = messages[index];
  if (tail === undefined || tail.role !== "assistant") return;
  const answered = new Set<string>();
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "toolResult") answered.add(message.toolCallId);
  }
  const unanswered = (
    tail.content as ReadonlyArray<{
      type?: string;
      id?: string;
      name?: string;
    }>
  )
    .filter((block) => block.type === "toolCall")
    .filter((block) => block.id !== undefined && !answered.has(block.id));
  if (unanswered.length === 0) return;
  for (const call of unanswered) {
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id!,
      toolName: call.name ?? "",
      content: [{ type: "text", text: "Stopped by the user." }],
      details: {},
      isError: true,
      timestamp: host.nextTimestamp(),
    };
    messages.push(result);
    host.emit({
      type: "tool_execution_end",
      toolCallId: call.id!,
      toolName: call.name ?? "",
    });
    host.announce(result);
  }
}
