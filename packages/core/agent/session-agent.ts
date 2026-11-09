import { Agent } from "../ai/agent.ts";
import type {
  AgentEvent,
  AgentMessage,
  Api,
  AssistantMessage,
  CheckpointMessage,
  ImageContent,
  Message,
  Model,
  RequestShape,
  StreamFn,
  TextContent,
} from "../ai/types.ts";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { RetryManager } from "./retry-manager.ts";
import { GoalRunner } from "./goal-runner.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { MessageRepo } from "../session/messages.ts";
import { TranscriptStore } from "./transcript.ts";
import { messageIdentityOf } from "../session/transcript-window.ts";
import type { PromptFileRef, ThinkingLevel } from "../shared/mod.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import { McpAttachmentHost } from "./mcp-host.ts";
import { Rewinder } from "./rewinder.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { Tool } from "../tools/schema.ts";
import { toAgentTool } from "../tools/pi-adapter.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import type { AskHub, PendingQuestion } from "../tools/ask.ts";
import { InterruptionHub } from "./interruption-hub.ts";
import type { HandoverHub, PendingHandover } from "../vm/handover.ts";
import type { AskAnswer } from "../shared/mod.ts";
import {
  DEFAULT_LOCALE,
  type Locale,
  textWithFileNotice,
  translate,
} from "../shared/mod.ts";
import type {
  BackgroundCommandDone,
  BackgroundProcessManager,
} from "../tools/background.ts";
import { formatBackgroundNotification } from "../tools/background.ts";
import { notificationMessage } from "../domain/notification.ts";
import type { TaskHub } from "../tools/task-hub.ts";
import type { NotificationPayload } from "../domain/notification.ts";
import { toLlmMessages } from "../domain/notification.ts";
import type { ContextProvider } from "../ai/context-providers.ts";
import { contextMessage } from "../ai/context-providers.ts";
import type { ModePrompt } from "../domain/mode-message.ts";
import { buildModeMessage } from "../domain/mode-message.ts";
import { ImageAnalyzer } from "./image-analysis.ts";
import { TitleGenerator } from "./title-generation.ts";
import { TitleScheduler } from "./title-scheduler.ts";
import { type RoutineDropHost, RoutineRun } from "./routine-run.ts";
import { CardStreams, translateRunEvent } from "./run-events.ts";
import type { GoalInfo } from "../shared/goal.ts";
import type { GoalStore } from "../goal/loop.ts";
import {
  type CompactionResult,
  contextStart,
} from "../ai/context-compaction.ts";
import type { CompactionStyle } from "../ai/compaction-style.ts";
import {
  CompactionController,
  type IdleCompaction,
} from "./compaction-controller.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import { ROUTINE_SILENCE_GUIDANCE } from "./routine-guidance.ts";

/** Module logger (debug-gated): title-generation misses and other
 * best-effort failures land here instead of vanishing silently. */
const log = createLogger("session-agent");

/** `text` with `part` after it, separated by a blank line; undefined when
 * there is nothing to append (so a message without a model-only part keeps
 * `modelContent` unset and its content is its identity). */
function withTrailingPart(
  text: string,
  part: string | undefined,
): string | undefined {
  if (part === undefined || part.length === 0) {
    return text.length === 0 ? undefined : text;
  }
  return text.length === 0 ? part : `${text}\n\n${part}`;
}

