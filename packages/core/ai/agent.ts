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
  RequestShape,
  StopReason,
  ToolCall,
  ToolResultMessage,
} from "./types.ts";
import type { NotificationMessage } from "../types/notification.ts";
import { canonicalJson, fnv1a } from "../shared/digest.ts";

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
  /** Runs before every LLM request of the loop, with the run's abort signal
   * — after the previous turn's results landed and before the request is
   * derived from the transcript. The context compactor (see
   * agent/context-compaction.ts) rewrites `state.messages` here, so the
   * request that follows already reflects the replacement; a long
   * tool-heavy turn therefore cannot grow past the window mid-turn. */
  beforeStep?: (signal: AbortSignal) => Promise<void>;
  /** Observe the model-visible shape of each request this loop sends (see
   * RequestShape): the first request of the agent, and every later request
   * whose head changed or whose message list is not an append-extension of
   * its predecessor — exactly the events that cost the provider's prompt
   * cache. The session agent records the shape; sub-agents leave it unset
   * (their transcript is memory-only). */
  onRequest?: (shape: RequestShape) => void;
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
  private readonly beforeStep:
    | ((signal: AbortSignal) => Promise<void>)
    | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  /** Signal of the CURRENT run. Recreated at every run start: an
   * AbortSignal is one-way, so a single long-lived controller would keep
   * every later run aborted (the model call then never leaves the
   * machine) — the session would silently stop working after one abort. */
  private abortController = new AbortController();
  private readonly steerQueue: AgentMessage[] = [];
  private running: Promise<void> = Promise.resolve();
  private runningInner = false;
  private closed = false;
  private abortRequested = false;
  /** The thinking level used by the current run, snapshotted at run start so
   * a mid-run level change never leaks into the in-flight exchange. */
  private runThinkingLevel: ModelThinkingLevel = "off";
  private readonly onRequest: ((shape: RequestShape) => void) | undefined;
  /** Fingerprint of the request sent last (see noteRequest): the head hash,
   * the per-message hashes and their fold. Kept so the next request can be
   * classified as an append-extension without re-hashing the messages the
   * provider already saw. */
  private previousHeadHash: string | undefined;
  private previousMessageHashes: string[] | undefined;
  private previousMessagesHash: string | undefined;
  private readonly messageHashes = new WeakMap<object, string>();
  /** The head hash of the current system prompt + tool set: recomputed only
   * when one of them is replaced (identity compare), never per step. */
  private headFingerprint:
    | { prompt: string; tools: AgentTool[]; hash: string }
    | undefined;
  /** The last tool call seen and how many times it has repeated back to
   * back (see noteToolCalls); reset by any other call and by a new prompt. */
  private repeatSignature: string | undefined;
  private repeatCount = 0;

  constructor(init: AgentInit) {
    this.streamFn = init.streamFn;
    this.sessionId = init.sessionId;
    this.convertToLlm = init.convertToLlm ?? ((m) => m as unknown[]);
    this.beforeStep = init.beforeStep;
    this.onRequest = init.onRequest;
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

  /** True while the current run is unwinding from abort(): no further turn
   * of it will be taken, and its queues are dropped when it settles. Callers
   * that would otherwise steer a message into it must let it start its own
   * run instead (see prompt). */
  get isAborting(): boolean {
    return this.abortRequested;
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
   * AgentMessage (notification/mode/user) is used as-is.
   *
   * A healthy run takes the message at its next turn boundary (steer). A run
   * that is unwinding from an abort never does — its queues are dropped when
   * it settles (the rewind path), so a message queued into it would vanish
   * without a trace. Such a prompt waits for that run to settle and then gets
   * its own run. */
  async prompt(
    input: string | AgentMessage,
    images?: ImageContent[],
  ): Promise<void> {
    const message = normalizeInput(input, images);
    if (this.runningInner && this.abortRequested) {
      // An abort ends the run: the rejection (if any) belongs to that run's
      // own caller, never to this message.
      await this.running.catch(() => {});
    }
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
   * idle agent (or one whose run is unwinding — see prompt) processes it
   * immediately. Fire-and-forget by contract: the run reports its own
   * progress and failures through the event stream. */
  steer(message: AgentMessage): void {
    if (this.runningInner && !this.abortRequested) {
      this.steerQueue.push(message);
      return;
    }
    // The caller has no channel for a rejection here (notifications, sub-agent
    // deliveries), and a floating rejection would only surface as an unhandled
    // promise rejection — the run's own failure reporting covers it.
    void this.prompt(message).catch(() => {});
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

  /** Await the end of the run that is currently active (resolves
   * immediately when none is): the rewind path settles the aborted run
   * before truncating the transcript. */
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
    // A fresh signal for this run: the previous run's abort must never reach
    // into it (see the abortController field).
    this.abortController = new AbortController();
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

  /** Append a user/mode/notification/context message to the transcript.
   * The caller (session agent) announces these to clients; the agent itself
   * announces only the messages it builds (the assistant messages of step()
   * and the tool results — see announce). Context snapshots are appended
   * this way outside of a run (see SessionAgent.publishContexts): they are
   * history for the next LLM call, not a reason to start one. */
  private append(message: AgentMessage): void {
    // A new prompt is a fresh instruction: it must never be read as a loop,
    // so the repeat guard's counter resets (a notification or a tool result
    // does not reset it — those are the loop's own output).
    if (message.role === "user" || message.role === "mode") {
      this.repeatSignature = undefined;
      this.repeatCount = 0;
    }
    this.state.messages.push(message);
  }

  /** Append a message to the transcript without starting a run. Used by
   * the session agent for context snapshots (skill catalog, workspace
   * instructions), which must be in history before the run they precede. */
  appendMessage(message: AgentMessage): void {
    this.append(message);
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
      // Pre-step: the transcript is complete up to this point (the previous
      // turn's results and any steered message landed), so a rewrite here is
      // what the request below is derived from.
      if (this.beforeStep !== undefined) {
        await this.beforeStep(this.abortController.signal);
        if (this.abortRequested) return;
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
      // Advisory loop hygiene, after the calls' results landed (so the
      // reminder is the last thing the model reads before the next request).
      this.noteToolCalls(pending);
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
    this.noteRequest(llmMessages as unknown[]);
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
        // The SDK finished executing this tool. Emit the end event now
        // (the UI clears the tool line's spinner with it); the transcript
        // record waits until after the assistant message (see
        // pendingResults). The id marks the call as executed so the
        // exchange loop never runs it a second time.
        // The outcome itself (content + details) is carried by the
        // toolResult message announced below, not by the event: one
        // payload, one carrier — an event copy would only send the same
        // result twice (image results are megabytes).
        const details = event.details ?? {};
        executedIds.add(event.toolCallId);
        this.emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
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
          details,
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
    // The turn's tool results are messages of the transcript like any
    // other, so they are announced too — after their assistant message, the
    // order they hold in the transcript. The live UI pairs each result with
    // its call (the tool line's checkmark and its `+N -M` badge are built
    // from the toolResult message); without this announcement those marks
    // only appear when the view happens to re-read the transcript snapshot
    // (a reload, a WS reconnect, or a return to the foreground).
    for (const result of pendingResults) {
      this.announce(result);
    }
    return { assistant: final!, executedIds };
  }

  /** Announce a message this agent appended to the transcript (the session
   * agent announces the prompt-side messages it builds). Only `message_end`
   * is emitted: nothing streams for these messages, and the client upserts
   * the finished message on that event — a message_start would only send
   * the same payload twice (tool results can carry images). */
  private announce(message: AgentMessage): void {
    this.emit({ type: "message_end", message });
  }

  /** Fingerprint the request that is about to be sent (see RequestShape) and
   * report it to the observer. A request is an append-extension of its
   * predecessor when the head (system prompt + tool schemas) is unchanged
   * and the message list starts with exactly the previous one: only then can
   * the provider serve the shared prefix from its cache. A changed head and
   * a rewritten history (compaction, rewind) are the two events that cost
   * the whole cached prefix, and each is reported with its reason. */
  private noteRequest(messages: unknown[]): void {
    if (this.onRequest === undefined) return;
    const headHash = this.headHash();
    const hashes = messages.map((message) => this.messageHash(message));
    const previous = this.previousMessageHashes;
    const previousFold = this.previousMessagesHash;
    const extended = previous !== undefined && isPrefix(previous, hashes);
    let change: RequestShape["change"];
    if (this.previousHeadHash === undefined) change = "initial";
    else if (headHash !== this.previousHeadHash) change = "head-changed";
    else if (!extended) change = "history-rewritten";
    // Fold incrementally: a request is normally its predecessor plus a few
    // messages, so only that tail is folded again.
    let messagesHash: string;
    if (extended && previous !== undefined && previousFold !== undefined) {
      messagesHash = fnv1a(
        previousFold + hashes.slice(previous.length).join(""),
      );
    } else {
      messagesHash = fnv1a(hashes.join(""));
    }
    this.previousHeadHash = headHash;
    this.previousMessageHashes = hashes;
    this.previousMessagesHash = messagesHash;
    this.onRequest({
      headHash,
      messagesHash,
      messageCount: hashes.length,
      ...(change !== undefined ? { change } : {}),
    });
  }

  /** The head hash of the current request (system prompt + tool schemas).
   * Cached by identity: the prompt string and the tools array are replaced
   * only when they actually change, so the hash is computed once per
   * revision instead of once per step. */
  private headHash(): string {
    const cached = this.headFingerprint;
    if (
      cached !== undefined && cached.prompt === this.state.systemPrompt &&
      cached.tools === this.state.tools
    ) {
      return cached.hash;
    }
    const hash = fnv1a(
      `${this.state.systemPrompt}\u0000${canonicalJson(this.state.tools)}`,
    );
    this.headFingerprint = {
      prompt: this.state.systemPrompt,
      tools: this.state.tools,
      hash,
    };
    return hash;
  }

  /** Hash of one wire message. Cached per object: the messages the converter
   * passes through keep their identity between steps, so only the messages
   * derived for this step (a context snapshot, a notification, a checkpoint)
   * are hashed again. */
  private messageHash(message: unknown): string {
    if (message === null || typeof message !== "object") {
      return fnv1a(JSON.stringify(message) ?? "null");
    }
    const key = message as object;
    const cached = this.messageHashes.get(key);
    if (cached !== undefined) return cached;
    const hash = fnv1a(JSON.stringify(message) ?? "null");
    this.messageHashes.set(key, hash);
    return hash;
  }

  /** Loop hygiene: count consecutive calls of the same tool with identical
   * arguments and, at the configured repeat counts, append one advisory
   * reminder — never blocking the call (the DeepSeek Harness's
   * repeat-tool-reminder; a stuck model is nudged to inspect the result it
   * already has and change approach). Runs after the calls' results landed,
   * so the reminder follows them in the transcript and in the next request.
   * Any other call resets the count, and so does a new prompt (see append). */
  private noteToolCalls(calls: readonly ToolCall[]): void {
    let reminder: NotificationMessage | undefined;
    for (const call of calls) {
      const signature = `${call.name}\u0000${canonicalJson(call.arguments)}`;
      this.repeatCount = signature === this.repeatSignature
        ? this.repeatCount + 1
        : 1;
      this.repeatSignature = signature;
      if (REPEAT_REMINDER_AT.includes(this.repeatCount)) {
        reminder = repeatReminder(call, this.repeatCount);
      }
    }
    if (reminder === undefined) return;
    this.state.messages.push(reminder);
    this.announce(reminder);
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
      this.announce(result);
    }
  }
}

/** Consecutive identical tool calls that earn an advisory reminder. The
 * escalation mirrors the DeepSeek Harness's repeat-tool-reminder: a gentle
 * nudge on the third, a detailed one (naming the call and its arguments) on
 * the fifth and eighth. */
const REPEAT_REMINDER_AT: readonly number[] = [3, 5, 8];

/** Characters of the repeated arguments shown by the detailed reminder. */
const REPEAT_ARGUMENTS_PREVIEW = 500;

/** The advisory message for a repeated call (see Agent.noteToolCalls). */
function repeatReminder(call: ToolCall, count: number): NotificationMessage {
  const repeated = `${count} times in a row with identical arguments`;
  const body = count >= REPEAT_REMINDER_AT[1]!
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

/** True when `previous` is a prefix of `current` (same length or shorter,
 * every element equal in order). */
function isPrefix(
  previous: readonly string[],
  current: readonly string[],
): boolean {
  if (previous.length > current.length) return false;
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== current[i]) return false;
  }
  return true;
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
