import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import { CoreError, errorMessage } from "../errors.ts";
import type { ClientEvent } from "../types/event.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { ThinkingLevel } from "../shared.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import { applyMcpToolsToAgent } from "../mcp/tools.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { Tool } from "../tools/schema.ts";
import { toAgentTool } from "../tools/pi-adapter.ts";
import type { AskHub } from "../tools/ask.ts";
import type { AskAnswer } from "../shared.ts";
import type {
  BackgroundCommandDone,
  BackgroundProcessManager,
} from "../tools/background.ts";
import { formatBackgroundNotification } from "../tools/background.ts";
import type { TaskHub } from "../tools/task.ts";
import type {
  NotificationMessage,
  NotificationPayload,
} from "../types/notification.ts";
import { toLlmMessages } from "../types/notification.ts";
import { ImageAnalyzer } from "./image-analysis.ts";
import { TitleGenerator } from "./title-generation.ts";

/** Maximum consecutive vacant responses (no text, no tool call) to retry
 * before giving up and ending the run normally. */
export const MAX_EMPTY_RESPONSE_RETRIES = 3;

/** True when the assistant response produced neither text nor a tool call:
 * the model ended its turn without any output. Thinking blocks alone don't
 * count as output (the user never sees them), and error/aborted stops are
 * handled by the loop itself — they terminate the run, so a retry message
 * must never be queued behind them (it would leak into the next run). */
export function isVacantResponse(message: AssistantMessage): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return false;
  }
  return message.content.every(
    (block) =>
      block.type !== "toolCall" &&
      (block.type !== "text" || block.text.trim().length === 0),
  );
}

/** The notification queued to retry a vacant response. The text is
 * self-contained (no system-prompt prefix contract): the model reads it as
 * a user message telling it its previous response was empty. */
