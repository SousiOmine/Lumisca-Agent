import { Agent } from "../ai/agent.ts";
import type { RequestShape } from "../ai/agent-types.ts";
import type { Model } from "../ai/catalog.ts";
import type { CompactionStyle } from "../ai/compaction-style.ts";
import type { CompactionResult } from "../ai/context-compaction.ts";
import type { ContextProvider } from "../ai/context-providers.ts";
import type { StreamFn } from "../ai/transport.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { AgentMessage, ImageContent } from "../domain/message.ts";
import type { ModePrompt } from "../domain/mode-message.ts";
import type { Api } from "../domain/model.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { Tool } from "../ports/tool.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { PendingShareRequest, ShareRequestHub } from "../share/request.ts";
import type { AskAnswer, PromptFileRef, ThinkingLevel } from "../shared/mod.ts";
import { DEFAULT_LOCALE, type Locale } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import type { AskHub, PendingQuestion } from "../tools/ask.ts";
import type { BackgroundProcessManager } from "../tools/background.ts";
import { toAgentTool } from "../tools/pi-adapter.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import type { TaskHub } from "../tools/task-hub.ts";
import type { EnvRequestHub, PendingEnvRequest } from "../vm/env-request.ts";
import type { HandoverHub, PendingHandover } from "../vm/handover.ts";
import type { IdleCompaction } from "./compaction-controller.ts";
import { ContextPublisher } from "./context-publisher.ts";
import { ImageAnalyzer } from "./image-analysis.ts";
import { InterruptionHub } from "./interruption-hub.ts";
import { McpAttachmentHost } from "./mcp-host.ts";
import { RetryManager } from "./retry-manager.ts";
import { Rewinder } from "./rewinder.ts";
import { SessionCompaction } from "./session-compaction.ts";
import { SessionEvents } from "./session-events.ts";
import { SessionLlmView } from "./session-llm-view.ts";
import { SessionRuns } from "./session-runs.ts";
import { SessionTurn } from "./session-turn.ts";
import { TitleGenerator } from "./title-generation.ts";
import { TitleScheduler } from "./title-scheduler.ts";
import { TranscriptStore } from "./transcript.ts";