export interface SessionAgentOptions {
  sessionId: string;
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
  /** Session-bound goal persistence (the sessions table, via the pool).
   * Undefined in tests and sessions without goal support: the goal loop
   * is then disabled and goal mode behaves like a plain prompt. */
  goalStore?: GoalStore;
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
  /** The app language of this agent: the language of the text the core
   * writes into the transcript (goal notices, compaction checkpoints) and
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
  /** The rule that condenses this conversation while it sits idle (see
   * compactAfterIdle). Omitted → the history is condensed only when a
   * request would approach the window. stella's conversations are the ones
   * that live for weeks, so they are the ones that set it. */
  idleCompaction?: IdleCompaction;
  /** Whether rows behind a compaction checkpoint lose their payload once the
   * checkpoint covers them (see session/prune.ts).
   *
   * On for a stella conversation, whose transcript is the record of a
   * conversation that lives for years: tool calls, their output and the
   * context publications steering it are never shown to the user and never
   * searched, so keeping them costs the store and buys nothing. Off for
   * code mode, whose work log IS a surface: its tool rows are what the
   * reader studies after the fact.
   *
   * Omitted → off. */
  pruneCondensed?: boolean;
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
 */
export class SessionAgent {
  readonly sessionId: string;
  readonly agent: Agent;
  /** The rows this session owns in the messages table, and how many leading
   * transcript messages they cover (see transcript.ts). */
  private readonly transcript: TranscriptStore;
  /** The card each tool call is writing, while its arguments stream (see the
   * tool_input_delta case). Cleared when the call is complete — the finished
   * message carries the whole card. */
  private readonly cards = new CardStreams();
  /** The tool names this session was built with (see the `toolNames`
   * accessor). */
  private readonly toolNamesOfSession: string[];
  private readonly onEvent: (event: ClientEvent) => void;
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
  /** Interprets images for a text-only main model (null when the main
   * model sees images or no analysis model is configured). */
  private readonly imageAnalyzer: ImageAnalyzer | null;
  /** Generates the session title from the first user message (null when
   * no fast model is configured). */
  private readonly titleScheduler: TitleScheduler;
  /** The app language this agent was built with: the language of the text
   * the core generates into the transcript (goal notices, compaction
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
  /** Condenses the history (see CompactionController). */
  private readonly compaction: CompactionController;
  /** Owns the autonomous goal loop (start / cancel / rewind-cancel /
   * per-turn judging). Null when the goal loop is disabled. */
  private readonly goals: GoalRunner | null;
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
  /** Dynamic context providers (skill catalog, workspace instructions):
   * their pending updates are published as transcript messages before each
   * run (see publishContexts). */
  private readonly contextProviders: readonly ContextProvider[];
  /** Set by close(): completion notifications of killed background
   * commands must not reach the discarded agent. */
  private closed = false;
  /** The routine in flight and the removal of a silent one. */
  private readonly routineRuns = new RoutineRun();
  private readonly routineHost: RoutineDropHost = {
    messages: () => this.agent.state.messages,
    baseIndex: () => this.transcript.baseIndex,
    forgetFrom: (messages, from) => this.transcript.forgetFrom(messages, from),
    truncateFrom: (position) => this.transcript.truncateFrom(position),
    rebaseContexts: (messages) => this.rebaseContexts(messages),
    emitTruncated: (removed) =>
      this.emit({
        type: "messages_truncated",
        sessionId: this.sessionId,
        removed,
      }),
  };
  /** The idle-compaction rule of this conversation (see
   * CompactionController); null → the idle path is off. */
  get idleCompaction(): IdleCompaction | null {
    return this.compaction.idle;
  }

  /** Whether rows behind a checkpoint lose their payload (see
   * SessionAgentOptions.pruneCondensed and session/prune.ts). */
  private readonly pruneCondensed: boolean;
  /** What a prune freed in the store (see SessionAgentOptions.onFreedBytes). */
  private readonly onFreedBytes: ((bytes: number) => void) | undefined;

  constructor(options: SessionAgentOptions) {
    this.sessionId = options.sessionId;
    this.transcript = new TranscriptStore(
      options.sessionId,
      options.messageRepo,
      options.messages?.length ?? 0,
      options.baseIndex ?? 0,
    );
    this.toolRegistry = options.toolRegistry ?? null;
    this.onEvent = options.onEvent;
    this.renameSession = options.renameSession;
    this.interruptions = new InterruptionHub(
      options.askHub,
      options.handoverHub ?? null,
    );

    // A vision-capable main model passes images through as-is; only a
    // text-only model with an analysis model configured needs rewriting.
    this.imageAnalyzer = options.imageAnalysisModel !== undefined &&
        !(options.model.input ?? []).includes("image")
      ? new ImageAnalyzer(options.imageAnalysisModel, options.streamFn)
      : null;
    const titleGenerator = options.fastModel !== undefined
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
    const goalStore = options.goalStore ?? null;
    this.goals = goalStore === null ? null : new GoalRunner({
      sessionId: options.sessionId,
      goalStore,
      getTranscript: () => this.messages,
      getJudgeModel: () => options.fastModel ?? options.model,
      streamFn: options.streamFn,
      language: this.language,
      runTurn: (instruction) => this.runMainTurn(instruction),
      emit: (event) => this.emit(event),
      isClosed: () => this.closed,
    });
    this.backgroundManager = options.backgroundManager ?? null;
    this.backgroundUnsubscribe = this.backgroundManager === null
      ? null
      : this.backgroundManager.onExit((done) => {
        this.notifyBackgroundCommand(done);
      });
    this.taskHub = options.taskHub ?? null;
    this.taskHub?.setParentDelivery({
      isActive: () => !this.closed,
      deliver: (payload) => this.injectNotification(payload),
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
      convertToLlm: (messages) => this.convertToLlm(messages),
      beforeStep: (signal) => this.compaction.beforeStep(signal),
      ...(options.onRequestShape !== undefined
        ? { onRequest: options.onRequestShape }
        : {}),
    });
    this.rewinder = new Rewinder({
      agent: this.agent,
      transcript: this.transcript,
      retry: this.retry,
      goals: this.goals,
      isStreaming: () => this.isStreaming,
      abort: () => this.abort(),
      rebaseContexts: (messages) => this.rebaseContexts(messages),
      emit: (event) =>
        this.emit({
          type: event.type,
          sessionId: this.sessionId,
          removed: event.removed,
        }),
    });
    this.mcp = new McpAttachmentHost(
      this.agent,
      this.toolRegistry,
      () => this.closed,
    );
    // Condense the history before a request would exceed the model's window
    // (see context-compaction.ts). The compactor reads the live prompt and
    // tools, so a mid-session model or tool change is reflected without
    // rebuilding it; the checkpoint is inserted at the cut and the model's
    // view starts there (nothing is deleted).
    this.compaction = new CompactionController(
      {
        sessionId: this.sessionId,
        messages: () => this.agent.state.messages,
        isStreaming: () => this.isStreaming,
        isClosed: () => this.closed,
        insertHistory: (index, message) => this.insertHistory(index, message),
        publishContexts: () => this.publishContexts(),
        onCompacted: (index, message) =>
          this.announceCheckpoint(index, message),
      },
      {
        model: options.model,
        systemPrompt: () => this.agent.state.systemPrompt,
        tools: () => this.agent.state.tools,
        streamFn: options.streamFn,
        style: options.compactionStyle,
        language: this.language,
        policy: options.compactionPolicy,
        idle: options.idleCompaction ?? null,
      },
    );
    this.contextProviders = options.contextProviders ?? [];
    this.pruneCondensed = options.pruneCondensed === true;
    this.onFreedBytes = options.onFreedBytes;
    // Reopening a conversation is the repair point for a process that died
    // between a checkpoint's insertion and its prune: the store is asked to
    // reduce what is behind the checkpoint, and a row already reduced is
    // left alone.
    this.pruneCondensedRows();
    this.rebaseContexts(this.agent.state.messages);
    this.agent.subscribe((event) => this.handleEvent(event));
    // A conversation reopened after a long silence is condensed right away
    // (the gap started before this process opened it); otherwise the timer
    // is armed for the first run's end.
    this.compaction.armIdle();
  }