export function buildRetryNotification(attempt: number): NotificationMessage {
  return {
    role: "notification",
    kind: "retry",
    title: `Previous response was empty (retry ${attempt})`,
    body:
      "You produced neither text nor a tool call. Continue: respond with text or call a tool.",
    status: "neutral",
    timestamp: Date.now(),
  };
}

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
   * tools are added to this agent once discovery finished. */
  private mcpAttachment: McpAttachment | null = null;
  private mcpAttached = false;
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
  /** Set by close(): completion notifications of killed background
   * commands must not reach the discarded agent. */
  private closed = false;
  /** Consecutive vacant responses (no text, no tool call) in the current
   * run. Each one is retried via followUp (see handleTurnEnd) up to
   * MAX_EMPTY_RESPONSE_RETRIES; a response with output resets the count. */
  private emptyResponseRetries = 0;
  /** Title generation runs once per session, concurrently with the first
   * run; this guards against re-triggering (e.g. after a failed first run
   * that left savedCount at 0). */
  private titleGenerated = false;

  constructor(options: SessionAgentOptions) {
    this.sessionId = options.sessionId;
    this.messageRepo = options.messageRepo;
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
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /** Run a prompt to completion. `images` are attached to the user message
   * (base64, passed through to vision-capable models; pi omits them for
   * text-only models). Waits for MCP tools to attach first (they spawn
   * server processes asynchronously). Failures are reported via the
   * `session_error` event, never through the returned promise — callers
   * (HTTP fire-and-forget, CLI) all listen on events, so awaiting here only
   * means "the run finished". */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (!this.mcpReadyDone) await this.mcpReady;
    this.maybeGenerateTitle(text);
    try {
      await this.agent.prompt(text, images);
    } catch (error) {
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: errorMessage(error),
      });
    }
  }

  /** Kick off title generation on the first prompt of a fresh session (no
   * history): it runs concurrently with the run and replaces the
   * provisional "Session <date>" name once ready. Shared by every prompt
   * path (CLI `prompt` and the web/HTTP `promptWhileRunning`) — missing
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
   * The message is announced immediately (synthetic message_start/end
   * events) so clients render it right away. When the loop drains it, it
   * re-emits the same events for the same message (identical role +
   * timestamp), which the UI dedups, and persistMessages saves it exactly
   * once at that point. */
  promptWhileRunning(text: string, images?: ImageContent[]): void {
    this.maybeGenerateTitle(text);
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (images !== undefined && images.length > 0) {
      content.push(...images);
    }
    const message: AgentMessage = {
      role: "user",
      content,
      timestamp: Date.now(),
    };
    this.emit({ type: "message_start", sessionId: this.sessionId, message });
    this.emit({ type: "message_end", sessionId: this.sessionId, message });
    if (this.isStreaming) {
      this.agent.steer(message);
      return;
    }
    void this.startSteeredRun(message);
  }

  /** Start a run that carries a steered user message. Mirrors
   * startBackgroundRun: MCP attachment may still be in flight (a prompt
   * sent right after session creation), so wait for it; if a run started
   * concurrently the prompt fails and the message is steered instead. */
  private async startSteeredRun(message: AgentMessage): Promise<void> {
    if (!this.mcpReadyDone) await this.mcpReady;
    try {
      await this.agent.prompt(message);
    } catch {
      this.agent.steer(message);
    }
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
    } catch {
      // Keep the provisional name.
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
    const message: NotificationMessage = {
      role: "notification",
      ...payload,
      timestamp: Date.now(),
    };
    if (this.isStreaming) {
      this.agent.steer(message);
      return;
    }
    if (!this.mcpReadyDone) {
      // MCP attachment may still be in flight (a very fast command); wait
      // for it, then re-check — a user prompt may have started meanwhile.
      void this.mcpReady.then(() => this.startBackgroundRun(message));
      return;
    }
    this.startBackgroundRun(message);
  }

  /** Start a run that carries a background-completion notification. If a
   * run started concurrently (e.g. a user prompt), queue instead — the
   * message is processed at that run's next turn boundary. */
  private async startBackgroundRun(message: AgentMessage): Promise<void> {
    try {
      await this.agent.prompt(message);
    } catch {
      this.agent.steer(message);
    }
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
    this.agent.abort();
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

  /** Undo the transcript from a user message onward: the message itself
   * and everything after it are removed from memory and the database, and
   * clients are told to drop them too. The user can then re-send a
   * corrected prompt (the rewound text is restored to the composer).
   *
   * While a run is active it is aborted first and the drain is awaited, so
   * the run's artifacts (e.g. the empty failure message pi pushes on
   * abort) are part of the removed suffix rather than left dangling. The
   * steering/follow-up queues are cleared as well: queued prompts were
   * already announced to clients (synthetic message events) but are not in
   * the transcript yet, so they must not resurface on the next run.
   *
   * Truncation is positional (the target's exact index), matching the
   * database row order, so messages sharing a millisecond with the target
   * are handled exactly. A timestamp newer than every user message is
   * treated as a queued steer (it sits at the very end, so only the
   * aborted run's artifacts follow it); any other unknown timestamp
   * throws not_found. */
  async rewind(timestamp: number): Promise<void> {
    if (this.isStreaming) {
      // Rejects pending asks first (via abort), so a run waiting on the
      // user's answer unwinds immediately — waitForIdle below would hang
      // until the ask tool's promise settles otherwise.
      this.abort();
      await this.agent.waitForIdle();
    }
    const messages = this.agent.state.messages;
    const index = messages.findIndex(
      (m) => m.role === "user" && m.timestamp === timestamp,
    );
    let removed: Array<{ role: string; timestamp: number }> = [];
    if (index !== -1) {
      removed = messages.splice(index).map(({ role, timestamp: ts }) => ({
        role,
        timestamp: ts,
      }));
      this.savedCount = messages.length;
      this.messageRepo.deleteFrom(this.sessionId, index);
    } else if (
      messages.every((m) => m.role !== "user" || m.timestamp < timestamp)
    ) {
      // A queued steer: announced to clients but not in the transcript
      // yet. It is the newest message, so only messages newer than it
      // (the aborted run's artifacts) follow it in the transcript.
      const cut = messages.findIndex((m) => m.timestamp > timestamp);
      if (cut !== -1) {
        removed = messages.splice(cut).map(({ role, timestamp: ts }) => ({
          role,
          timestamp: ts,
        }));
        this.savedCount = messages.length;
        this.messageRepo.deleteFrom(this.sessionId, cut);
      }
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
    this.rejectPendingAsks();
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

  /** Add the attachment's tools to the agent and teach it about their
   * out-of-workspace access (shared helper: the sub-agent hub uses the
   * same one). */
  private addMcpTools(tools: Tool[]): void {
    applyMcpToolsToAgent(this.agent, tools);
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
        // A new run does not inherit the previous run's vacant-response
        // history (a user prompt after a silent run starts fresh).
        this.emptyResponseRetries = 0;
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

  /** Retry a vacant assistant response (no text, no tool call): the model
   * ended its turn without producing anything, leaving the user with a
   * silent run. A retry notification is queued via followUp — the loop
   * picks it up right where it was about to stop, so the retry happens
   * within the same run and the UI keeps the turn expanded until it
   * completes. A response with output resets the consecutive-retry count;
   * once the limit is hit the run ends normally. */
  private handleTurnEnd(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const assistant = message as AssistantMessage;
    if (!isVacantResponse(assistant)) {
      this.emptyResponseRetries = 0;
      return;
    }
    if (
      this.closed || this.emptyResponseRetries >= MAX_EMPTY_RESPONSE_RETRIES
    ) {
      return;
    }
    this.emptyResponseRetries++;
    this.agent.followUp(buildRetryNotification(this.emptyResponseRetries));
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