export interface SessionAgentOptions {
  sessionId: string;
  /** The agent whose transcript this session persists (see
   * session/agents.ts): the session's main agent. Events address the SESSION
   * — a client opens and reads a session — so this id reaches only the
   * message store. */
  agentId: string;
  systemPrompt: string;
  model: Model<Api>;
  tools: Tool[];
  messages?: AgentMessage[];
  /** The whole-transcript position `messages[0]` sits at: the agent holds the
   * MODEL's view (the newest compaction checkpoint onward), not the whole
   * conversation. Operations expressed in whole-transcript positions — a
   * compaction's cut, a rewind's target — are translated by TranscriptStore.
   * Omitted → 0 (a conversation that was never compacted). */
  baseIndex?: number;
  /** Reasoning level for every run of this session ("off" = no thinking). */
  thinkingLevel?: ThinkingLevel;
  streamFn: StreamFn;
  messageRepo: MessageRepo;
  onEvent: (event: ClientEvent) => void;
  /** The configured image-analysis model: interprets images as text when
   * `model` cannot see them (see ImageAnalyzer). */
  imageAnalysisModel?: Model<Api>;
  /** The configured fast model: generates the session title from the
   * first user message (see TitleGenerator). */
  fastModel?: Model<Api>;
  /** Whether the first prompt names the session (see TitleScheduler).
   * Omitted → yes. A stella conversation's name is its agent's, which the
   * user chose: a generated title would contradict the header and cost a
   * request per agent to do it. */
  titleGeneration?: boolean;
  /** Read the card being written into a reply out of the text as it
   * streams, and publish it as `ui_delta`. A stella conversation's clients
   * never receive that text (its reply arrives whole), so the card has to be
   * extracted here; code mode's client has the text and cuts the card out
   * where it draws. Omitted → false. */
  uiFromText?: boolean;
  /** Background-command manager backing the async_bash tools. Its
   * completion events are injected into the agent loop as notifications
   * (see notifyBackgroundCommand). */
  backgroundManager?: BackgroundProcessManager;
  /** Question hub backing the ask tool (one per session): registers the
   * questions the agent asks and resolves them with the user's answers. */
  askHub: AskHub;
  /** Handover hub backing the screen hand-over (`vm_ask_user`, one per
   * session): blocks the run while the user drives the machine, and is
   * torn down with it. */
  handoverHub?: HandoverHub;
  /** Request hub backing `vm_env` (one per session): blocks the run while
   * the user types a secret into the dialog. Torn down with the run, like
   * the hand-over. */
  envRequestHub?: EnvRequestHub;
  /** Request hub backing `share_request` / `share_disconnect` (one per
   * session): blocks the run while the user is asked to lend a folder, and
   * for seconds while their computer withdraws one. Torn down with the run,
   * like the other waits. */
  shareRequestHub?: ShareRequestHub;
  /** Task hub backing the task / task_output / send_message tools. The
   * agent registers itself as the delivery target for sub-agent completion
   * notifications and messages (see setParentDelivery). */
  taskHub?: TaskHub;
  /** Persist a new session title (also notifies clients). */
  renameSession: (name: string) => void;
  /** Backoff sleep used before a rate-limit (429) restart, injectable for
   * tests; defaults to sleepAbortable (real exponential backoff). */
  rateLimitRetrySleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The session's tool registries (owned by the session pool). When set,
   * their tools are never preloaded into the LLM context — the pool seeds
   * them with browser-lab tools, MCP discovery fills them, and the agent
   * only gets the tool_search / tool_call pair over `main`, so the
   * request's tool definitions stay small and stable. Omitted → no
   * discoverable tools (the pair is not built). */
  toolRegistry?: SessionToolRegistries;
  /** Whether the model calls tools from code (see AgentFactory). Omitted →
   * false: the tool_search / tool_call pair is attached to the agent as
   * before. When true the pair stays out of the agent — the catalog that
   * `execute` runs tools from carries tool_search instead. */
  codeExecution?: boolean;
  /** The app language of this agent: the language of the text the core
   * writes into the transcript (compaction checkpoints) and
   * of the session's title. The pool passes the setting read when the
   * agent was built; omitted → the catalogue's fallback language. The
   * session's PROMPT language is decided separately, when the prompt is
   * generated (see core.ts). */
  language?: Locale;
  /** Dynamic context providers (skill catalog, workspace instructions).
   * Their updates are published as durable `context` messages before a run
   * starts, and republished only when the value changed (see
   * publishContexts). Omitted → no dynamic context. */
  contextProviders?: ContextProvider[];
  /** The compaction tuning read from the settings store (see
   * shared/settings-keys.ts). Read on every check, so a settings change
   * applies without rebuilding the agent; omitted → the compactor's
   * defaults. */
  compactionPolicy?: () => CompactionPolicyInput;
  /** What a compaction's summary is made of and what it is asked to be (see
   * ai/compaction-style.ts). stella sessions use the conversation record
   * (agent/stella-compaction.ts); every other session the work log. */
  compactionStyle: CompactionStyle;
  /** Re-derive the session's system prompt and return it. Called after a
   * compaction, the one point where the history behind the prompt is
   * replaced anyway; everywhere else the prompt stays fixed because it is
   * the prefix the provider caches. Omitted → the prompt stays as built (a
   * hand-built agent in a test). */
  refreshSystemPrompt?: () => string;
  /** The rule that condenses this conversation while it sits idle (see
   * compactAfterIdle). Omitted → the history is condensed only when a
   * request would approach the window. stella's conversations are the ones
   * that live for weeks, so they are the ones that set it. */
  idleCompaction?: IdleCompaction;
  /** Whether rows behind a compaction checkpoint lose their payload once the
   * checkpoint covers them (see session/prune.ts). A predicate rather than a
   * value: the answer is a setting (STELLA_KEEP_FULL_LOG_KEY) the user can
   * change while the conversation is open, and a value captured at build
   * time would leave a running conversation on the old answer until it was
   * reopened.
   *
   * Asked only for a stella conversation, whose transcript is the record of
   * a conversation that lives for years. When it says yes, only what the
   * conversation shows is kept; when no, the work rows stay as written — the
   * record of what the model was sent and what it produced. Code mode's work
   * log IS a surface, so its rows are never reduced.
   *
   * Omitted → never reduces. */
  shouldPruneCondensed?: () => boolean;
  /** Called with the number of bytes a prune freed in the store. The pool
   * accumulates them and records that the database file is worth rewriting
   * at the next start (see db/vacuum.ts). Omitted → the figure is dropped. */
  onFreedBytes?: (bytes: number) => void;
  /** Called for every request the agent loop sends, with the shape the
   * provider sees (see RequestShape). The pool records the shapes that cost
   * the prompt cache; omitted → nothing is observed. */
  onRequestShape?: (shape: RequestShape) => void;
}
/**
 * One live agent session: wraps the Agent, forwards UI events,
 * and persists new messages to the database as they complete.
 *
 * The session owns the state a run needs — the transcript store, the retry
 * budgets, the rewind, the MCP attachment, the interruptions — and hands each
 * concern that has its own rules to a coordinator: SessionRuns starts (and
 * retries) runs, SessionEvents publishes them, SessionCompaction condenses the
 * history behind them.
 */
