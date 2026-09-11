/**
 * The Lumisca agent runtime: drives an exchange over a {@link StreamFn},
 * executing tool calls itself (so it can emit tool_start/tool_end events and
 * feed tool results back into the LLM), and exposing the small lifecycle the
 * session agent and the sub-agent hub use (prompt / steer / followUp /
 * continue / abort / waitForIdle / subscribe).
 *
 * This replaces pi-agent-core's Agent. The transport is whatever StreamFn is
 * injected — the real one is Vercel-backed (ai/stream.ts), tests inject a
 * faux (ai/faux.ts).
 */
import type { StreamFn } from "./types.ts";
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  ModelThinkingLevel,
  StopReason,
  ToolCall,
  ToolResultMessage,
} from "./types.ts";

export interface AgentDefaults {
  systemPrompt: string;
  model: Model<Api>;
  tools: AgentTool[];
  messages?: AgentMessage[];
  thinkingLevel?: ModelThinkingLevel;
}

export interface AgentInit {
  initialState: AgentDefaults;
  streamFn: StreamFn;
  sessionId: string;
  /** Convert the transcript to LLM messages (Lumisca's notification/mode
   * handling + image analysis live here). May be async (image analysis). */
  convertToLlm?: (messages: AgentMessage[]) => unknown[] | Promise<unknown[]>;
}

/** A completion (tool result) of one tool call. */
interface ToolOutcome {
  content: Array<
    { type: "text"; text: string } | {
      type: "image";
      data: string;
      mimeType: string;
    }
  >;
  details: unknown;
  isError: boolean;
}

/**
 * One live agent. The transcript lives in `state.messages` (a real array,
 * mutated in place by rewind), and the tool set in `state.tools` (grown by
 * the MCP attachment code).
 */
export class Agent {
  readonly state: AgentState;
  private readonly streamFn: StreamFn;
  private readonly sessionId: string;
  private readonly convertToLlm: (
    messages: AgentMessage[],
  ) => unknown[] | Promise<unknown[]>;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly abortController = new AbortController();
  private readonly steerQueue: AgentMessage[] = [];
  private running: Promise<void> = Promise.resolve();
  private runningInner = false;
  private closed = false;
  private abortRequested = false;
  /** The thinking level used by the current run, snapshotted at run start so
   * a mid-run level change never leaks into the in-flight exchange. */
  private runThinkingLevel: ModelThinkingLevel = "off";

  constructor(init: AgentInit) {
    this.streamFn = init.streamFn;
    this.sessionId = init.sessionId;
    this.convertToLlm = init.convertToLlm ?? ((m) => m as unknown[]);
    this.state = {
      systemPrompt: init.initialState.systemPrompt,
      model: init.initialState.model,
      tools: init.initialState.tools ?? [],
      messages: init.initialState.messages ?? [],
      thinkingLevel: init.initialState.thinkingLevel ?? "off",
      isStreaming: false,
    };
  }

  get isStreaming(): boolean {
    return this.state.isStreaming;
  }

  get messages(): AgentMessage[] {
    return this.state.messages;
  }