  /** Drop the payload of every row behind the newest checkpoint (see
   * session/prune.ts), when this session keeps only what its conversation
   * shows. Best effort: a failed write leaves the rows as they were, and the
   * next compaction or open tries again.
   *
   * The bytes it freed are reported, so the pool can note that the database
   * FILE is now mostly free pages: SQLite reuses them but never shrinks, and
   * the rewrite happens at the next start, before any request (see
   * db/vacuum.ts). */
  private pruneCondensedRows(): void {
    if (!this.pruneCondensed || this.closed) return;
    try {
      const result = this.transcript.pruneCondensed();
      if (result.freedBytes > 0) this.onFreedBytes?.(result.freedBytes);
    } catch (error) {
      log.warn(
        `session ${this.sessionId}: pruning condensed rows failed: ${
          errorMessage(error)
        }`,
      );
    }
  }

  /** Re-anchor every context provider to the part of the transcript the
   * model actually sees (from the newest compaction checkpoint on): the
   * restored history already carries the last publication of each provider,
   * so a reopened session must neither republish an unchanged value nor
   * lose track of what the model has already seen. A publication that a
   * compaction left outside the model's view is forgotten here, so the
   * provider publishes its current value again before the next request.
   * Called on construction, after a compaction and after a rewind truncated
   * the history. */
  private rebaseContexts(messages: readonly AgentMessage[]): void {
    if (this.contextProviders.length === 0) return;
    const last = new Map<string, unknown>();
    for (let i = contextStart(messages); i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === "context") last.set(message.provider, message.state);
    }
    for (const provider of this.contextProviders) {
      provider.rebase(last.get(provider.name));
    }
  }

  /** Publish the pending dynamic-context updates (skill catalog, workspace
   * instructions) as transcript messages. Runs before a run starts, so the
   * model sees the current value in the run's first request; the messages
   * are announced to clients like any other injected message, and they are
   * appended to the transcript without starting a run of their own. */
  private publishContexts(): void {
    if (this.closed) return;
    for (const provider of this.contextProviders) {
      for (const update of provider.next()) {
        const message = contextMessage(
          provider.name,
          update,
          this.agent.nextTimestamp(),
        );
        this.agent.appendMessage(message);
        this.announceMessage(message);
      }
    }
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

  /** Run a prompt to completion. `images` are attached to the user message
   * (base64, passed through to vision-capable models; pi omits them for
   * text-only models). Waits for MCP tools to attach first (they spawn
   * server processes asynchronously). Failures are reported via the
   * `session_error` event, never through the returned promise — the
   * fire-and-forget HTTP path listens on events instead, so awaiting here
   * only means "the run finished". */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    await this.runPrompt(text, images, { firstMessageText: text });
  }

  /** Reset the retry state for a fresh exchange. A user prompt, a
   * notification that starts its own run, or a goal-loop turn all start a
   * fresh exchange: they do not inherit the previous run's
   * vacant-response / rate-limit retry history. */
  private resetRetryState(): void {
    this.retry.reset();
  }