export class SessionAgent {
  readonly sessionId: string;
  /** The transcript this agent owns (see SessionAgentOptions.agentId). */
  readonly agentId: string;
  readonly agent: Agent;
  /** The rows this session owns in the messages table, and how many leading
   * transcript messages they cover (see transcript.ts). */
  private readonly transcript: TranscriptStore;
  /** The tool names this session was built with (see the `toolNames`
   * accessor). */
  private readonly toolNamesOfSession: string[];
  /** The session's MCP attachment: its servers gate the first prompt, and
   * its tools land in the session's shared registry once discovery finished. */
  private mcp: McpAttachmentHost;
  /** The session's tool registries (owned by the session pool): the main
   * agent's and its sub-agents', holding every discoverable tool (MCP
   * tools, browser-lab tools, future extensions) whose definitions stay out
   * of the LLM context. Null when the session has none. The pool seeds them
   * before building the agent; MCP discovery merges its tools in
   * afterwards. This agent searches `main` only. */
  private readonly toolRegistry: SessionToolRegistries | null;
  /** The transcript as the model reads it (checkpoint view, notification
   * messages, image analysis — see SessionLlmView). */
  private readonly llmView: SessionLlmView;
  /** Generates the session title from the first user message (null when
   * no fast model is configured). */
  private readonly titleScheduler: TitleScheduler;
  /** The app language this agent was built with: the language of the text
   * the core generates into the transcript (compaction
   * checkpoints) and of the session's title (see SessionAgentOptions). */
  private readonly language: Locale;
  /** The rewind currently running (abort + truncation), if any. Prompts
   * delivered while it runs wait for it: the truncation removes everything
   * from the rewound message onward, so a run started in between would have
   * its messages deleted again (and a steer into the dying run would be
   * dropped with the queues). */
  private readonly rewinder: Rewinder;
  /** Owns the vacant-response / rate-limit retry state (budgets, parked
   * restarts, abort epochs). */
  private readonly retry: RetryManager;
  /** Condenses the history (see SessionCompaction). */
  private readonly compaction: SessionCompaction;
  private readonly renameSession: (name: string) => void;
  /** The ask questions and the screen hand-over: both are released when the
   * run ends (see InterruptionHub). */
  private readonly interruptions: InterruptionHub;
  /** Task hub backing the task / task_output / send_message tools; this
   * agent is its delivery target for sub-agent notifications while the
   * session is open (deregistered on close). */
  private readonly taskHub: TaskHub | null;
  /** Background-command manager (null when the async_bash tools are not
   * built for this session). */
  private readonly backgroundManager: BackgroundProcessManager | null;
  private readonly backgroundUnsubscribe: (() => void) | null;
  /** Dynamic context providers (skill catalog, workspace instructions) and
   * the messages they publish (see context-publisher.ts). */
  private readonly contexts: ContextPublisher;
  /** Set by close(): completion notifications of killed background
   * commands must not reach the discarded agent. */
  private closed = false;
  /** The prompt paths (see SessionRuns). */
  private readonly runs: SessionRuns;
  /** What a turn boundary decides: the app-card take-back, the retry
   * classification and the restart chain (see SessionTurn). */
  private readonly turn: SessionTurn;
  /** The publication of the agent's events (see SessionEvents). */
  private readonly events: SessionEvents;

  /** Whether rows behind a checkpoint lose their payload (see
   * SessionAgentOptions.shouldPruneCondensed). */
  private readonly shouldPruneCondensed: () => boolean;
  /** What a prune freed in the store (see SessionAgentOptions.onFreedBytes). */
  private readonly onFreedBytes: ((bytes: number) => void) | undefined;