  /** Subscribe to agent events; returns an unsubscribe function. */
  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: AgentEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // event sinks must never break the loop
      }
    }
  }

  /** Run a prompt: a string (+images) becomes a user message; a pre-built
   * AgentMessage (notification/mode/user) is used as-is. If a run is already
   * active the message is steered to the next turn boundary. */
  async prompt(
    input: string | AgentMessage,
    images?: ImageContent[],
  ): Promise<void> {
    const message = normalizeInput(input, images);
    if (this.runningInner) {
      this.steerQueue.push(message);
      return;
    }
    await this.startRun(message);
  }

  /** Re-run the current transcript without adding a prompt (used by the
   * sub-agent rate-limit retry, which drops the failed error turn first). */
  async continue(): Promise<void> {
    if (this.runningInner) return;
    await this.startRun(undefined);
  }

  /** Inject a message into a running exchange at its next turn boundary; an
   * idle agent processes it immediately. */
  steer(message: AgentMessage): void {
    if (this.runningInner) {
      this.steerQueue.push(message);
      return;
    }
    this.startRun(message);
  }

  /** Inject a retry/continue instruction in-run (a follow-up user message). */
  followUp(message: AgentMessage): void {
    this.steerQueue.push(message);
  }

  abort(): void {
    this.abortRequested = true;
    this.abortController.abort();
    this.emit({ type: "agent_end" });
  }

  clearAllQueues(): void {
    this.steerQueue.length = 0;
    this.abortRequested = false;
  }

  async waitForIdle(): Promise<void> {
    await this.running;
  }

  close(): void {
    this.closed = true;
    this.abort();
  }

  /** Start (or continue) an exchange, empty the steer queue as it goes. */
  private async startRun(first?: AgentMessage): Promise<void> {
    this.running = this.__run(first);
    await this.running;
  }

  private async __run(first?: AgentMessage): Promise<void> {
    if (this.runningInner) return;
    this.runningInner = true;
    this.state.isStreaming = true;
    this.abortRequested = false;
    // Snapshot the thinking level for this exchange (a change made while
    // streaming applies from the next run only).
    this.runThinkingLevel = this.state.thinkingLevel;
    try {
      if (first !== undefined) {
        this.append(first);
      }
      this.emit({ type: "agent_start" });

      if (this.steerQueue.length > 0) {
        // A steer that starts its own run is already processed by the
        // caller's message_start/end; drain it here as a turn.
        const queued = this.steerQueue.shift()!;
        this.append(queued);
      }

      await this.exchangeLoop();

      // Drain any steer/followUp messages queued during the run as new turns.
      while (!this.abortRequested && this.steerQueue.length > 0) {
        if (this.closed) break;
        const next = this.steerQueue.shift()!;
        this.append(next);
        await this.exchangeLoop();
      }
    } finally {
      this.state.isStreaming = false;
      this.runningInner = false;
      this.emit({ type: "agent_end" });
    }
  }

  /** Append a user/mode/notification message to the transcript. The caller
   * (session agent) announces these to clients; the agent only emits
   * assistant message events (in step). */
  private append(message: AgentMessage): void {
    this.state.messages.push(message);
  }

  /** One exchange: each step() is a single LLM turn whose tool calls the
   * AI SDK already executed (single step via `stopWhen: isStepCount(1)` in
   * the transport). The loop continues while the turn ends with tool calls
   * so the model sees their results; it ends on a text-only turn.
   * `turn_end` fires per turn (tool-call turns included) so the session
   * agent's retry policy observes progress. When a test double (faux
   * provider) bypasses the SDK, the done message may still carry
   * unexecuted tool calls — those are executed here as a fallback.
   *
   * A message steered in while the agent is working (a sub-agent
   * completion, a user message, a follow-up retry) is picked up at the top
   * of the loop and becomes the next turn, so notifications reach the LLM
   * at the next turn boundary instead of only after the whole tool chain
   * finishes — the UI already announces them immediately, and deferring
   * them to the end of the chain left the agent blind to them mid-loop. */
  private async exchangeLoop(): Promise<void> {
    for (;;) {
      if (this.abortRequested) return;
      if (this.steerQueue.length > 0) {
        const queued = this.steerQueue.shift()!;
        this.append(queued);
        continue;
      }
      const { assistant, executedIds } = await this.step();
      if (this.abortRequested) return;
      this.emit({ type: "turn_end", message: assistant });
      const pending = assistant.content.filter(
        (b): b is ToolCall => b.type === "toolCall",
      );
      if (pending.length === 0) return;
      // Fallback: the SDK did not execute these tool calls (faux provider /
      // test doubles yield no toolcall_result events). Only the missing
      // calls run here — SDK-executed calls already have their results in
      // the transcript and must never run twice.
      const missing = pending.filter((call) => !executedIds.has(call.id));
      if (missing.length > 0) {
        await this.executeTools(missing);
      }
      if (this.abortRequested) return;
    }
  }

  /** One LLM call: stream a single turn (the SDK executes the turn's tool
   * calls via their execute functions) and record the resulting
   * AssistantMessage, emitting message_start/deltas/message_end and
   * tool_execution_start/end events. Returns the assistant message plus
   * the ids the SDK executed (empty for test doubles that bypass it). */
  private async step(): Promise<{
    assistant: AssistantMessage;
    executedIds: Set<string>;
  }> {
    const model = this.state.model;
    this.emit({ type: "message_start", message: placeholderAssistant(model) });

    let candidate: AssistantMessage | undefined;
    let final: AssistantMessage | undefined;
    let errorMessage: string | undefined;
    let errorRetryable = false;
    let text = "";
    let thinking = "";
    const executedIds = new Set<string>();
    // Tool results the SDK produced during this turn. Buffered while
    // streaming (events go out immediately) and appended to the transcript
    // AFTER the assistant message, so the order stays
    // assistant(toolCalls) → toolResults — the order providers expect.
    const pendingResults: ToolResultMessage[] = [];

    const llmMessages = await this.convertToLlm(this.state.messages);
    const stream = this.streamFn(
      model,
      {
        systemPrompt: this.state.systemPrompt,
        messages: llmMessages as never,
        tools: this.state.tools,
        thinkingLevel: this.runThinkingLevel,
      },
      // The session id is the conversation this exchange belongs to —
      // session-affinity gateways (OpenCode Go) require it on every turn.
      { signal: this.abortController.signal, sessionId: this.sessionId },
    );

    for await (const event of stream) {
      if (event.type === "start") {
        candidate = event.partial;
      } else if (event.type === "text_delta") {
        text += event.delta;
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: event.delta },
        });
      } else if (event.type === "thinking_delta") {
        thinking += event.delta;
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: event.delta },
        });
      } else if (event.type === "error") {
        const ev = event as {
          errorMessage?: string;
          errorDetail?: string;
          errorRetryable?: boolean;
          error?: { errorMessage?: string };
        };
        const base = ev.errorMessage ?? ev.error?.errorMessage;
        // Keep the transport's detail with the message: the transcript (and
        // therefore the DB, the UI banner and the session log) then says
        // *why* the call failed, not just that it did.
        errorMessage = base === undefined
          ? undefined
          : ev.errorDetail === undefined
          ? base
          : `${base} (${ev.errorDetail})`;
        if (ev.errorRetryable === true) errorRetryable = true;
      } else if (event.type === "toolcall_start") {
        // The SDK is executing this tool call: only the start event is
        // emitted here — the SDK runs the tool and a toolcall_result event
        // follows with its output.
        this.emit({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      } else if (event.type === "toolcall_result") {
        // The SDK finished executing this tool. Emit the end event now;
        // the transcript record waits until after the assistant message
        // (see pendingResults). The id marks the call as executed so the
        // exchange loop never runs it a second time.
        executedIds.add(event.toolCallId);
        this.emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: { content: event.content, details: {} },
          isError: event.isError,
        });
        pendingResults.push({
          role: "toolResult" as const,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: event.content as Array<
            { type: "text"; text: string } | {
              type: "image";
              data: string;
              mimeType: string;
            }
          >,
          details: {},
          isError: event.isError,
          timestamp: Date.now(),
        });
      } else if (event.type === "done") {
        final = event.message;
      }
    }

    if (errorMessage !== undefined) {
      final = errorAssistant(model, errorMessage, errorRetryable);
    } else if (final === undefined && candidate !== undefined) {
      // Test faux streams that only emit start(partial) + end.
      final = { ...candidate, timestamp: Date.now() };
    } else if (final === undefined) {
      final = errorAssistant(model, "The model stream produced no response");
    }

    if (final !== undefined && text.length > 0 && final.content.length === 0) {
      final = { ...final, content: [{ type: "text", text }] };
    }
    if (final !== undefined && thinking.length > 0) {
      final = {
        ...final,
        content: [{ type: "thinking", thinking }, ...final.content],
      };
    }

    this.state.messages.push(final!);
    for (const result of pendingResults) {
      this.state.messages.push(result);
    }
    this.state.errorMessage = errorMessage ?? this.state.errorMessage;
    this.emit({ type: "message_end", message: final! });
    return { assistant: final!, executedIds };
  }

  /** Fallback: execute tool calls the SDK did not run. Only test doubles
   * (faux provider) that bypass the SDK's tool loop reach here — the real
   * Vercel transport executes via the tools' execute functions. */
  private async executeTools(toolCalls: ToolCall[]): Promise<void> {
    for (const call of toolCalls) {
      if (this.abortRequested) return;
      const tool = this.state.tools.find((t) => t.name === call.name) ??
        ({} as AgentTool);
      this.emit({
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
            this.abortController.signal,
          );
          outcome = {
            content: result.content,
            details: result.details,
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          outcome = {
            content: [{ type: "text", text: message }],
            details: {},
            isError: true,
          };
        }
      }
      this.emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: outcome,
        isError: outcome.isError,
      });
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: outcome.content,
        details: outcome.details,
        isError: outcome.isError,
        timestamp: Date.now(),
      };
      this.state.messages.push(result);
    }
  }
}

/** Normalize a prompt input into a transcript message. */
function normalizeInput(
  input: string | AgentMessage,
  images?: ImageContent[],
): AgentMessage {
  if (typeof input !== "string") return input;
  const content: Array<{ type: "text"; text: string } | ImageContent> = [
    { type: "text", text: input },
  ];
  if (images !== undefined && images.length > 0) content.push(...images);
  return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}

function placeholderAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "pending" as StopReason,
    timestamp: Date.now(),
  };
}

function errorAssistant(
  model: Model<Api>,
  errorMessage: string,
  errorRetryable = false,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "error",
    errorMessage,
    ...(errorRetryable ? { errorRetryable: true } : {}),
    timestamp: Date.now(),
  };
}
