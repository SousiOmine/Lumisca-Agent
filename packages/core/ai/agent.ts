/**
 * The Lumisca agent runtime: drives an exchange over a {@link StreamFn},
 * executing tool calls itself (so it can emit tool_start/tool_end events and
 * feed tool results back into the LLM), and exposing the small lifecycle the
 * session agent and the sub-agent hub use (prompt / steer / followUp /
 * continue / abort / waitForIdle / subscribe).
 *
 * This file owns the run — its identity, the abort that can outlive a turn,
 * the steer queues, and the exchange loop that ties one turn to the next. What
 * a turn is made of lives beside it (see the imports: the stream in
 * ai/agent-step.ts, the messages in ai/agent-messages.ts, the fallback tool
 * runner in ai/agent-tool-run.ts, the repair after a stop in
 * ai/tool-call-healing.ts, and the loop's two observers in
 * ai/request-shape.ts and ai/repeat-guard.ts).
 *
 * The transport is whatever StreamFn is injected — the real one is
 * Vercel-backed (ai/stream.ts), tests inject a faux (ai/faux.ts).
 */

import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  ToolCall,
  ToolResultMessage,
} from "../domain/message.ts";
import type { Api } from "../domain/model.ts";
import { AgentEvents } from "./agent-events.ts";
import { nextTranscriptTimestamp, normalizeInput } from "./agent-messages.ts";
import type { Turn } from "./agent-step.ts";
import { TurnStream, toolCallsOf } from "./agent-step.ts";
import type { ToolRunHost } from "./agent-tool-run.ts";
import { runToolCalls } from "./agent-tool-run.ts";
import type {
  AgentEvent,
  AgentState,
  AgentTool,
  RequestShape,
} from "./agent-types.ts";
import type { Model, ModelThinkingLevel } from "./catalog.ts";
import { pendingAssistant } from "./message-factory.ts";
import { RepeatGuard } from "./repeat-guard.ts";
import { RequestShapeRecorder } from "./request-shape.ts";
import { healUnansweredToolCalls } from "./tool-call-healing.ts";
import type { StreamFn } from "./transport.ts";

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
  /** Subscribers and the emission they receive (see ai/agent-events.ts). */
  private readonly events = new AgentEvents();
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
  /** The shapes of the requests this agent has sent (see
   * ai/request-shape.ts): every step reports its request here, and the record
   * is what classifies the next one as an append-extension or a rewrite. */
  private readonly requestShapes = new RequestShapeRecorder();
  /** The repeat guard's state (see ai/repeat-guard.ts): the last tool call
   * seen and how many times it has repeated back to back. A new prompt resets
   * it. */
  private readonly repeatGuard = new RepeatGuard();
  /** What the fallback tool runner reads and writes (see
   * ai/agent-tool-run.ts). Functions, not values: the run signal, the
   * transcript and the tool set are all replaced while the agent lives. */
  private readonly toolRun: ToolRunHost = {
    tools: () => this.state.tools,
    signal: () => this.abortController.signal,
    aborted: () => this.abortRequested,
    stale: (id) => this.isStaleRun(id),
    messages: () => this.state.messages,
    nextTimestamp: () => this.nextTimestamp(),
    emit: (event) => this.events.emit(event),
    announce: (message) => this.announce(message),
  };

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
    return this.events.subscribe(fn);
  }

  /** Run a prompt: a string (+images) becomes a user message; a pre-built
   * AgentMessage (notification/mode/user) is used as-is.
   *
   * A healthy run takes the message at its next turn boundary (steer). A run
   * unwinding from an abort never does — its queues are dropped when it
   * settles (the rewind path), so a message queued into it would vanish
   * without a trace — so such a prompt waits for that run to settle and then
   * gets its own. */
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
   * call ends, a tool returns): `exchangeLoop` checks the flag between steps.
   * That alone would not end a run whose tool ignores its abort signal — the
   * loop, the run's promise and `isStreaming` would stay open forever and the
   * session would never accept another prompt — so the run is ALSO closed
   * outside the boundary (see {@link settleAbandonedRun}), and the turn that
   * was in flight is settled whenever its call finally returns.
   *
   * `agent_end` is emitted immediately when a run was live: the session
   * agent's teardown (pending asks, hand-overs) hangs off it, and the
   * client's run state follows it. An idle agent's abort ends no run, so it
   * announces nothing: closing a session aborts one, and a run that ends
   * without ever having started becomes a notification about nothing. */
  abort(): void {
    // Read before settling: settling is what clears the flag.
    const ending = this.state.isStreaming;
    this.abortRequested = true;
    this.abortController.abort();
    this.settleAbandonedRun();
    if (ending) this.events.emit({ type: "agent_end" });
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
   * was stopped before its tool could answer (see ai/tool-call-healing.ts). */
  private healUnansweredToolCalls(): void {
    healUnansweredToolCalls(this.state.messages, {
      nextTimestamp: () => this.nextTimestamp(),
      emit: (event) => this.events.emit(event),
      announce: (message) => this.announce(message),
    });
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
   * `this.running` is the run's promise as the WAITERS see it: it resolves
   * when the run ends, including when abort abandons a turn that never
   * returns (see {@link settleAbandonedRun}). `__run` keeps executing that
   * abandoned turn, but nobody waits on it any more. */
  private async startRun(first?: AgentMessage): Promise<void> {
    const id = ++this.runId;
    const settled = new Promise<void>((resolve) => {
      this.resolveRun = { runId: id, resolve };
    });
    // The run's own promise settles the waiter when it returns normally;
    // an abandoned run was settled by abort already (settleRun is
    // idempotent).
    void this.__run(id, first)
      .catch(() => {})
      .finally(() => this.settleRun(id));
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
      this.events.emit({ type: "agent_start" });

      if (this.steerQueue.length > 0) {
        // A steer that starts its own run was announced by its caller;
        // drain it here as the first turn.
        this.append(this.steerQueue.shift()!);
      }

      await this.exchangeLoop(runId);

      // Drain any steer/followUp messages queued during the run as new turns.
      while (!this.abortRequested && this.steerQueue.length > 0) {
        if (this.closed) break;
        this.append(this.steerQueue.shift()!);
        await this.exchangeLoop(runId);
      }
    } finally {
      // An abandoned run (a tool that did not return) cleared its state and
      // resolved its waiter already: this turn is only now returning.
      if (!this.isStaleRun(runId)) {
        this.state.isStreaming = false;
        this.runningInner = false;
        this.events.emit({ type: "agent_end" });
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
      this.repeatGuard.reset();
    }
    this.state.messages.push(message);
  }

  /** Replace the whole transcript. Used when the view it holds is no longer
   * the right one: a rewind that reached behind the model's view re-reads it
   * from the store. The agent is idle when this happens (the rewinder aborts
   * the run first), so nothing is mid-loop over the old array. */
  replaceMessages(messages: AgentMessage[]): void {
    this.state.messages = messages;
    this.repeatGuard.reset();
  }

  /** The timestamp of the next message this agent appends: strictly
   * increasing, so the transcript's order is also its timestamp order. */
  nextTimestamp(): number {
    return nextTranscriptTimestamp(this.state.messages);
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
   * of the loop and becomes the next turn, so notifications reach the LLM at
   * the next turn boundary instead of only after the whole tool chain. */
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
      this.events.emit({ type: "turn_end", message: assistant });
      const pending = toolCallsOf(assistant);
      if (pending.length === 0) return;
      // Fallback: the SDK did not execute these tool calls (faux provider /
      // test doubles yield no toolcall_result events). Only the missing
      // calls run here — SDK-executed calls already have their results in
      // the transcript and must never run twice.
      const missing = pending.filter((call) => !executedIds.has(call.id));
      if (missing.length > 0) {
        await runToolCalls(this.toolRun, runId, missing);
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
   * tool_execution_start/end events. Returns the turn: its message, and the
   * ids the SDK executed (empty for test doubles that bypass it).
   *
   * ai/agent-step.ts takes the stream's events and assembles the message; the
   * loop that reads the stream stays here because a turn's end must land in
   * the task the provider finished it in. An extra await between the stream's
   * last event and the transcript write would reorder the turn against what
   * arrives with it: the notification that comes with a finished task would
   * open its own run before the turn it followed had ended.
   *
   * A turn whose run was abandoned while it was in flight returns nothing
   * to the transcript: the session already moved on (a new run, or a
   * rewind that deleted the messages this turn would follow), so its
   * assistant message and tool results are dropped and no event is emitted
   * for them. The run's own loop noticed nothing — it is gone. */
  private async step(runId: number): Promise<Turn> {
    const model = this.state.model;
    this.events.emit({
      type: "message_start",
      message: pendingAssistant(model),
    });

    const turnStream = new TurnStream(model, this.events);
    const llmMessages = await this.convertToLlm(this.state.messages);
    this.requestShapes.record(
      { systemPrompt: this.state.systemPrompt, tools: this.state.tools },
      llmMessages as unknown[],
      this.onRequest,
    );
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
      turnStream.handle(event);
    }
    const turn = turnStream.finish();

    // The transcript of an abandoned run is the next run's (or a rewind's):
    // nothing of this turn is written or announced. A turn that merely ENDED
    // at its boundary still lands (see abort).
    if (this.isStaleRun(runId)) return turn;

    // The turn is stamped on its way in, so its messages follow the prompt
    // that started it in time as well as in order (see nextTimestamp).
    const assistant: AssistantMessage = {
      ...turn.assistant,
      timestamp: this.nextTimestamp(),
    };
    this.state.messages.push(assistant);
    const results = turn.results.map(
      (result): ToolResultMessage => ({
        ...result,
        timestamp: this.nextTimestamp(),
      }),
    );
    this.state.messages.push(...results);
    this.state.errorMessage = turn.errorMessage ?? this.state.errorMessage;
    this.events.emit({ type: "message_end", message: assistant });
    // Tool results are transcript messages like any other, so they are
    // announced too — after their assistant message, the order they hold in
    // it. The live UI builds a call's checkmark and its `+N -M` badge from
    // them, and without this those marks wait for the next full re-read.
    for (const result of results) {
      this.announce(result);
    }
    return { ...turn, assistant };
  }

  /** Announce a message this agent appended (see AgentEvents.announce). */
  private announce(message: AgentMessage): void {
    this.events.announce(message);
  }

  /** Append the advisory reminder a repeated tool call earned (see
   * ai/repeat-guard.ts). Runs after the calls' results landed, so the
   * reminder follows them in the transcript and in the next request. */
  private noteToolCalls(calls: readonly ToolCall[]): void {
    const reminder = this.repeatGuard.note(calls);
    if (reminder === undefined) return;
    // Stamped on the way in, like every message this agent appends (see
    // nextTimestamp): the builder has no transcript to look at.
    reminder.timestamp = this.nextTimestamp();
    this.state.messages.push(reminder);
    this.announce(reminder);
  }
}