  /**
   * The ONE way an exchange starts from a message the user (or a routine)
   * supplied. Every prompt path is a thin wrapper over this:
   *
   * - `prompt` (awaited, no title/routine extras),
   * - `runRoutine` (carries the routine's name and returns its failure),
   * - `deliverPrompt` (a fire-and-forget prompt, possibly a mode prompt),
   * - `runMainTurn` (the goal loop's own turn: no goal loop recursion).
   *
   * The four used to repeat the same "wait for MCP → publish contexts →
   * announce → reset retries → prompt → resume parked restarts → maybe run
   * the goal loop" sequence, so a change to any step (the context publish a
   * notification-driven run was missing) had to be made four times.
   *
   * `message` is already built and announced by callers that had to decide
   * its shape before the wait (see promptWhileRunning); everything else is
   * done here.
   */
  private async runPrompt(
    text: string,
    images: ImageContent[] | undefined,
    options: {
      /** The routine whose run this is (stamped so its stop button only
       * interrupts its own run). */
      routine?: { id: string; name: string };
      /** A mode prompt: stored as a ModeMessage and used to start the goal
       * mode's loop. */
      mode?: ModePrompt;
      /** Whether the goal loop may run after this turn (the loop's own
       * turns pass false so they cannot recurse). */
      runGoalLoop?: boolean;
      /** Called before the first LLM request (title generation). */
      firstMessageText?: string;
      /** A message the caller already built AND announced (promptWhileRunning
       * had to decide its `steered` stamp before waiting on a rewind). The
       * run then does not rebuild or re-announce it. */
      announced?: AgentMessage;
      /** Files the user attached to this prompt (already in the machine). */
      files?: PromptFileRef[];
      /** Text only the MODEL reads, after the prompt (see
       * `buildUserMessage`'s `modelOnly`). */
      modelOnly?: string;
    } = {},
  ): Promise<{ failure: string | null }> {
    if (!this.mcp.done) await this.mcp.waitReady();
    // Skipped entirely when no rewind runs, so a fire-and-forget delivery
    // reaches the agent in the caller's task (no microtask window in which
    // waitForIdle could report the run finished).
    if (this.rewinder.busy) await this.rewinder.settle();
    if (this.closed) return { failure: null };
    if (options.firstMessageText !== undefined) {
      this.titleScheduler.maybeGenerate(options.firstMessageText);
    }
    // The delivery fact the announcement carries must describe the delivery
    // below: a prompt delivered while a run is active is queued into that
    // run by the agent loop instead of starting one of its own.
    const steered = this.joinsActiveRun();
    // The contexts are published FIRST: they are the run's preamble, so they
    // must precede the prompt in the transcript (and, with the timestamp,
    // in time — see Agent.nextTimestamp).
    this.publishContexts();
    const message = options.announced ??
      (options.mode !== undefined
        ? buildModeMessage(
          options.mode,
          text,
          images ?? [],
          this.agent.nextTimestamp(),
          steered,
        )
        : this.buildUserMessage(
          text,
          images,
          steered,
          options.routine?.name,
          options.files,
          options.modelOnly,
        ));
    if (options.announced === undefined) this.announceMessage(message);
    if (options.mode !== undefined) this.startGoalIfNeeded(options.mode);
    this.resetRetryState();
    if (options.routine !== undefined) {
      this.routineRuns.begin(options.routine.id);
    }
    let failure: string | null = null;
    // Where the routine's own prompt will sit: the view's length now, since
    // `prompt` appends it and everything the run produces follows it. A
    // silent routine's run is removed from there (see below).
    const promptIndex = options.routine === undefined
      ? undefined
      : this.agent.state.messages.length;
    try {
      await this.agent.prompt(message);
    } catch (error) {
      failure = errorMessage(error);
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: failure,
      });
    } finally {
      this.routineRuns.end();
    }
    // A routine that found nothing to report must leave the conversation
    // exactly as it found it. The model says so with the silence sentinel
    // (silent-reply.ts), which the projection already refuses to draw — but
    // the ROW would still be there, and every later turn would pay for it:
    // the routine's prompt, and an assistant reply whose whole content is
    // "NO_RESPONSE". Silence is therefore spelled as an absence, not as a
    // hidden message. Nothing is removed when the run failed or wrote
    // anything else.
    if (
      options.routine !== undefined && failure === null &&
      promptIndex !== undefined &&
      this.routineRuns.wasSilent(this.agent.state.messages, promptIndex)
    ) {
      this.routineRuns.drop(this.routineHost, promptIndex);
    }
    await this.resumeAfterErrorRun();
    if (options.runGoalLoop !== false) await this.maybeRunGoalLoop();
    return { failure };
  }

  /**
   * Run a routine's prompt to completion and report how it went.
   *
   * A routine's run is awaited by the scheduler (it needs the outcome to
   * record it) and it carries the routine's name on the message, so the user
   * sees which routine spoke. The failure is ALSO returned, not only emitted:
   * the run's failure belongs on the routine's row (the settings list shows
   * it), while the transcript keeps its own error row from the normal path.
   *
   * The silence guidance goes in `modelOnly`: it tells the model that this
   * run may end without saying anything (see routine-guidance.ts), and the
   * user reading the transcript sees the routine's own instruction, not that
   * sentence about the run.
   */
  async runRoutine(
    text: string,
    routine: { id: string; name: string },
  ): Promise<{ failure: string | null }> {
    return await this.runPrompt(text, undefined, {
      routine,
      modelOnly: ROUTINE_SILENCE_GUIDANCE,
    });
  }

  /** Whether the run whose prompt sits at `from` said nothing: every message
   * after it that carries prose is the silence sentinel, and no `send_chat`
   * went out. Read from the view the run produced, so a run that narrated
   * its way through tools and then stayed silent still counts — its
   * narration is tool-call traffic, which the conversation does not show
   * either.
   *
   * The prompt at `from` is the user row this run was asked with, and it is
   * skipped: it is what is about to be removed, not something the run said.
   * Prose after it means the routine reported something, and an error row
   * means it failed: both leave the run in the transcript. */
  runningRoutineId(): string | null {
    return this.routineRuns.runningId();
  }

  /** Send a user prompt even while a run is active (fire-and-forget; the
   * web UI path). An active run steers the message in at the next turn
   * boundary — the same mechanism background-command notifications use —
   * so it is processed after the current turn (tool executions included)
   * completes; an idle agent starts a fresh run.
   *
   * Two states never take a steer, because the message would be dropped
   * instead of queued for a later turn (see deliverPrompt): a run that is
   * unwinding from an abort (the rewind button, the stop button) and an
   * in-flight rewind, whose truncation would delete the message again.
   *
   * The message is announced immediately (synthetic message_start/end
   * events) so clients render it right away. When the loop drains it, it
   * re-emits the same events for the same message (identical role +
   * timestamp), which the UI dedups, and the transcript store saves it
   * exactly once at that point.
   *
   * A message that joins the active run carries `steered`: the UI keeps it
   * inside that run's turn instead of starting one of its own, because a
   * turn that did not start a run must not end the running one (see web's
   * buildTurns — the same stamp a notification carries).
   *
   * When `mode` is provided, a ModeMessage is stored in the transcript
   * instead of a regular user message: the UI renders the short text +
   * mode badge, while the LLM receives the full prompt (via
   * toLlmMessages). Attached `images` ride along either way. */
  promptWhileRunning(
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    routine?: string,
    files?: PromptFileRef[],
  ): void {
    // The first prompt of a session names it, whichever path delivered it.
    this.titleScheduler.maybeGenerate(mode ? mode.shortText : text);
    // Decided before the message is built: the stamp must describe the
    // delivery below, and the condition is the one deliverPrompt re-checks.
    const steered = this.joinsActiveRun();
    // Same order as runPrompt: the preamble, then the prompt it introduces.
    this.publishContexts();
    const message = mode
      ? buildModeMessage(
        mode,
        text,
        images ?? [],
        this.agent.nextTimestamp(),
        steered,
      )
      : this.buildUserMessage(text, images, steered, routine, files);
    this.announceMessage(message);
    void this.deliverPrompt(message, mode);
  }

  /** Whether a message delivered right now joins the run that is already
   * active (steer) instead of starting its own run. The condition lives
   * here so the delivery and the `steered` stamp a message carries
   * (notifications — see injectNotification — and prompts — see
   * promptWhileRunning) can never disagree: a run that is unwinding from an
   * abort drops its queues, and a rewind is about to abort the run, so
   * neither takes a steer (see deliverPrompt). */
  private joinsActiveRun(): boolean {
    return !this.rewinder.busy && this.isStreaming &&
      !this.agent.isAborting;
  }

  /** Deliver an announced prompt to the agent loop: a healthy run takes it
   * as a steer (next turn boundary); otherwise it gets its own run — after
   * an in-flight rewind finished, so its messages are not truncated away
   * and the dying run cannot swallow the steer. Always resolves: the run
   * reports its own progress and failures through events. */
  private async deliverPrompt(
    message: AgentMessage,
    mode?: ModePrompt,
  ): Promise<void> {
    try {
      // A rewind in flight is about to abort the run: wait for it (runPrompt
      // does the same before its own run), so this message is not truncated
      // away with the messages the rewind removes.
      if (this.rewinder.busy) await this.rewinder.settle();
      if (this.closed) return;
      if (this.joinsActiveRun()) {
        this.agent.steer(message);
        return;
      }
      // The text is only used when runPrompt builds the message; here the
      // caller already did (its `steered` stamp had to be decided earlier).
      await this.runPrompt("", undefined, {
        announced: message,
        ...(mode !== undefined ? { mode } : {}),
      });
    } catch (error) {
      // runPrompt reports its own failures; this guard only exists so a
      // fire-and-forget delivery can never become an unhandled rejection.
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: errorMessage(error),
      });
    }
  }

  /** Build a user message from text + optional images (single home for the
   * content assembly every prompt path shares). `steered` marks a prompt
   * delivered into the run that was already active (see
   * UserMessage.steered). */
  private buildUserMessage(
    text: string,
    images?: ImageContent[],
    steered?: boolean,
    routine?: string,
    files?: PromptFileRef[],
    /** Text only the MODEL reads, appended after the visible text (and after
     * the file notice). Undefined → nothing is added. See
     * `UserMessage.modelContent`. */
    modelOnly?: string,
  ): AgentMessage {
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (images !== undefined && images.length > 0) content.push(...images);
    // The files already sit in the machine; this record is what the
    // conversation draws under the bubble. Their paths are addressed to the
    // MODEL, so they travel as `modelContent` and never reach the screen: the
    // user wrote a sentence, and the sentence is what they should see.
    //
    // A routine's silence guidance belongs there for the same reason: it is
    // addressed to the model, and a bubble that told the user "if there is
    // nothing to report, stay silent" is prose about the run rather than the
    // run's instruction.
    const modelContent = withTrailingPart(
      textWithFileNotice(text, files ?? []),
      modelOnly,
    );
    return {
      role: "user",
      content,
      ...(modelContent !== undefined ? { modelContent } : {}),
      ...(steered === true ? { steered } : {}),
      ...(routine !== undefined && routine !== "" ? { routine } : {}),
      ...(files !== undefined && files.length > 0 ? { files } : {}),
      timestamp: this.agent.nextTimestamp(),
    };
  }

  /** Announce a message to clients (synthetic message_start/end so it
   * renders immediately). */
  private announceMessage(message: AgentMessage): void {
    this.emit({ type: "message_start", sessionId: this.sessionId, message });
    this.emit({ type: "message_end", sessionId: this.sessionId, message });
  }

  /** One main-agent turn without triggering the goal loop (the loop's own
   * `runTurn`): the judge's next prompt runs to completion, then the loop
   * judges again. `runGoalLoop: false` is what keeps injected turns from
   * recursing into the loop. */
  private async runMainTurn(instruction: string): Promise<void> {
    await this.runPrompt(instruction, undefined, { runGoalLoop: false });
  }

  /** A background command finished: inject its completion notification
   * into the agent loop so the agent can react (see injectNotification).
   *
   * Commands killed via async_bash_kill are not notified: the tool's own
   * result already reports the kill, so a notification would be
   * redundant. Natural exits and timeouts are silent without a
   * notification, so they are always injected. */
  private notifyBackgroundCommand(done: BackgroundCommandDone): void {
    if (done.reason === "killed") return;
    this.injectNotification(formatBackgroundNotification(done));
  }

  /** Inject a notification message into the agent loop (background
   * command completions, sub-agent task completions, agent messages).
   * While streaming, the message is steered in at the next turn boundary;
   * while idle, a new run starts. The system prompt teaches the agent that
   * notification prefixes ("[Background command ...]", "[Task ...]",
   * "[Message from ...]") mark system notifications, not user input.
   *
   * The delivery decision is stamped on the message (`steered`): the UI
   * keeps a steered notification inside the run's turn instead of starting
   * a new one, so a notification arriving mid-run never collapses the
   * running turn's work log (see web's buildTurns). */
  private injectNotification(payload: NotificationPayload): void {
    if (this.closed) return;
    // Re-stamped: a payload is built when the producer noticed it, but it is
    // appended to the transcript now, so it must follow the message before it
    // (see Agent.nextTimestamp). `steered` is this site's decision, not the
    // producer's.
    const message: AgentMessage = {
      ...notificationMessage(payload, this.joinsActiveRun()),
      timestamp: this.agent.nextTimestamp(),
    };
    // Announce the notification to clients (the agent appends it to the
    // transcript without re-emitting — see Agent.append).
    this.emit({ type: "message_start", sessionId: this.sessionId, message });
    this.emit({ type: "message_end", sessionId: this.sessionId, message });
    // Same delivery contract as a user prompt: a notification that starts
    // its own run begins a fresh exchange and waits for MCP attachment
    // inside runPrompt; a steer joins the current run.
    void this.deliverPrompt(message);
  }

  /** Convert the transcript for the LLM: the model's view starts at the
   * newest compaction checkpoint (everything before it stays in the
   * transcript, the database and the UI but is not sent — see
   * ai/context-compaction.ts), notification messages become user
   * messages carrying their title + body (the prefix contract the system
   * prompt teaches), then image blocks are replaced by their analysis text
   * when the main model cannot see images. */
  private convertToLlm(
    messages: AgentMessage[],
  ): Message[] | Promise<Message[]> {
    const start = contextStart(messages);
    const mapped = toLlmMessages(
      start === 0 ? messages : messages.slice(start),
    );
    return this.imageAnalyzer === null
      ? mapped
      : this.convertWithAnalysis(mapped);
  }

  /** Replace image blocks with their analysis text (the transcript itself
   * is never mutated, so the UI and the database keep the original
   * images). Called with the output of toLlmMessages, so every message is
   * already LLM-compatible. */
  private async convertWithAnalysis(messages: Message[]): Promise<Message[]> {
    const out: Message[] = [];
    for (const message of messages) {
      const content = message.content;
      if (
        typeof content === "string" ||
        !content.some((block) => block.type === "image")
      ) {
        out.push(message);
        continue;
      }
      const analyzed = await this.imageAnalyzer!.analyzeContent(
        content as Array<TextContent | ImageContent>,
      );
      out.push({ ...message, content: analyzed } as Message);
    }
    return out;
  }

  abort(): void {
    this.interruptions.endRun();
    this.retry.abort();
    // An abort also stops the autonomous goal loop: the user must be able
    // to interrupt a running goal at any time. The goal is cleared so the
    // right-side panel disappears; a re-send restarts it.
    this.cancelGoal();
    this.agent.abort();
  }

  /** The session's active goal, if any (for the right-side panel resync). */
  getGoal(): GoalInfo | undefined {
    return this.goals?.getGoal();
  }

  /** Cancel the active goal without emitting a user-visible abort of the
   * run itself (the panel's cancel button path via Core). No-op when no
   * goal runs. Also used by the abort fast path to stop the autonomous
   * goal loop. */
  cancelGoal(): void {
    this.goals?.cancel(translate(this.language, "goal.cancelledByUser"));
  }

  /** Start the autonomous goal when a `/goal` mode prompt arrives. */
  private startGoalIfNeeded(mode: ModePrompt): void {
    this.goals?.startIfNeeded(mode);
  }

  /** Run the goal loop when a goal is active (after every completed run). */
  private async maybeRunGoalLoop(): Promise<void> {
    await this.goals?.maybeRun();
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

  /** The questions this session is still waiting on (the ask tool), for the
   * resync snapshot: `question` events are never replayed, so a client that
   * (re)connects while the run is blocked on an ask has no other way to
   * learn about it — and the run stays blocked until someone answers. */
  getPendingQuestions(): PendingQuestion[] {
    return this.interruptions.pendingQuestions();
  }

  /** Undo the transcript from a user message (or a mode message — a
   * slash-command prompt like plan/review; both are user-prompt-shaped
   * and carry the rewind action in the UI) onward: the message itself
   * and everything after it are removed from memory and the database,
   * and clients are told to drop them too. The user can then re-send a
   * corrected prompt (the rewound text is restored to the composer).
   *
   * While a run is active it is aborted first and the drain is awaited, so
   * the run's artifacts (e.g. the assistant message an aborted turn leaves
   * behind) are part of the removed suffix rather than left dangling. The
   * steering/follow-up queues are cleared as well: queued prompts were
   * already announced to clients (synthetic message events) but are not in
   * the transcript yet, so they must not resurface on the next run.
   *
   * Prompts that arrive while the rewind runs (a user re-sending right
   * after clicking the button) wait for it — see deliverPrompt — so they
   * cannot be swallowed by the dying run or truncated away with it.
   *
   * Truncation is positional (the target's exact index), matching the
   * database row order, so messages sharing a millisecond with the target
   * are handled exactly. A timestamp newer than every user/mode message is
   * treated as a queued steer (it sits at the very end, so only the
   * aborted run's artifacts follow it); any other unknown timestamp
   * throws not_found. */
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
    // Stop the goal loop without clearing the persisted goal: reopening
    // the session shows the goal again via the resync endpoint, but does
    // not auto-resume the loop.
    this.goals?.stopLoop();
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

  private emit(event: ClientEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Event sink failures must not break the agent loop.
    }
  }

  private handleEvent(event: AgentEvent): void {
    // The two ends of a run have a step around the events: an idle
    // compaction must not splice a checkpoint into a run that is working,
    // and the gap since the newest LLM call starts when the run ends.
    if (event.type === "agent_start") this.compaction.disarmIdle();
    if (event.type === "agent_end") this.interruptions.endRun();
    const translated = translateRunEvent(event, this.sessionId, this.cards);
    for (const published of translated.events) this.emit(published);
    if (translated.modelError !== undefined) {
      this.reportModelError(translated.modelError);
    }
    if (translated.persist === true) {
      this.transcript.persist(this.agent.state.messages);
    }
    if (translated.turnEnded !== undefined) {
      this.handleTurnEnd(translated.turnEnded);
    }
    if (event.type === "agent_end") this.compaction.armIdle();
  }

  /** Surface a model-stream failure to the user. An assistant message that
   * ended with stopReason "error" carries the provider's error text, but
   * the web UI does not render it from the message itself: the empty
   * content leaves a silent run. The retry mechanism is
   * unaffected: a transient failure still parks its retry (handleTurnEnd),
   * and the error banner clears when the restarted run starts
   * (agent_start). */
  private reportModelError(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const assistant = message as AssistantMessage;
    if (assistant.stopReason !== "error") return;
    const text = assistant.errorMessage?.trim();
    this.emit({
      type: "session_error",
      sessionId: this.sessionId,
      message: text ? text : "The model returned an error",
    });
  }

  /** Retry an outputless assistant response. Classification lives in
   * RetryManager; the agent only executes the decision (an in-run vacant
   * retry via followUp, a parked restart consumed by resumeAfterErrorRun).
   * Permanent failures surface immediately — they can never recover. A
   * transient failure that cut a response off *after* it produced output
   * also parks a restart, which asks the model to continue from where it
   * stopped instead of repeating the answer.
   *
   * An "exhausted" decision ends the run empty: the retries are spent and
   * the turn produced nothing, so the user is told (a run that stops
   * without text, a tool call or an error reads as the agent ignoring the
   * prompt). */
  private handleTurnEnd(message: AgentMessage): void {
    const decision = this.retry.classify(message, this.closed);
    if (decision.action === "followUp") {
      this.agent.followUp(decision.notification);
    }
    if (decision.action === "exhausted") {
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: decision.message === undefined
          ? translate(this.language, "session.vacantResponse", {
            count: decision.count,
          })
          : translate(this.language, "session.retryExhausted", {
            count: decision.count,
            message: decision.message,
          }),
      });
    }
    // "park" decisions are consumed by resumeAfterErrorRun once the dead
    // run settles; "none" needs nothing.
    if (
      message.role === "assistant" &&
      (message as AssistantMessage).stopReason === "error"
    ) {
      // A run that dies leaves a trace: the desktop shell captures the
      // server's output for copy-paste, and these failures used to be
      // invisible outside the transcript. A recoverable failure (a restart
      // is parked) stays at debug so a retry storm cannot flood the log.
      const text = (message as AssistantMessage).errorMessage ??
        "unknown error";
      const line = `session ${this.sessionId}: model call failed: ${text}`;
      if (decision.action === "park") log.debug(`${line} (retrying)`);
      else log.warn(line);
    }
  }

  /** Restart a run that a silent-error turn killed: the parked retry
   * notification becomes the next prompt once the dead run has fully
   * settled, so every run caller — prompt() (an awaited run) and the
   * fire-and-forget deliveries (web prompts, injected notifications) —
   * holds off reporting completion until the restart chain has finished.
   *
   * A restart parked by a context overflow condenses the history first: the
   * request that was rejected cannot be re-sent unchanged, so the forced
   * compaction (threshold and retention bypassed) runs here — after the dead
   * run settled, before the restart's first request. When nothing could be
   * freed the restart is dropped and the provider's own error stands, rather
   * than paying for a request that will be rejected again. */
  private async resumeAfterErrorRun(): Promise<void> {
    if (this.retry.hasPendingOverflow) {
      const result = await this.compaction.compactForOverflow();
      if (result === null) {
        this.retry.clearPendingRestart();
        return;
      }
    }
    await this.retry.resumeOnce(this.agent, this.closed);
  }

  /** Condense the history as far as one balanced span allows (the overflow
   * recovery path). Returns null when nothing could be replaced — a failed
   * summarization or no safe span — which is the signal that the retry
   * cannot help. */
  /** Condense the history on demand (the manual `/compact` path). Resolves
   * with what was summarized, or undefined when no safe span existed or the
   * summarization failed — the transcript is then unchanged either way. */
  compactNow(
    instructions?: string,
  ): Promise<CompactionResult | undefined> {
    return this.compaction.compactNow(instructions);
  }

  /** A checkpoint landed: tell clients (anchored by identity) and drop the
   * summarized payloads. The idle path appends its checkpoint after the last
   * message, so there is nothing to anchor the row to — and no client of that
   * path draws checkpoints (stella's stream drops them; the next snapshot
   * carries the row). */
  private announceCheckpoint(index: number, message: CheckpointMessage): void {
    const before = this.agent.state.messages[index + 1];
    if (before !== undefined) {
      this.emit({
        type: "messages_checkpoint",
        sessionId: this.sessionId,
        before: messageIdentityOf(before),
        message,
      });
    }
    // The span the checkpoint just summarized is no longer read by anyone
    // (the model starts at the checkpoint, and a client never receives tool
    // traffic at all), so its payload is dropped now — while the conversation
    // is being condensed anyway.
    this.pruneCondensedRows();
  }

  /** Insert `message` at `index`: the row first (a failed write leaves
   * memory untouched, so the two can never diverge), then the in-memory
   * transcript and the clients. Used by the context compactor through its
   * `insert` callback; the persisted-row bookkeeping lives in the
   * {@link TranscriptStore}. */
  private insertHistory(index: number, message: AgentMessage): void {
    this.transcript.insertAt(index, message);
    this.agent.state.messages.splice(index, 0, message);
    // The insertion may have moved the model's view past the context
    // publications the older messages carried: re-anchor so a provider
    // whose snapshot is no longer visible publishes it again before the
    // next request (the caller publishes what the re-anchoring queued).
    this.rebaseContexts(this.agent.state.messages);
  }
}