  constructor(options: SessionAgentOptions) {
    this.sessionId = options.sessionId;
    this.agentId = options.agentId;
    this.transcript = new TranscriptStore(
      options.agentId,
      options.messageRepo,
      options.messages?.length ?? 0,
      options.baseIndex ?? 0,
    );
    this.toolRegistry = options.toolRegistry ?? null;
    this.renameSession = options.renameSession;
    this.interruptions = new InterruptionHub(
      options.askHub,
      options.handoverHub ?? null,
      options.envRequestHub ?? null,
      options.shareRequestHub ?? null,
    );

    // A vision-capable main model passes images through as-is; only a
    // text-only model with an analysis model configured needs rewriting.
    this.llmView = new SessionLlmView(
      options.imageAnalysisModel !== undefined &&
        !(options.model.input ?? []).includes("image")
        ? new ImageAnalyzer(options.imageAnalysisModel, options.streamFn)
        : null,
    );
    const titleGenerator =
      options.fastModel !== undefined && options.titleGeneration !== false
        ? new TitleGenerator(options.fastModel, options.streamFn)
        : null;
    this.language = options.language ?? DEFAULT_LOCALE;
    this.titleScheduler = new TitleScheduler({
      titleGenerator,
      language: this.language,
      renameSession: this.renameSession,
      hasNoPersistedMessages: () => this.transcript.persistedCount === 0,
    });
    this.retry = new RetryManager(options.rateLimitRetrySleep);
    this.backgroundManager = options.backgroundManager ?? null;
    this.backgroundUnsubscribe =
      this.backgroundManager === null
        ? null
        : this.backgroundManager.onExit((done) => {
            this.runs.notifyBackgroundCommand(done);
          });
    this.taskHub = options.taskHub ?? null;
    this.taskHub?.setParentDelivery({
      isActive: () => !this.closed,
      deliver: (payload) => this.runs.injectNotification(payload),
    });

    this.toolNamesOfSession = options.tools.map((tool) => tool.name);
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: options.tools.map(toAgentTool),
        messages: options.messages ?? [],
        thinkingLevel: options.thinkingLevel ?? "off",
      },
      streamFn: options.streamFn,
      sessionId: options.sessionId,
      convertToLlm: (messages) => this.llmView.convert(messages),
      beforeStep: (signal) => this.compaction.beforeStep(signal),
      ...(options.onRequestShape !== undefined
        ? { onRequest: options.onRequestShape }
        : {}),
    });
    this.rewinder = new Rewinder({
      agent: this.agent,
      transcript: this.transcript,
      retry: this.retry,
      isStreaming: () => this.isStreaming,
      abort: () => this.abort(),
      rebaseContexts: (messages) => this.contexts.rebase(messages),
      emit: (event) =>
        this.events.emit({
          type: event.type,
          sessionId: this.sessionId,
          removed: event.removed,
        }),
    });
    this.mcp = new McpAttachmentHost(
      this.agent,
      this.toolRegistry,
      () => this.closed,
      options.codeExecution === true,
    );
    this.compaction = new SessionCompaction(
      {
        sessionId: this.sessionId,
        messages: () => this.agent.state.messages,
        systemPrompt: () => this.agent.state.systemPrompt,
        tools: () => this.agent.state.tools,
        transcript: this.transcript,
        rebaseContexts: (messages) => this.contexts.rebase(messages),
        publishContexts: () => this.contexts.publish(),
        emit: (event) => this.events.emit(event),
        setSystemPrompt: (prompt) => {
          this.agent.state.systemPrompt = prompt;
        },
        shouldPruneCondensed: () => this.shouldPruneCondensed(),
        freedBytes: (bytes) => this.onFreedBytes?.(bytes),
        isClosed: () => this.closed,
        isStreaming: () => this.isStreaming,
      },
      {
        model: options.model,
        streamFn: options.streamFn,
        style: options.compactionStyle,
        language: this.language,
        policy: options.compactionPolicy,
        idle: options.idleCompaction ?? null,
        refreshSystemPrompt: options.refreshSystemPrompt,
      },
    );
    this.shouldPruneCondensed = options.shouldPruneCondensed ?? (() => false);
    this.onFreedBytes = options.onFreedBytes;
    this.contexts = new ContextPublisher(options.contextProviders ?? [], {
      append: (message) => this.agent.appendMessage(message),
      announce: (message) => this.events.announce(message),
      nextTimestamp: () => this.agent.nextTimestamp(),
      isClosed: () => this.closed,
    });
    this.turn = new SessionTurn({
      sessionId: this.sessionId,
      agent: this.agent,
      transcript: this.transcript,
      retry: this.retry,
      compaction: this.compaction,
      language: this.language,
      isClosed: () => this.closed,
      emit: (event) => this.events.emit(event),
      endTextUi: () => this.events.endTextUi(),
    });
    this.runs = new SessionRuns({
      sessionId: this.sessionId,
      agent: this.agent,
      transcript: this.transcript,
      rewinder: this.rewinder,
      retry: this.retry,
      titleScheduler: this.titleScheduler,
      mcp: this.mcp,
      turn: this.turn,
      publishContexts: () => this.contexts.publish(),
      rebaseContexts: (messages) => this.contexts.rebase(messages),
      isClosed: () => this.closed,
      isStreaming: () => this.isStreaming,
      emit: (event) => this.events.emit(event),
      announce: (message) => this.events.announce(message),
    });
    this.events = new SessionEvents(
      {
        sessionId: this.sessionId,
        agent: this.agent,
        transcript: this.transcript,
        compaction: {
          armIdle: () => this.compaction.armIdle(),
          disarmIdle: () => this.compaction.disarmIdle(),
        },
        interruptions: { endRun: () => this.interruptions.endRun() },
        runs: {
          discardBrokenAppCard: (message) =>
            this.turn.discardBrokenAppCard(message),
          routineSaidNothing: (messages) =>
            this.runs.routineSaidNothing(messages),
          reportModelError: (message) => this.turn.reportModelError(message),
          turnEnded: (message) => this.turn.turnEnded(message),
        },
        isClosed: () => this.closed,
      },
      options.onEvent,
      options.uiFromText === true,
    );
    // Reopening a conversation is the repair point for a process that died
    // between a checkpoint's insertion and its prune: the store is asked to
    // reduce what is behind the checkpoint, and a row already reduced is
    // left alone.
    this.compaction.pruneCondensedRows();
    this.contexts.rebase(this.agent.state.messages);
    this.events.listen();
    // A conversation reopened after a long silence is condensed right away
    // (the gap started before this process opened it); otherwise the timer
    // is armed for the first run's end.
    this.compaction.armIdle();
  }

  /** The idle-compaction rule of this conversation (see
   * CompactionController); null → the idle path is off. */
  get idleCompaction(): IdleCompaction | null {
    return this.compaction.idle;
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /** The names of the tools this session was built with. The prompt no
   * longer names its tools (see tools/system-prompt.ts), so this is the only
   * way to ask a live session what it can do. */
  get toolNames(): string[] {
    return this.toolNamesOfSession;
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /** The whole-transcript position this agent's first in-memory message sits
   * at (0 for a conversation that was never compacted). The conversation a
   * reader pages through is longer than this view; see session/messages.ts. */
  get baseIndex(): number {
    return this.transcript.baseIndex;
  }

  /** How many of the view's messages have a row. A run appends its prompt
   * before writing it, so the difference is what a snapshot during a run
   * must add from memory (see LumiscaCore.readTranscript). */
  get persistedCount(): number {
    return this.transcript.persistedCount;
  }

  /** Update the reasoning level used from the next run onward. The
   * in-flight run (if any) keeps the level it started with: the agent
   * snapshots `thinkingLevel` into the loop config at run start, so
   * mutating the state mid-run never affects the current turn — only
   * subsequent prompts. Rebuilding the agent is therefore unnecessary,
   * and changing the level never throws `conflict` while streaming. */
  setThinkingLevel(level: ThinkingLevel): void {
    this.agent.state.thinkingLevel = level;
  }

  /** Run a prompt to completion (see SessionRuns.prompt). */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    await this.runs.prompt(text, images);
  }

  /** Run a routine's prompt to completion and report how it went (see
   * SessionRuns.runRoutine: what a routine's prompt carries, and why). */
  async runRoutine(
    text: string,
    routine: { id: string; name: string },
  ): Promise<{ failure: string | null }> {
    return await this.runs.runRoutine(text, routine);
  }

  /** The routine whose run is in flight, or null. */
  runningRoutineId(): string | null {
    return this.runs.runningRoutineId();
  }

  /** Send a user prompt even while a run is active: an active run takes it
   * as a steer at the next turn boundary (see SessionRuns.promptWhileRunning). */
  promptWhileRunning(
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    routine?: string,
    files?: PromptFileRef[],
    modelOnly?: string,
  ): void {
    this.runs.promptWhileRunning(text, images, mode, routine, files, modelOnly);
  }

  /** Start stella's setup turn: a prompt only the MODEL reads (see
   * SessionRuns.startOnboarding). */
  startOnboarding(instruction: string): void {
    this.runs.startOnboarding(instruction);
  }

  abort(): void {
    this.interruptions.endRun();
    this.retry.abort();
    this.agent.abort();
  }

  /** Resolve a pending ask (the ask tool) with the user's answers, letting
   * the blocked run continue. The answers are validated against the
   * pending questions; throws when the ask is gone or malformed. */
  answerQuestion(toolCallId: string, answers: AskAnswer[]): void {
    this.interruptions.answerQuestion(toolCallId, answers);
  }

  /** The hand-over this session is still waiting on, for the resync
   * snapshot: `handover` events are never replayed, so a client that
   * (re)connects while the run is blocked on the screen has no other way
   * to learn that it may take over. */
  getPendingHandover(): PendingHandover | null {
    return this.interruptions.pendingHandover();
  }

  /** Let the blocked run continue after the user finished at the screen.
   * Throws when nothing is waiting (the HTTP layer answers 409). */
  finishHandover(note: string, toolCallId?: string): void {
    this.interruptions.finishHandover(note, toolCallId);
  }

  /** The environment variable this session is still waiting for, for the
   * resync snapshot: `env_request` events are never replayed, so a client
   * that (re)connects while the run is blocked on the dialog has no other
   * way to learn that it may answer it. */
  getPendingEnvRequest(): PendingEnvRequest | null {
    return this.interruptions.pendingEnvRequest();
  }

  /** The folder this session is still waiting on, for the resync snapshot:
   * `share_request` events are never replayed, so a client that (re)connects
   * while the run is blocked on the card has no other way to learn that it
   * may answer it. */
  getPendingShareRequest(): PendingShareRequest | null {
    return this.interruptions.pendingShareRequest();
  }

  /** The questions this session is still waiting on (the ask tool), for the
   * resync snapshot: `question` events are never replayed, so a client that
   * (re)connects while the run is blocked on an ask has no other way to
   * learn about it — and the run stays blocked until someone answers. */
  getPendingQuestions(): PendingQuestion[] {
    return this.interruptions.pendingQuestions();
  }

  /** Undo the transcript from a user message onward, aborting the run first
   * (see Rewinder.rewind: the cut, the queues and the notice are there).
   * Prompts that arrive while the rewind runs wait for it. */
  async rewind(timestamp: number): Promise<void> {
    await this.rewinder.rewind(timestamp);
  }

  /** Abort the run and unsubscribe from background-command completions.
   * Background commands themselves are stopped by the session pool when
   * the session closes — they survive agent rebuilds (model/workspace
   * changes) while the session is open. The MCP attachment likewise stays
   * with the pool (its server processes serve the sub-agents too). */
  close(): void {
    this.closed = true;
    this.compaction.disarmIdle();
    this.interruptions.endRun();
    this.retry.abort();
    this.agent.abort();
    this.backgroundUnsubscribe?.();
    this.taskHub?.setParentDelivery(null);
  }

  /** Live MCP server status of this session (null when no MCP config or
   * the manager has not started yet). */
  getMcpStatus(): McpServerStatus[] | null {
    return this.mcp.status();
  }

  /** Attach the session's shared MCP attachment (owned by the session
   * pool; its server processes also serve the sub-agents). The returned
   * promise resolves when discovery finished, so the first prompt can wait
   * for it. Config errors are reported by the pool, never here. */
  attachMcp(attachment: McpAttachment): Promise<void> {
    return this.mcp.attach(attachment);
  }

  /** Move this agent to the session's current MCP attachment after a config
   * change the pool could not express as a rebuild (see McpAttachmentHost). */
  replaceMcpAttachment(attachment: McpAttachment): void {
    this.mcp.replace(attachment);
  }

  /** Attach the tool_search / tool_call pair if the session's registry now
   * holds tools and this agent does not have the pair yet. Called after a
   * capability reseed that filled an empty registry (see
   * AgentFactory.reseedDiscoverable). */
  ensureSearchTools(): void {
    this.mcp.ensureSearchTools();
  }

  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
  }

  /** Condense the history on demand (the manual `/compact` path). Resolves
   * with what was summarized, or undefined when no safe span existed or the
   * summarization failed — the transcript is then unchanged either way. */
  compactNow(instructions?: string): Promise<CompactionResult | undefined> {
    return this.compaction.compactNow(instructions);
  }
}
