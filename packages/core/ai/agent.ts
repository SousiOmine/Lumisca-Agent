/**
 * The Lumisca agent runtime: drives an exchange over a {@link StreamFn},
 * executing tool calls itself (so it can emit tool_start/tool_end events and
 * feed tool results back into the LLM), and exposing the small lifecycle the
 * session agent and the sub-agent hub use (prompt / steer / followUp /
 * continue / abort / waitForIdle / subscribe).
 *
 * The transport is whatever StreamFn is injected — the real one is
 * Vercel-backed (ai/stream.ts), tests inject a faux (ai/faux.ts).
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
import type { NotificationMessage } from "../ai/types.ts";
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
   * ai/context-compaction.ts) rewrites `state.messages` here, so the
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
  /** Identity of the run `__run` is executing (increments per run). A run
   * that was abandoned outside a turn boundary keeps it so its late turn can
   * recognise itself as stale (see {@link abandonedRunId}). */
  private runId = 0;
  /** The run that {@link abort} closed while its turn was still in flight
   * (0 when none). Such a turn may return at any time — or never; nothing it
   * produces may enter the transcript or start another turn, because a
   * newer run (or a rewind) owns the session by then. */
  private abandonedRunId = 0;
  /** Resolves the waiter of the CURRENT run (see {@link startRun}). Called
   * when the run ends on its own and when abort abandons it, whichever
   * comes first. `runId` guards it: a run that was abandoned keeps
   * executing its turn, and its eventual return must not resolve the
   * waiter of a run that started after it. */
  private resolveRun: { runId: number; resolve: () => void } | undefined;
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

  /** Stop the current run.
   *
   * The abort reaches the exchange at its NEXT turn boundary (a provider
   * call ends, a tool returns): `exchangeLoop` checks the flag between
   * steps. That alone is not enough to end a run — a tool that ignores its
   * abort signal would hold the loop, the run's promise and `isStreaming`
   * open forever, and the session would never accept another prompt (see
   * the settle path below). So the run is ALSO closed outside the
   * boundary: the session here is idle-at-the-boundary (`state.isStreaming`
   * is cleared, the queues dropped, `agent_end` emitted) and the turn that
   * was in flight is settled later, whenever its call finally returns.
   *
   * `agent_end` is emitted immediately either way: the session agent's
   * teardown (pending asks, hand-overs) hangs off it, and the client's run
   * state follows it. */
  abort(): void {
    this.abortRequested = true;
    this.abortController.abort();
    this.settleAbandonedRun();
    this.emit({ type: "agent_end" });
  }

  /** Close the session of a run that is being abandoned outside a turn
   * boundary (a tool that will not return). Nothing the in-flight turn
   * produces afterwards may enter the transcript or start another turn — a
   * newer run (or a rewind) owns the session by then — so the turn is
   * marked stale here (see {@link abandonedRunId}).
   *
   * A no-op while the loop is between turns (or idle): the loop itself
   * stops at the next boundary and clears its own state. */
  private settleAbandonedRun(): void {
    if (!this.runningInner || !this.state.isStreaming) return;
    this.abandonedRunId = this.runId;
    this.state.isStreaming = false;
    this.steerQueue.length = 0;
    // The abandoned turn may be holding a tool call that will never write
    // its result. A provider rejects the NEXT request when an assistant
    // message's tool calls have no results (AI_MissingToolResultsError), so
    // the transcript is healed here, while the stop is still ours to
    // record: the calls get a "stopped" result and the UI gets their end
    // events (the tool line's spinner).
    this.healUnansweredToolCalls();
    // The run's promise is settled now, not when the abandoned turn
    // returns: `waitForIdle` and a prompt that waited for the aborted run
    // must proceed, and the tool may never return at all.
    this.runningInner = false;
    this.settleRun(this.abandonedRunId);
    // A prompt that arrives from here on must not wait on (or steer into)
    // the run that is gone: it starts its own.
    this.abortRequested = false;
    this.running = Promise.resolve();
  }

  /** Give every tool call at the transcript's end a result, for a run that
   * was stopped before its tool could answer. Only the trailing assistant
   * message is considered: an earlier turn's calls already have their
   * results (anything else would be a transcript the provider refuses, and
   * rewriting history here would hide the real bug). */
  private healUnansweredToolCalls(): void {
    const messages = this.state.messages;
    let index = messages.length - 1;
    while (index >= 0 && messages[index]!.role === "toolResult") index--;
    const tail = messages[index];
    if (tail === undefined || tail.role !== "assistant") return;
    const answered = new Set<string>();
    for (let i = index + 1; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === "toolResult") answered.add(message.toolCallId);
    }
    const unanswered = (tail.content as ReadonlyArray<{
      type?: string;
      id?: string;
      name?: string;
    }>)
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
        timestamp: this.nextTimestamp(),
      };
      messages.push(result);
      this.emit({
        type: "tool_execution_end",
        toolCallId: call.id!,
        toolName: call.name ?? "",
      });
      this.announce(result);
    }
  }

  /** Whether the turn running under `runId` belongs to a run this agent has
   * already abandoned: its results are not history the session wants. */
  private isStaleRun(runId: number): boolean {
    return this.abandonedRunId === runId;
  }

  /** Resolve the waiter of `runId`, once per run. Called by the run's own
   * end and by abort, which may come first — whichever runs first wins; the
   * other is a no-op. A stale run (one that was abandoned) resolves nothing:
   * the waiter belongs to the run that replaced it. */
  private settleRun(runId: number): void {
    const waiter = this.resolveRun;
    if (waiter === undefined || waiter.runId !== runId) return;
    this.resolveRun = undefined;
    waiter.resolve();
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
    // Tools that hold process-level resources (the eval sandbox's timers)
    // release them here: the agent is the owner, and a closed agent is
    // never resumed.
    for (const tool of this.state.tools) {
      try {
        tool.dispose?.();
      } catch {
        // A failing dispose must not stop the rest of the teardown.
      }
    }
  }

  /** Start (or continue) an exchange, empty the steer queue as it goes.
   *
   * The promise `this.running` is the run's promise as the WAITERS see it:
   * it resolves when the run ends, including when abort abandons a turn
   * that never returns (see {@link settleAbandonedRun}). `__run` keeps
   * executing that abandoned turn, but nobody waits on it any more. */
  private async startRun(first?: AgentMessage): Promise<void> {
    const id = ++this.runId;
    const settled = new Promise<void>((resolve) => {
      this.resolveRun = { runId: id, resolve };
    });
    // The run's own promise settles the waiter when it returns normally;
    // an abandoned run was settled by abort already (settleRun is
    // idempotent).
    void this.__run(id, first).catch(() => {}).finally(() =>
      this.settleRun(id)
    );
    this.running = settled;
    await settled;
  }

  private async __run(runId: number, first?: AgentMessage): Promise<void> {
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

      await this.exchangeLoop(runId);

      // Drain any steer/followUp messages queued during the run as new turns.
      while (!this.abortRequested && this.steerQueue.length > 0) {
        if (this.closed) break;
        const next = this.steerQueue.shift()!;
        this.append(next);
        await this.exchangeLoop(runId);
      }
    } finally {
      // A run that was abandoned mid-turn (a tool that did not return) has
      // already had its state cleared and its waiter resolved by abort: the
      // turn is only now returning, and it owns nothing.
      if (!this.isStaleRun(runId)) {
        this.state.isStreaming = false;
        this.runningInner = false;
        this.emit({ type: "agent_end" });
      }
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

  /** The timestamp of the next message this agent appends. Strictly
   * increasing, so the transcript's order is also its timestamp order: the
   * clients keep a window of the transcript, identify messages by role +
   * timestamp and drop a live message older than their newest one (see web's
   * applyMessage), while the window merge anchors on those identities.
   *
   * The clock alone is not enough. A prompt-side message and the context
   * snapshots published just before it can share a millisecond, and the
   * transport stamps the assistant message when the stream finalizes —
   * sometimes BEFORE the tool results it just produced. Inheriting the
   * previous message's stamp fixes both without inventing a virtual clock:
   * the transcript already knows the order it wants. */
  nextTimestamp(): number {
    const previous = this.state.messages.at(-1)?.timestamp ?? 0;
    return Math.max(Date.now(), previous + 1);
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
  private async exchangeLoop(runId: number): Promise<void> {
    for (;;) {
      if (this.abortRequested || this.isStaleRun(runId)) return;
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
        if (this.abortRequested || this.isStaleRun(runId)) return;
      }
      const { assistant, executedIds } = await this.step(runId);
      // An abandoned run's turn may return long after the session moved on
      // (or never): what it produced is not history this transcript wants,
      // and no further turn of it may start.
      if (this.abortRequested || this.isStaleRun(runId)) return;
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
        await this.executeTools(runId, missing);
      }
      // Advisory loop hygiene, after the calls' results landed (so the
      // reminder is the last thing the model reads before the next request).
      this.noteToolCalls(pending);
      if (this.abortRequested || this.isStaleRun(runId)) return;
    }
  }

  /** One LLM call: stream a single turn (the SDK executes the turn's tool
   * calls via their execute functions) and record the resulting
   * AssistantMessage, emitting message_start/deltas/message_end and
   * tool_execution_start/end events. Returns the assistant message plus
   * the ids the SDK executed (empty for test doubles that bypass it).
   *
   * A turn whose run was abandoned while it was in flight returns nothing
   * to the transcript: the session already moved on (a new run, or a
   * rewind that deleted the messages this turn would follow), so its
   * assistant message and tool results are dropped and no event is emitted
   * for them. The run's own loop noticed nothing — it is gone. */
  private async step(runId: number): Promise<{
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
    // assistant(toolCalls) → toolResults — the order providers expect. The
    // timestamp is missing on purpose: it is stamped when the buffer is
    // flushed into the transcript (see below), after the assistant message it
    // must follow.
    const pendingResults: Omit<ToolResultMessage, "timestamp">[] = [];

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

    // The run was abandoned while this turn was in flight (a tool that did
    // not return, a stream the provider kept open past the stop button): the
    // transcript already belongs to the next run or to a rewind, so nothing
    // of this turn is written or announced. A turn that merely ENDED because
    // the stop reached its boundary still lands (see abort: it heals the
    // unmet tool calls as part of the stop).
    if (this.isStaleRun(runId)) {
      return { assistant: final!, executedIds };
    }

    // The assistant message and its tool results enter the transcript here,
    // so they are stamped here too: the turn's own messages must follow the
    // prompt that started it, and each result must follow the assistant
    // message it belongs to (a stream can finalize the answer after the
    // results finished, which the transport's own stamping did not account
    // for). Order and timestamps describe the same transcript; the clients
    // keep a window and identify messages by role + timestamp (see
    // MessageIdentity, and web's applyMessage / mergeNewestWindow).
    final = { ...final!, timestamp: this.nextTimestamp() };
    this.state.messages.push(final);
    const results = pendingResults.map((result): ToolResultMessage => ({
      ...result,
      timestamp: this.nextTimestamp(),
    }));
    this.state.messages.push(...results);
    this.state.errorMessage = errorMessage ?? this.state.errorMessage;
    this.emit({ type: "message_end", message: final });
    // The turn's tool results are messages of the transcript like any
    // other, so they are announced too — after their assistant message, the
    // order they hold in the transcript. The live UI pairs each result with
    // its call (the tool line's checkmark and its `+N -M` badge are built
    // from the toolResult message); without this announcement those marks
    // only appear when the view happens to re-read the transcript snapshot
    // (a reload, a WS reconnect, or a return to the foreground).
    for (const result of results) {
      this.announce(result);
    }
    return { assistant: final, executedIds };
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
    // Stamped on the way in, like every message this agent appends (see
    // nextTimestamp): the builder has no transcript to look at.
    reminder.timestamp = this.nextTimestamp();
    this.state.messages.push(reminder);
    this.announce(reminder);
  }

  /** Fallback: execute tool calls the SDK did not run. Only test doubles
   * (faux provider) that bypass the SDK's tool loop reach here — the real
   * Vercel transport executes via the tools' execute functions. Runs under
   * the run's identity like `step`: a call that returns after its run was
   * abandoned must not write its result into a transcript that moved on. */
  private async executeTools(
    runId: number,
    toolCalls: ToolCall[],
  ): Promise<void> {
    for (const call of toolCalls) {
      if (this.abortRequested || this.isStaleRun(runId)) return;
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
      // The end event above tells a live client the line's spinner is done;
      // the RESULT itself is dropped when the run was abandoned while the
      // call ran (see isStaleRun) — the transcript may already belong to a
      // newer run or a rewind.
      if (this.isStaleRun(runId)) return;
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
        timestamp: this.nextTimestamp(),
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
