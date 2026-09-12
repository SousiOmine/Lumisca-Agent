import { Agent } from "../ai/agent.ts";
import type {
  AgentEvent,
  AgentMessage,
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  StreamFn,
  TextContent,
} from "../ai/types.ts";
import { CoreError, errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { RetryManager } from "./retry-manager.ts";
import { GoalRunner } from "./goal-runner.ts";
import type { ClientEvent } from "../types/event.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { ThinkingLevel } from "../shared/mod.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import {
  addToolsToAgent,
  appendMcpToolsNote,
  registryToolPair,
} from "../mcp/tools.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { Tool } from "../tools/schema.ts";
import { toAgentTool } from "../tools/pi-adapter.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { AskHub } from "../tools/ask.ts";
import type { AskAnswer } from "../shared/mod.ts";
import type {
  BackgroundCommandDone,
  BackgroundProcessManager,
} from "../tools/background.ts";
import { formatBackgroundNotification } from "../tools/background.ts";
import { notificationMessage } from "../tools/subagent-format.ts";
import type { TaskHub } from "../tools/task-hub.ts";
import type { NotificationPayload } from "../types/notification.ts";
import { toLlmMessages } from "../types/notification.ts";
import type { ContextProvider } from "./context-providers.ts";
import { contextMessage } from "./context-providers.ts";
import type { ModePrompt } from "../types/mode-message.ts";
import { buildModeMessage } from "../types/mode-message.ts";
import { ImageAnalyzer } from "./image-analysis.ts";
import { TitleGenerator } from "./title-generation.ts";
import type { GoalInfo } from "../shared/goal.ts";
import type { GoalStore } from "../goal/loop.ts";

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
  /** Task hub backing the task / task_output / send_message tools. The
   * agent registers itself as the delivery target for sub-agent completion
   * notifications and messages (see setParentDelivery). */
  taskHub?: TaskHub;
  /** Persist a new session title (also notifies clients). */
  renameSession: (name: string) => void;
  /** Backoff sleep used before a rate-limit (429) restart, injectable for
   * tests; defaults to sleepAbortable (real exponential backoff). */
  rateLimitRetrySleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The session's tool registry (owned by the session pool). When set,
   * its tools are never preloaded into the LLM context — the pool seeds it
   * with browser-lab tools, MCP discovery fills it, and the agent only
   * gets the tool_search / tool_call pair over it, so the request's tool
   * definitions stay small and stable. Omitted → no discoverable tools
   * (the pair is not built). */
  toolRegistry?: ToolRegistry;
  /** Dynamic context providers (skill catalog, workspace instructions).
   * Their updates are published as durable `context` messages before a run
   * starts, and republished only when the value changed (see
   * publishContexts). Omitted → no dynamic context. */
  contextProviders?: ContextProvider[];
}

/**
 * One live agent session: wraps pi's Agent, forwards UI events,
 * and persists new messages to the database as they complete.
 */
