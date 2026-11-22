/**
 * One LLM turn's stream: how the events of a provider call become an
 * assistant message, the tool results the SDK executed alongside it, and the
 * client events that carry the turn while it runs.
 *
 * The loop that reads the stream stays in agent.ts (it is the run's await
 * sequence, and a turn's end must land in the same task the provider finished
 * in); this module is the per-event state machine it drives and the assembly
 * that follows.
 */

import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from "../domain/message.ts";
import type { Api } from "../domain/model.ts";
import type { AgentEvent } from "./agent-types.ts";
import type { Model } from "./catalog.ts";
import { failedAssistant } from "./message-factory.ts";
import { StreamAccumulator } from "./stream-accumulator.ts";
import type { StreamEvent } from "./transport.ts";

/** What one turn produced. */
export interface Turn {
  /** The turn's message. Unstamped: the caller records it in the transcript
   * and stamps it there (see Agent.step). */
  assistant: AssistantMessage;
  /** Ids of the tool calls whose result arrived during the stream: the
   * exchange loop must not run them a second time. Empty for test doubles
   * that bypass the SDK. */
  executedIds: Set<string>;
  /** Results the SDK produced, in the order they arrived. Unstamped for the
   * same reason as the message: they are appended after it and stamped then. */
  results: Omit<ToolResultMessage, "timestamp">[];
  /** The failure the stream reported, when it did. The turn's message records
   * it too, and the caller keeps it on the agent for the session's error
   * display. */
  errorMessage: string | undefined;
}

/** Accumulates one turn from the events of its stream and assembles the
 * message at the end (see {@link TurnStream.finish}). */
export class TurnStream {
  private candidate: AssistantMessage | undefined;
  private final: AssistantMessage | undefined;
  private errorMessage: string | undefined;
  private errorRetryable = false;
  /** The turn's body, accumulated the one way every stream consumer does
   * (see ai/stream-accumulator.ts). */
  private readonly body = new StreamAccumulator();
  private readonly executedIds = new Set<string>();
  // Results the SDK produced during this turn. Buffered while streaming
  // (their events go out immediately) and returned to the caller, which
  // appends them AFTER the assistant message, so the order stays
  // assistant(toolCalls) → toolResults — the order providers expect. The
  // timestamp is missing on purpose: it is stamped when the transcript takes
  // them, after the assistant message they must follow.
  private readonly results: Omit<ToolResultMessage, "timestamp">[] = [];

  constructor(
    private readonly model: Model<Api>,
    private readonly events: { emit(event: AgentEvent): void },
  ) {}

  /** Take one event of the turn's stream. */
  handle(event: StreamEvent): void {
    if (event.type === "start") {
      this.candidate = event.partial;
    } else if (event.type === "text_delta") {
      this.body.take(event);
      this.events.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: event.delta },
      });
    } else if (event.type === "thinking_delta") {
      this.body.take(event);
      this.events.emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: event.delta },
      });
    } else if (event.type === "error") {
      // Keep the transport's detail with the message: the transcript (and
      // therefore the DB, the UI banner and the session log) then says
      // *why* the call failed, not just that it did.
      this.errorMessage =
        event.errorDetail === undefined
          ? event.errorMessage
          : `${event.errorMessage} (${event.errorDetail})`;
      if (event.errorRetryable === true) this.errorRetryable = true;
    } else if (event.type === "toolcall_start") {
      // The SDK is executing this tool call: only the start event is
      // emitted here — the SDK runs the tool and a toolcall_result event
      // follows with its output.
      this.events.emit({
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    } else if (event.type === "toolcall_result") {
      // The SDK finished executing this tool. Emit the end event now
      // (the UI clears the tool line's spinner with it); the transcript
      // record waits until after the assistant message (see `results`). The
      // id marks the call as executed so the exchange loop never runs it a
      // second time.
      // The outcome itself (content + details) is carried by the toolResult
      // message announced below, not by the event: one payload, one carrier
      // — an event copy would only send the same result twice (image
      // results are megabytes).
      const details = event.details ?? {};
      this.executedIds.add(event.toolCallId);
      this.events.emit({
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      this.results.push({
        role: "toolResult" as const,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: event.content as Array<
          | { type: "text"; text: string }
          | {
              type: "image";
              data: string;
              mimeType: string;
            }
        >,
        details,
        isError: event.isError,
      });
    } else if (event.type === "done") {
      this.final = event.message;
    }
  }

  /** Assemble the turn's message once its stream ended. */
  finish(): Turn {
    const model = this.model;
    let final = this.final;

    if (this.errorMessage !== undefined) {
      final = failedAssistant(model, this.errorMessage, this.errorRetryable);
    } else if (final === undefined && this.candidate !== undefined) {
      // Test faux streams that only emit start(partial) + end.
      final = { ...this.candidate, timestamp: Date.now() };
    } else if (final === undefined) {
      final = failedAssistant(model, "The model stream produced no response");
    }

    if (this.body.text.length > 0 && final.content.length === 0) {
      final = { ...final, content: [{ type: "text", text: this.body.text }] };
    }
    // The transport's finished message already carries the turn's thinking
    // (ai/stream.ts buildAssistantMessage), so this only fills it in for a
    // stream that emitted the deltas without describing the message. Adding
    // it unconditionally stored every reasoning block twice — and a model
    // that requires its reasoning replayed (interleaved `reasoning_content`)
    // then sent both copies back on every later request.
    if (
      this.body.thinking.length > 0 &&
      !final.content.some((block) => block.type === "thinking")
    ) {
      final = {
        ...final,
        content: [
          { type: "thinking", thinking: this.body.thinking },
          ...final.content,
        ],
      };
    }

    return {
      assistant: final,
      executedIds: this.executedIds,
      results: this.results,
      errorMessage: this.errorMessage,
    };
  }
}

/** The tool calls of a finished turn that still need their results. */
export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}
