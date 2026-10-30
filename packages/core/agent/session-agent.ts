import { Agent } from "../ai/agent.ts";
import type {
  AgentEvent,
  AgentMessage,
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  RequestShape,
  StreamFn,
  TextContent,
} from "../ai/types.ts";
import { CoreError, errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { RetryManager } from "./retry-manager.ts";
import { GoalRunner } from "./goal-runner.ts";
import type { ClientEvent } from "../types/event.ts";
import type { MessageRepo } from "../session/messages.ts";
import { TranscriptStore } from "./transcript.ts";
import { messageIdentityOf } from "../session/transcript-window.ts";
import type { ThinkingLevel } from "../shared/mod.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import { McpAttachmentHost } from "./mcp-host.ts";
import { Rewinder } from "./rewinder.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { Tool } from "../tools/schema.ts";
import { toAgentTool } from "../tools/pi-adapter.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import type { AskHub, PendingQuestion } from "../tools/ask.ts";
import type { HandoverHub, PendingHandover } from "../vm/handover.ts";
import type { AskAnswer } from "../shared/mod.ts";
import { DEFAULT_LOCALE, type Locale, translate } from "../shared/mod.ts";
import type {
  BackgroundCommandDone,
  BackgroundProcessManager,
} from "../tools/background.ts";
import { formatBackgroundNotification } from "../tools/background.ts";
import { notificationMessage } from "../types/notification.ts";
import type { TaskHub } from "../tools/task-hub.ts";
import type { NotificationPayload } from "../types/notification.ts";
import { toLlmMessages } from "../types/notification.ts";
import type { ContextProvider } from "../ai/context-providers.ts";
import { contextMessage } from "../ai/context-providers.ts";
import type { ModePrompt } from "../types/mode-message.ts";
import { buildModeMessage } from "../types/mode-message.ts";
import { ImageAnalyzer } from "./image-analysis.ts";
import { TitleGenerator } from "./title-generation.ts";
import type { GoalInfo } from "../shared/goal.ts";
import type { GoalStore } from "../goal/loop.ts";
import {
  type CompactionResult,
  ContextCompactor,
  contextStart,
} from "../ai/context-compaction.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";

/** One observer of the events this agent emits (see subscribeToRun). */
type RunListener = (event: ClientEvent) => void;

/** Module logger (debug-gated): title-generation misses and other
 * best-effort failures land here instead of vanishing silently. */
const log = createLogger("session-agent");

export interface SessionAgentOptions {
  sessionId: string;
  systemPrompt: string;
  model: Model<Api>;
  tools: Tool[];
  messages?: AgentMessage[];
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
  private readonly titleGenerator: TitleGenerator | null;
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
  /** Condenses the history when a request would exceed the model's window
   * (the DeepSeek Harness's compaction seam; see context-compaction.ts).
   * Runs before every LLM request of a run and after a provider-confirmed
   * overflow. */
  private readonly compactor: ContextCompactor;
  /** Owns the autonomous goal loop (start / cancel / rewind-cancel /
   * per-turn judging). Null when the goal loop is disabled. */
  private readonly goals: GoalRunner | null;
  private readonly renameSession: (name: string) => void;
  /** Question hub backing the ask tool; rejects pending asks when the run
   * ends or the session closes (see rejectPendingAsks). */
  private readonly askHub: AskHub;
  /** Handover hub backing `vm_ask_user`; cancelled with the run and the
   * session (see cancelHandover). */
  private readonly handoverHub: HandoverHub | null;
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
  /** Title generation runs once per session, concurrently with the first
   * run; this guards against re-triggering (e.g. after a failed first run
   * that left the transcript unpersisted). */
  private titleGenerated = false;
  /** Extra listeners of the events this agent emits (see subscribeToRun):
   * the routine runner watches for the run's failure without competing with
   * the session's own event sink. */
  private runListeners: Set<RunListener> | null = null;
  /** The routine whose run is in flight (see runningRoutineId). */
  private activeRoutineId: string | null = null;

  constructor(options: SessionAgentOptions) {
    this.sessionId = options.sessionId;
    this.transcript = new TranscriptStore(
      options.sessionId,
      options.messageRepo,
      options.messages?.length ?? 0,
    );
    this.toolRegistry = options.toolRegistry ?? null;
    this.onEvent = options.onEvent;
    this.renameSession = options.renameSession;
    this.askHub = options.askHub;
    this.handoverHub = options.handoverHub ?? null;

    // A vision-capable main model passes images through as-is; only a
    // text-only model with an analysis model configured needs rewriting.
    this.imageAnalyzer = options.imageAnalysisModel !== undefined &&
        !(options.model.input ?? []).includes("image")
      ? new ImageAnalyzer(options.imageAnalysisModel, options.streamFn)
      : null;
    this.titleGenerator = options.fastModel !== undefined
      ? new TitleGenerator(options.fastModel, options.streamFn)
      : null;
    this.language = options.language ?? DEFAULT_LOCALE;
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
      beforeStep: (signal) => this.compactBeforeStep(signal),
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
    this.compactor = new ContextCompactor({
      model: options.model,
      systemPrompt: () => this.agent.state.systemPrompt,
      tools: () => this.agent.state.tools,
      streamFn: options.streamFn,
      sessionId: options.sessionId,
      language: this.language,
      ...(options.compactionPolicy !== undefined
        ? { policy: options.compactionPolicy }
        : {}),
      insert: (index, message) => this.insertHistory(index, message),
      onCompacted: (result, message) => {
        // The position travels as an identity: clients hold a window of the
        // transcript and cannot resolve an index into it (see ClientEvent).
        const before = this.agent.state.messages[result.index + 1];
        if (before === undefined) {
          // The checkpoint closed the transcript: there is no message after
          // it, and no client can place it without one. Compaction only
          // ever cuts before a retained unit, so this is a bug rather than a
          // case to paper over.
          throw new Error(
            "Compaction inserted a checkpoint after the transcript's end",
          );
        }
        this.emit({
          type: "messages_checkpoint",
          sessionId: this.sessionId,
          before: messageIdentityOf(before),
          message,
        });
      },
    });
    this.contextProviders = options.contextProviders ?? [];
    this.rebaseContexts(this.agent.state.messages);
    this.agent.subscribe((event) => this.handleEvent(event));
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
          Date.now(),
        );
        this.agent.appendMessage(message);
        this.announceMessage(message);
      }
    }
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
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
    } = {},
  ): Promise<{ failure: string | null }> {
    if (!this.mcp.done) await this.mcp.waitReady();
    // Skipped entirely when no rewind runs, so a fire-and-forget delivery
    // reaches the agent in the caller's task (no microtask window in which
    // waitForIdle could report the run finished).
    if (this.rewinder.busy) await this.rewinder.settle();
    if (this.closed) return { failure: null };
    if (options.firstMessageText !== undefined) {
      this.maybeGenerateTitle(options.firstMessageText);
    }
    // The delivery fact the announcement carries must describe the delivery
    // below: a prompt delivered while a run is active is queued into that
    // run by the agent loop instead of starting one of its own.
    const message = options.announced ??
      (options.mode !== undefined
        ? buildModeMessage(
          options.mode,
          text,
          images ?? [],
          Date.now(),
          this.joinsActiveRun(),
        )
        : this.buildUserMessage(
          text,
          images,
          this.joinsActiveRun(),
          options.routine?.name,
        ));
    this.publishContexts();
    if (options.announced === undefined) this.announceMessage(message);
    if (options.mode !== undefined) this.startGoalIfNeeded(options.mode);
    this.resetRetryState();
    if (options.routine !== undefined) {
      this.activeRoutineId = options.routine.id;
    }
    let failure: string | null = null;
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
      this.activeRoutineId = null;
    }
    await this.resumeAfterErrorRun();
    if (options.runGoalLoop !== false) await this.maybeRunGoalLoop();
    return { failure };
  }

  /** Kick off title generation on the first prompt of a fresh session (no
   * history): it runs concurrently with the run and replaces the
   * provisional "Session <date>" name once ready. Shared by every prompt
   * path (the awaited `prompt` and the web/HTTP `promptWhileRunning`) — missing
   * this would leave web sessions with their provisional name forever.
   * Guarded so it triggers at most once per session, even after a failed
   * first run that left the transcript unpersisted. */
  private maybeGenerateTitle(firstMessage: string): void {
    if (
      !this.titleGenerated && this.titleGenerator !== null &&
      this.transcript.persistedCount === 0
    ) {
      this.titleGenerated = true;
      void this.generateTitle(firstMessage);
    }
  }

  /**
   * Run a routine's prompt to completion and report how it went.
   *
   * A routine's run is awaited by the scheduler (it needs the outcome to
   * record it) and it carries the routine's name on the message, so the user
   * sees which routine spoke. The failure is ALSO returned, not only emitted:
   * the run's failure belongs on the routine's row (the settings list shows
   * it), while the transcript keeps its own error row from the normal path.
   */
  async runRoutine(
    text: string,
    routine: { id: string; name: string },
  ): Promise<{ failure: string | null }> {
    return await this.runPrompt(text, undefined, { routine });
  }

  /** The routine whose run is in flight, or null for any other run. The
   * scheduler checks this before stopping anything. */
  runningRoutineId(): string | null {
    return this.activeRoutineId;
  }

  /** Observe the run's events for one call (the routine runner's error
   * probe). Returns the unsubscribe function. */
  private subscribeToRun(listener: RunListener): () => void {
    if (this.runListeners === null) {
      this.runListeners = new Set();
    }
    const set = this.runListeners;
    set.add(listener);
    return () => set.delete(listener);
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
  ): void {
    // The first prompt of a session names it, whichever path delivered it.
    this.maybeGenerateTitle(mode ? mode.shortText : text);
    // Decided before the message is built: the stamp must describe the
    // delivery below, and the condition is the one deliverPrompt re-checks.
    const steered = this.joinsActiveRun();
    const message = mode
      ? buildModeMessage(mode, text, images ?? [], Date.now(), steered)
      : this.buildUserMessage(text, images, steered, routine);
    this.publishContexts();
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
  ): AgentMessage {
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (images !== undefined && images.length > 0) content.push(...images);
    return {
      role: "user",
      content,
      ...(steered === true ? { steered } : {}),
      ...(routine !== undefined && routine !== "" ? { routine } : {}),
      timestamp: Date.now(),
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

  /** Best-effort title generation from the first user message. Failures
   * (and empty text) leave the provisional name in place; the run is
   * never affected. */
  private async generateTitle(firstMessage: string): Promise<void> {
    const text = firstMessage.trim();
    if (!text) return;
    try {
      const title = await this.titleGenerator!.generateTitle(
        text,
        this.language,
      );
      this.renameSession(title);
    } catch (error) {
      // Keep the provisional name; the failure is only visible on debug.
      log.debug(`title generation failed: ${errorMessage(error)}`);
    }
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
    const message = notificationMessage(payload, this.joinsActiveRun());
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
    this.rejectPendingAsks();
    this.cancelHandover();
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
    this.askHub.answer(toolCallId, answers);
  }

  /** The hand-over this session is still waiting on, for the resync
   * snapshot: `handover` events are never replayed, so a client that
   * (re)connects while the run is blocked on the screen has no other way
   * to learn that it may take over. */
  getPendingHandover(): PendingHandover | null {
    return this.handoverHub?.pendingHandover() ?? null;
  }

  /** Let the blocked run continue after the user finished at the screen.
   * Throws when nothing is waiting (the HTTP layer answers 409). */
  finishHandover(note: string, toolCallId?: string): void {
    if (this.handoverHub === null) {
      throw new CoreError(
        "This session has no screen hand-over",
        "unavailable",
      );
    }
    this.handoverHub.finish(note, toolCallId);
  }

  /** Cancel a pending hand-over (the run ended, or the session closes).
   * Idempotent. */
  private cancelHandover(): void {
    this.handoverHub?.cancelAll();
  }

  /** The questions this session is still waiting on (the ask tool), for the
   * resync snapshot: `question` events are never replayed, so a client that
   * (re)connects while the run is blocked on an ask has no other way to
   * learn about it — and the run stays blocked until someone answers. */
  getPendingQuestions(): PendingQuestion[] {
    return this.askHub.pendingQuestions();
  }

  /** Reject every pending ask. The run that asked them is ending or the
   * session is closing, so the tool promises must settle — otherwise a
   * torn-down run would leave them hanging (and the UI's question panel
   * would never clear). Idempotent: safe to call from every teardown path. */
  private rejectPendingAsks(): void {
    this.askHub.rejectAll();
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
    // Stop the goal loop without clearing the persisted goal: reopening
    // the session shows the goal again via the resync endpoint, but does
    // not auto-resume the loop.
    this.goals?.stopLoop();
    this.rejectPendingAsks();
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

  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
  }

  private emit(event: ClientEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Event sink failures must not break the agent loop.
    }
    if (this.runListeners === null) return;
    for (const listener of [...this.runListeners]) {
      try {
        listener(event);
      } catch {
        // An observer must not be able to break the run it observes.
      }
    }
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        // The vacant-response counter is reset where runs start from
        // outside (prompt / promptWhileRunning / injectNotification), not
        // here: a silent-error restart is a new run but the SAME
        // exchange, and its retries must keep counting toward the limit.
        this.emit({ type: "agent_start", sessionId: this.sessionId });
        break;
      case "message_start":
        this.emit({
          type: "message_start",
          sessionId: this.sessionId,
          message: event.message,
        });
        break;
      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          this.emit({
            type: "message_delta",
            sessionId: this.sessionId,
            delta: ev.delta,
          });
        }
        break;
      }
      case "message_end":
        this.emit({
          type: "message_end",
          sessionId: this.sessionId,
          message: event.message,
        });
        this.reportModelError(event.message);
        this.transcript.persist(this.agent.state.messages);
        break;
      case "tool_execution_start":
        this.emit({
          type: "tool_start",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool_end",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
        break;
      case "turn_end":
        this.handleTurnEnd(event.message);
        break;
      case "agent_end":
        // The run ended (normally or aborted); any ask that is still
        // pending can never be answered within this run, and a hand-over
        // that is still waiting has nothing left to wait for.
        this.rejectPendingAsks();
        this.cancelHandover();
        this.emit({ type: "agent_end", sessionId: this.sessionId });
        break;
      default:
        break;
    }
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
   * stopped instead of repeating the answer. */
  private handleTurnEnd(message: AgentMessage): void {
    const decision = this.retry.classify(message, this.closed);
    if (decision.action === "followUp") {
      this.agent.followUp(decision.notification);
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
      const result = await this.compactForOverflow();
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
  private async compactForOverflow(): Promise<CompactionResult | null> {
    try {
      const result = await this.compactor.compactIfNeeded(
        this.agent.state.messages,
        { force: true },
      );
      if (result !== null) this.republishContextsAfter(result);
      return result;
    } catch (error) {
      log.warn(
        `session ${this.sessionId}: overflow compaction failed: ${
          errorMessage(error)
        }`,
      );
      return null;
    }
  }

  /** Pre-step hook of the agent loop: condense the history before a request
   * that would exceed the model's window is derived from it. Running here
   * (rather than only when a run ends) is what keeps a tool-heavy turn from
   * growing past the window mid-turn.
   *
   * A compaction that removed context publications republishes them: the
   * provider would otherwise keep an anchor to a message that is no longer
   * in the history and never send the value again. */
  private async compactBeforeStep(signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) return;
    try {
      const result = await this.compactor.compactIfNeeded(
        this.agent.state.messages,
      );
      if (result !== null) this.republishContextsAfter(result);
    } catch (error) {
      // A failed replacement must not kill the run: the request then goes
      // out with the history it had (the same outcome as a failed
      // summarization).
      log.warn(
        `session ${this.sessionId}: compaction failed: ${errorMessage(error)}`,
      );
    }
  }

  /** Condense the history on demand (the manual `/compact` path; pi's
   * `/compact [instructions]`). Resolves with what was summarized, or
   * undefined when no safe span existed or the summarization failed — the
   * transcript is then unchanged either way. */
  async compactNow(
    instructions?: string,
  ): Promise<CompactionResult | undefined> {
    if (this.closed) return undefined;
    const result = await this.compactor.compactNow(
      this.agent.state.messages,
      instructions,
    );
    if (result !== null) this.republishContextsAfter(result);
    return result ?? undefined;
  }

  /** After a compaction: publish the context updates that the re-anchoring
   * queued. Only a compaction that summarized a context publication can
   * queue one (a provider whose snapshot is no longer in the model's view
   * must re-establish its value); everything else is already anchored. */
  private republishContextsAfter(result: CompactionResult): void {
    const lostProvider = result.summarized.some(
      (message) => message.role === "context",
    );
    if (!lostProvider) return;
    this.publishContexts();
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