export class SessionAgent {
  readonly sessionId: string;
  readonly agent: Agent;
  private readonly messageRepo: MessageRepo;
  private readonly onEvent: (event: ClientEvent) => void;
  private savedCount: number;
  /** The session's shared MCP attachment (owned by the session pool); its
   * tools land in the session's tool registry once discovery finished. */
  private mcpAttachment: McpAttachment | null = null;
  private mcpAttached = false;
  /** The session's tool registry (owned by the session pool): holds every
   * discoverable tool (MCP tools, browser-lab tools, future extensions)
   * whose definitions stay out of the LLM context. Null when the session
   * has none. The pool seeds it with the browser-lab tools before building
   * the agent; MCP discovery merges its tools in afterwards. */
  private readonly toolRegistry: ToolRegistry | null;
  /** Resolves once MCP tools are attached (or skipped/failed). Prompts
   * await it so the first turn always sees the MCP tools — without the
   * gate, a prompt sent right after session creation would start before
   * the MCP servers have finished spawning. Never rejects. */
  private mcpReady: Promise<void> = Promise.resolve();
  /** True when there is nothing to wait for; prompts then skip the await
   * entirely (an await on a resolved promise would still defer the run by
   * a microtask and break "already running" conflict checks). */
  private mcpReadyDone = true;
  /** Interprets images for a text-only main model (null when the main
   * model sees images or no analysis model is configured). */
  private readonly imageAnalyzer: ImageAnalyzer | null;
  /** Generates the session title from the first user message (null when
   * no fast model is configured). */
  private readonly titleGenerator: TitleGenerator | null;
  /** The rewind currently running (abort + truncation), if any. Prompts
   * delivered while it runs wait for it: the truncation removes everything
   * from the rewound message onward, so a run started in between would have
   * its messages deleted again (and a steer into the dying run would be
   * dropped with the queues). */
  private rewindInFlight: Promise<void> | null = null;
  /** Owns the vacant-response / rate-limit retry state (budgets, parked
   * restarts, abort epochs). */
  private readonly retry: RetryManager;
  /** Owns the autonomous goal loop (start / cancel / rewind-cancel /
   * per-turn judging). Null when the goal loop is disabled. */
  private readonly goals: GoalRunner | null;
  private readonly renameSession: (name: string) => void;
  /** Question hub backing the ask tool; rejects pending asks when the run
   * ends or the session closes (see rejectPendingAsks). */
  private readonly askHub: AskHub;
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
   * that left savedCount at 0). */
  private titleGenerated = false;

  constructor(options: SessionAgentOptions) {
    this.sessionId = options.sessionId;
    this.messageRepo = options.messageRepo;
    this.toolRegistry = options.toolRegistry ?? null;
    this.onEvent = options.onEvent;
    this.renameSession = options.renameSession;
    this.askHub = options.askHub;
    this.savedCount = options.messages?.length ?? 0;

    // A vision-capable main model passes images through as-is; only a
    // text-only model with an analysis model configured needs rewriting.
    this.imageAnalyzer = options.imageAnalysisModel !== undefined &&
        !(options.model.input ?? []).includes("image")
      ? new ImageAnalyzer(options.imageAnalysisModel, options.streamFn)
      : null;
    this.titleGenerator = options.fastModel !== undefined
      ? new TitleGenerator(options.fastModel, options.streamFn)
      : null;
    this.retry = new RetryManager(options.rateLimitRetrySleep);
    const goalStore = options.goalStore ?? null;
    this.goals = goalStore === null ? null : new GoalRunner({
      sessionId: options.sessionId,
      goalStore,
      getTranscript: () => this.messages,
      getJudgeModel: () => options.fastModel ?? options.model,
      streamFn: options.streamFn,
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
    });
    this.contextProviders = options.contextProviders ?? [];
    this.rebaseContexts(this.agent.state.messages);
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  /** Re-anchor every context provider to the transcript it just received:
   * the restored history already carries the last publication of each
   * provider, so a reopened session must neither republish an unchanged
   * value nor lose track of what the model has already seen. Called on
   * construction and after a rewind truncated the history. */
  private rebaseContexts(messages: readonly AgentMessage[]): void {
    if (this.contextProviders.length === 0) return;
    const last = new Map<string, unknown>();
    for (const message of messages) {
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
   * in-flight run (if any) keeps the level it started with: pi-agent-core
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
  /** Reset the retry state for a fresh exchange. A user prompt, a
   * notification that starts its own run, or a goal-loop turn all start a
   * fresh exchange: they do not inherit the previous run's
   * vacant-response / rate-limit retry history. */
  private resetRetryState(): void {
    this.retry.reset();
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.mcpReadyDone) await this.mcpReady;
    await this.awaitRewind();
    const message = this.buildUserMessage(text, images);
    this.publishContexts();
    this.maybeGenerateTitle(text);
    this.announceMessage(message);
    // A user prompt starts a fresh exchange: it does not inherit the
    // previous run's vacant-response history.
    this.resetRetryState();
    try {
      await this.agent.prompt(message);
    } catch (error) {
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: errorMessage(error),
      });
    }
    await this.resumeAfterErrorRun();
    await this.maybeRunGoalLoop();
  }

  /** Kick off title generation on the first prompt of a fresh session (no
   * history): it runs concurrently with the run and replaces the
   * provisional "Session <date>" name once ready. Shared by every prompt
   * path (the awaited `prompt` and the web/HTTP `promptWhileRunning`) — missing
   * this would leave web sessions with their provisional name forever.
   * Guarded so it triggers at most once per session, even after a failed
   * first run that left savedCount at 0. */
  private maybeGenerateTitle(firstMessage: string): void {
    if (
      !this.titleGenerated && this.titleGenerator !== null &&
      this.savedCount === 0
    ) {
      this.titleGenerated = true;
      void this.generateTitle(firstMessage);
    }
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
   * timestamp), which the UI dedups, and persistMessages saves it exactly
   * once at that point.
   *
   * When `mode` is provided, a ModeMessage is stored in the transcript
   * instead of a regular user message: the UI renders the short text +
   * mode badge, while the LLM receives the full prompt (via
   * toLlmMessages). */
  promptWhileRunning(
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
  ): void {
    this.maybeGenerateTitle(mode ? mode.shortText : text);
    const message = mode
      ? buildModeMessage(mode, text, Date.now())
      : this.buildUserMessage(text, images);
    this.publishContexts();
    this.announceMessage(message);
    void this.deliverPrompt(message, mode);
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
      // Skipped entirely when no rewind runs: the steer decision below then
      // stays in the caller's task (no microtask window for an abort to slip
      // between the check and the delivery).
      if (this.rewindInFlight !== null) await this.awaitRewind();
      if (this.closed) return;
      if (this.isStreaming && !this.agent.isAborting) {
        this.agent.steer(message);
        return;
      }
      // Starting a run from user input resets the vacant-response history
      // (same contract as prompt()); a steer joins the current run and
      // leaves the counter alone.
      this.resetRetryState();
      if (mode !== undefined) this.startGoalIfNeeded(mode);
      await this.startRun(message);
    } catch (error) {
      // startRun reports its own failures; this guard only exists so a
      // fire-and-forget delivery can never become an unhandled rejection.
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: errorMessage(error),
      });
    }
  }

  /** Build a user message from text + optional images (single home for the
   * content assembly both prompt paths share). */
  private buildUserMessage(
    text: string,
    images?: ImageContent[],
  ): AgentMessage {
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (images !== undefined && images.length > 0) content.push(...images);
    return { role: "user", content, timestamp: Date.now() };
  }

  /** Announce a message to clients (synthetic message_start/end so it
   * renders immediately). */
  private announceMessage(message: AgentMessage): void {
    this.emit({ type: "message_start", sessionId: this.sessionId, message });
    this.emit({ type: "message_end", sessionId: this.sessionId, message });
  }

  /** Start a run that carries a pre-built message (a user prompt or a
   * notification). MCP attachment may still be in flight (a prompt sent
   * right after session creation), so wait for it; a message for a run that
   * is already active is queued by the agent itself (see Agent.prompt). A
   * silent-error restart parked during the run is resumed afterwards, then
   * the goal loop (when active) judges and continues.
   *
   * A run that dies with an exception (no turn to report) surfaces as a
   * session_error: re-delivering the message would duplicate it in the
   * transcript, and a message that was aborted must stay aborted. */
  private async startRun(message: AgentMessage): Promise<void> {
    if (!this.mcpReadyDone) await this.mcpReady;
    try {
      await this.agent.prompt(message);
    } catch (error) {
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: errorMessage(error),
      });
    }
    await this.resumeAfterErrorRun();
    await this.maybeRunGoalLoop();
  }

  /** One main-agent turn without triggering the goal loop (the loop's own
   * `runTurn`): the judge's next prompt runs to completion, then the loop
   * judges again. Separated from startRun/prompt so injected turns do not
   * recurse into the loop. */
  private async runMainTurn(instruction: string): Promise<void> {
    this.resetRetryState();
    this.publishContexts();
    try {
      await this.agent.prompt(instruction);
    } catch (error) {
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: errorMessage(error),
      });
    }
    await this.resumeAfterErrorRun();
  }

  /** Best-effort title generation from the first user message. Failures
   * (and empty text) leave the provisional name in place; the run is
   * never affected. */
  private async generateTitle(firstMessage: string): Promise<void> {
    const text = firstMessage.trim();
    if (!text) return;
    try {
      const title = await this.titleGenerator!.generateTitle(text);
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
   * "[Message from ...]") mark system notifications, not user input. */
  private injectNotification(payload: NotificationPayload): void {
    if (this.closed) return;
    const message = notificationMessage(payload);
    // Announce the notification to clients (the agent appends it to the
    // transcript without re-emitting — see Agent.append).
    this.emit({ type: "message_start", sessionId: this.sessionId, message });
    this.emit({ type: "message_end", sessionId: this.sessionId, message });
    // Same delivery contract as a user prompt: a notification that starts
    // its own run begins a fresh exchange (resetRetryState) and waits for
    // MCP attachment inside startRun; a steer joins the current run.
    void this.deliverPrompt(message);
  }

  /** Convert the transcript for the LLM: notification messages become
   * user messages carrying their title + body (the prefix contract the
   * system prompt teaches), then image blocks are replaced by their
   * analysis text when the main model cannot see images. */
  private convertToLlm(
    messages: AgentMessage[],
  ): Message[] | Promise<Message[]> {
    const mapped = toLlmMessages(messages);
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
    this.goals?.cancel("ユーザーにより中断されました");
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
    // Registered before the first await: a prompt delivered from here on
    // waits for the truncation (deliverPrompt → awaitRewind).
    const work = this.runRewind(timestamp);
    this.rewindInFlight = work;
    try {
      await work;
    } finally {
      if (this.rewindInFlight === work) this.rewindInFlight = null;
    }
  }

  /** Wait for an in-flight rewind, if any. Resolves immediately otherwise;
   * a rewind that failed (not_found) is already settled, so its own caller
   * saw the error and the wait just continues. */
  private async awaitRewind(): Promise<void> {
    // The loop covers a rewind started while this awaited the previous one.
    while (this.rewindInFlight !== null) {
      await this.rewindInFlight.catch(() => {});
    }
  }

  private async runRewind(timestamp: number): Promise<void> {
    if (this.isStreaming) {
      // Rejects pending asks first (via abort), so a run waiting on the
      // user's answer unwinds immediately — waitForIdle below would hang
      // until the ask tool's promise settles otherwise.
      this.abort();
      // An aborted run normally ends as a turn (stopReason "aborted"); a run
      // that died with an exception instead must not block the truncation —
      // its failure belongs to whoever started it, and the rewind owns the
      // transcript from here on.
      await this.agent.waitForIdle().catch(() => {});
    }
    const messages = this.agent.state.messages;
    const index = messages.findIndex(
      (m) =>
        (m.role === "user" || m.role === "mode") &&
        m.timestamp === timestamp,
    );
    // Goal declarations (modeId "goal") that would disappear with the
    // truncation: rewinding them away cancels the goal. Captured before
    // the splice mutates the array.
    const goalTimestamps = new Set(
      messages
        .filter(
          (m) =>
            m.role === "mode" &&
            (m as { modeId?: unknown }).modeId === "goal",
        )
        .map((m) => m.timestamp),
    );
    let removed: Array<{ role: string; timestamp: number }> = [];
    /** Drop everything at `cut` onward from memory and the database,
     * recording what was removed for the clients. */
    const truncateFrom = (cut: number) => {
      removed = messages.splice(cut).map(({ role, timestamp: ts }) => ({
        role,
        timestamp: ts,
      }));
      this.savedCount = messages.length;
      this.messageRepo.deleteFrom(this.sessionId, cut);
    };
    if (index !== -1) {
      truncateFrom(index);
    } else if (
      messages.every(
        (m) =>
          (m.role !== "user" && m.role !== "mode") ||
          m.timestamp < timestamp,
      )
    ) {
      // A queued steer: announced to clients but not in the transcript
      // yet. It is the newest message, so only messages newer than it
      // (the aborted run's artifacts) follow it in the transcript.
      const cut = messages.findIndex((m) => m.timestamp > timestamp);
      if (cut !== -1) truncateFrom(cut);
      // The steer itself has no transcript row, but clients were already
      // told about it (synthetic message events) — include it in the
      // deletion notice so they drop it from the view too.
      removed.push({ role: "user", timestamp });
    } else {
      throw new CoreError(
        `User message not found: ${timestamp}`,
        "not_found",
      );
    }
    this.agent.clearAllQueues();
    // A parked silent-error restart was never announced (no message
    // events, no transcript row) — dropping it here leaves no trace,
    // exactly like clearing the queues.
    this.retry.reset();
    // Rewinding away the goal's own mode message cancels the goal: the
    // declaration itself is gone, so the loop must not continue. Any other
    // rewind leaves the goal intact (the user only corrected a later turn).
    this.goals?.cancelWhenRewound(goalTimestamps, removed);
    // The truncation may have removed the context publications that went
    // with the rewound messages: re-anchor, so a provider whose snapshot is
    // no longer in history publishes it again before the next run.
    this.rebaseContexts(this.agent.state.messages);
    this.emit({
      type: "messages_truncated",
      sessionId: this.sessionId,
      removed,
    });
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
    return this.mcpAttachment?.manager.getStatus() ?? null;
  }

  /** Attach the session's shared MCP attachment (owned by the session
   * pool; its server processes also serve the sub-agents). The tools are
   * added to the agent once discovery finished; the returned promise (also
   * stored as `mcpReady`) resolves when attachment finished, so the first
   * prompt can wait for it. Config errors are reported by the pool, never
   * here. */
  attachMcp(attachment: McpAttachment): Promise<void> {
    if (this.mcpAttached) return this.mcpReady;
    this.mcpAttached = true;
    this.mcpAttachment = attachment;
    // The pool may already have seeded the registry with browser-lab
    // tools — attach the search/call pair on every path, not just when
    // discovery yields MCP tools, so they are searchable from the first
    // prompt even in a session without any MCP servers.
    this.ensureSearchTools();
    if (attachment.done) {
      this.addMcpTools(attachment.getTools());
      return Promise.resolve();
    }
    // Nothing to discover (no servers configured): keep the fast path so
    // prompts start without even a microtask delay (the "already running"
    // conflict check relies on startPrompt reaching the agent loop
    // synchronously).
    if (attachment.config.servers.length === 0) {
      return Promise.resolve();
    }
    this.mcpReadyDone = false;
    this.mcpReady = attachment.ready.then((tools) => {
      if (this.closed) return;
      this.addMcpTools(tools);
    }).finally(() => {
      this.mcpReadyDone = true;
    });
    return this.mcpReady;
  }

  /** MCP discovery finished: merge its tools into the session's tool
   * registry (the pool's browser-lab seed must survive) and make sure the
   * tool_search / tool_call pair is attached. The pair is added once and
   * never changes afterwards, so the request's tool definitions (and
   * their prefix-cache block) stay stable for the whole session;
   * individual tool definitions are only ever loaded into the transcript
   * through a search result. */
  private addMcpTools(tools: Tool[]): void {
    if (this.toolRegistry === null) return;
    this.toolRegistry.addTools(tools);
    this.ensureSearchTools();
  }

  /** When the session's registry holds tools, attach the tool_search /
   * tool_call pair — the only discoverable-tool surface the LLM ever
   * sees — and teach it in the system prompt. Idempotent: called at
   * attach time (the registry may already hold browser-lab tools seeded
   * by the pool) and from addMcpTools when discovery fills the registry
   * later. */
  private ensureSearchTools(): void {
    if (this.toolRegistry === null || this.toolRegistry.isEmpty) return;
    addToolsToAgent(this.agent, registryToolPair(() => this.toolRegistry!));
    this.agent.state.systemPrompt = appendMcpToolsNote(
      this.agent.state.systemPrompt,
    );
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
        this.persistMessages();
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
          result: event.result,
          isError: event.isError,
        });
        break;
      case "turn_end":
        this.handleTurnEnd(event.message);
        break;
      case "agent_end":
        // The run ended (normally or aborted); any ask that is still
        // pending can never be answered within this run.
        this.rejectPendingAsks();
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
   * settled, so both run callers — prompt() (an awaited run) and startRun()
   * (web / injected notifications) — hold off reporting completion until
   * the restart chain has finished. */
  private async resumeAfterErrorRun(): Promise<void> {
    await this.retry.resumeOnce(this.agent, this.closed);
  }

  /** Append only the messages added since the last save. */
  private persistMessages(): void {
    const messages = this.agent.state.messages;
    if (messages.length < this.savedCount) {
      // History was compacted/truncated (no such path today, but guard
      // against it): re-anchor so messages are never re-appended.
      this.savedCount = messages.length;
    }
    for (let i = this.savedCount; i < messages.length; i++) {
      this.messageRepo.append(this.sessionId, messages[i]!);
    }
    this.savedCount = messages.length;
  }
}
