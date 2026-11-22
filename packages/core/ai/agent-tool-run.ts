/**
 * The fallback tool-call executor: the calls the transport did not run.
 *
 * Only test doubles (the faux provider) bypass the SDK's tool loop; the real
 * Vercel transport executes via the tools' execute functions, and those results
 * arrive on the stream (see agent-step.ts). A call that reaches here runs under
 * the run's identity, so a call that returns after its run was abandoned must
 * not write its result into a transcript that moved on.
 */

import type {
  AgentMessage,
  ToolCall,
  ToolResultMessage,
} from "../domain/message.ts";
import type { AgentEvent, AgentTool } from "./agent-types.ts";

/** A completion (tool result) of one tool call. */
interface ToolOutcome {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        data: string;
        mimeType: string;
      }
  >;
  details: unknown;
  isError: boolean;
}

/** What executing a call needs from the agent that owns it. */
export interface ToolRunHost {
  /** The tool set in force (grown by the MCP attachment code). */
  tools(): AgentTool[];
  /** The current run's signal: a tool stops with the run it belongs to.
   * Read per call: a new run installs a new controller. */
  signal(): AbortSignal;
  /** True while the run is unwinding from abort: no further call starts. */
  aborted(): boolean;
  /** True when `runId` is a run this agent has already abandoned. */
  stale(runId: number): boolean;
  /** The transcript, read fresh: it is a real array that a rewind replaces. */
  messages(): AgentMessage[];
  /** The stamp of the next appended message (see Agent.nextTimestamp). */
  nextTimestamp(): number;
  emit(event: AgentEvent): void;
  /** Tell subscribers the result landed (a `message_end`). */
  announce(message: AgentMessage): void;
}

/** Run `toolCalls` one after another, recording each result. Returns early
 * (before the next call starts) when the run is aborted or abandoned. */
export async function runToolCalls(
  host: ToolRunHost,
  runId: number,
  toolCalls: readonly ToolCall[],
): Promise<void> {
  for (const call of toolCalls) {
    if (host.aborted() || host.stale(runId)) return;
    const tool =
      host.tools().find((t) => t.name === call.name) ?? ({} as AgentTool);
    host.emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    let outcome: ToolOutcome;
    if (tool.execute === undefined) {
      outcome = {
        content: [{ type: "text", text: `Tool ${call.name} not found` }],
        details: {},
        isError: true,
      };
    } else {
      try {
        const prepared = tool.prepareArguments
          ? tool.prepareArguments(call.arguments)
          : (call.arguments as Record<string, unknown>);
        const result = await tool.execute(
          call.id,
          prepared as never,
          host.signal(),
        );
        outcome = {
          content: result.content,
          details: result.details,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = {
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        };
      }
    }
    host.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
    });
    // The end event above tells a live client the line's spinner is done;
    // the RESULT itself is dropped when the run was abandoned while the call
    // ran (see stale) — the transcript may already belong to a newer run or a
    // rewind.
    if (host.stale(runId)) return;
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: outcome.content,
      details: outcome.details,
      isError: outcome.isError,
      // Appended now and stamped now: a result must follow the assistant
      // message it belongs to in time as well as in order (see
      // nextTimestamp).
      timestamp: host.nextTimestamp(),
    };
    host.messages().push(result);
    host.announce(result);
  }
}
