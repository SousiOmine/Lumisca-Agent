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
  AgentTool,
  AgentState,
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
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
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
  async prompt(input: string | AgentMessage, images?: ImageContent[]): Promise<void> {
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

  /** One exchange: repeatedly call the stream until the model stops (no tool
   * calls), executing any tool calls in between. `turn_end` is emitted for
   * every assistant turn (tool-call turns included) so the session agent's
   * retry policy sees the turn's output and resets its vacant-response
   * counter on progress. */
  private async exchangeLoop(): Promise<void> {
    for (;;) {
      if (this.abortRequested) return;
      const assistant = await this.step();
      if (this.abortRequested) return;
      this.emit({ type: "turn_end", message: assistant });
      const toolCalls = assistant.content.filter(
        (b): b is ToolCall => b.type === "toolCall",
      );
      if (toolCalls.length === 0) return;
      await this.executeTools(toolCalls);
      if (this.abortRequested) return;
    }
  }

  /** One LLM call: stream the model and record the resulting AssistantMessage
   * (emitting message_start/deltas/message_end). */
  private async step(): Promise<AssistantMessage> {
    const model = this.state.model;
    this.emit({ type: "message_start", message: placeholderAssistant(model) });

    let candidate: AssistantMessage | undefined;
    let final: AssistantMessage | undefined;
    let errorMessage: string | undefined;
    let text = "";
    let thinking = "";

    const llmMessages = await this.convertToLlm(this.state.messages);
    const stream = this.streamFn(
      model,
      {
        systemPrompt: this.state.systemPrompt,
        messages: llmMessages as never,
        tools: this.state.tools,
        thinkingLevel: this.runThinkingLevel,
      },
      { signal: this.abortController.signal },
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
        const ev = event as { errorMessage?: string; error?: { errorMessage?: string } };
        errorMessage = ev.errorMessage ?? ev.error?.errorMessage;
      } else if (event.type === "done") {
        final = event.message;
      }
    }

    if (errorMessage !== undefined) {
      final = errorAssistant(model, errorMessage);
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
    this.state.errorMessage = errorMessage ?? this.state.errorMessage;
    this.emit({ type: "message_end", message: final! });
    return final!;
  }

  /** Execute the model's tool calls, recording toolResult messages. */
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
          const message = error instanceof Error ? error.message : String(error);
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

function errorAssistant(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}
