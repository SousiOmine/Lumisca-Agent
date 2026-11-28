import { WORK_COMPACTION_STYLE } from "../ai/compaction-style.ts";
import type { AgentMessage } from "../domain/message.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { createLogger } from "../log.ts";
import { errorMessage } from "../shared/misc.ts";
import type { SessionPoolDeps } from "./deps.ts";
import type { SessionAgent } from "./session-agent.ts";
import { SessionAgent as SessionAgentImpl } from "./session-agent.ts";
import { buildSessionHubs } from "./session-hubs.ts";
import { resolveSessionWhere } from "./session-location.ts";
import {
  ensureMcpAttachment,
  mergedMcpForSession,
  replaceMcpAttachment,
  sameMachineServers,
  sameMcpConfig,
} from "./session-mcp.ts";
import { buildContextProviders, ensureSystemPrompt } from "./session-prompt.ts";
import { SessionRuntime } from "./session-runtime.ts";
import {
  applyCodeExecution,
  buildSessionTools,
  seedDiscoverableTools,
} from "./session-tools.ts";
import { STELLA_COMPACTION_STYLE } from "./stella-compaction.ts";

/** Module logger (debug-gated): request shapes that cost the provider's prompt
 * cache are the first thing to check when a session gets slow. */
const log = createLogger("pool");

/** The rule that condenses a stella conversation while it sits idle (see
 * SessionAgentOptions.idleCompaction).
 *
 * A stella conversation lives for weeks and is reopened after hours or days
 * of silence. Without this, the first request after the silence pays for
 * the whole history as input, and a history near the window would have its
 * checkpoint spliced in while the user waits for the answer.
 *
 * Ten minutes of silence is enough for the conversation to be condensed
 * while the user is away — before the next visit, not while they wait for
 * an answer — and longer than the pauses inside one sitting, so thinking
 * for a few minutes does not cost the verbatim history. The 50k floor keeps
 * short conversations out of it: a summarization call over a few thousand
 * tokens saves nothing worth having. The check condenses the whole view —
 * no tail — because nothing is being answered while the conversation sits
 * idle, so there is no request to keep recent work for. */
const STELLA_IDLE_COMPACTION = {
  afterMs: 10 * 60 * 1000,
  minTokens: 50_000,
} as const;

/** Builds the live agent of a session with every runtime it needs
 * (MCP attachment, tool registry, hubs, tools), and owns the runtime of every
 * open session. The pool asks this class what a session holds; it never sees
 * a runtime's fields. */
export class AgentFactory {
  private readonly runtimes = new Map<string, SessionRuntime>();

  constructor(private readonly deps: SessionPoolDeps) {}

  /** Run `read` against an open session's runtime, or answer undefined when
   * the session is not open. The one way the pool reads session state. */
  withRuntime<T>(
    id: string,
    read: (runtime: SessionRuntime) => T,
  ): T | undefined {
    const runtime = this.runtimes.get(id);
    return runtime === undefined ? undefined : read(runtime);
  }

  /** Build the agent of a session (replacing any existing one). MCP tools
   * attach asynchronously — they spawn server processes — and errors are
   * reported via session_error events, never thrown here. */
  open(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
    /** The whole-transcript position `messages[0]` sits at (see
     * TranscriptStore). */
    baseIndex = 0,
  ): SessionAgent {
    const runtime = this.runtimes.get(session.id) ?? new SessionRuntime();
    this.runtimes.set(session.id, runtime);
    // The wiring, phase by phase. Each phase owns one question and is
    // called in the order the next one depends on: where the session works
    // (and with which model), what it may discover, which hubs back its
    // tools, the tool set itself, the dynamic context, and finally the
    // agent. Reading `open` top to bottom is the sequence of decisions a
    // session is built from.
    const model = this.deps.requireModel(
      session.modelProvider,
      session.modelId,
    );
    const { attachment: mcp, registries } = ensureMcpAttachment(
      this.deps,
      session,
      workspace,
      runtime,
      (attachment) => runtime.mcp === attachment,
    );
    const where = resolveSessionWhere(this.deps, session, workspace);
    seedDiscoverableTools(this.deps, where, registries, session.id);
    const hubs = buildSessionHubs(
      this.deps,
      session,
      where,
      runtime,
      mcp,
      registries,
    );
    const code = applyCodeExecution(
      this.deps,
      buildSessionTools(this.deps, session, workspace, where, hubs),
      where,
      registries,
      session.id,
    );
    const tools = code.tools;
    const systemPrompt = ensureSystemPrompt(
      this.deps,
      session,
      workspace,
      code.sdk,
    );
    const contextProviders = buildContextProviders(
      this.deps,
      session,
      workspace,
      where,
      registries,
      model,
    );
    const agent = new SessionAgentImpl({
      sessionId: session.id,
      agentId: session.mainAgentId,
      systemPrompt,
      model,
      tools,
      messages,
      baseIndex,
      thinkingLevel: this.deps.getThinkingLevel(
        session.modelProvider,
        session.modelId,
      ),
      streamFn: this.deps.streamFn,
      messageRepo: this.deps.messageRepo,
      // Record what the model was sent, as far as prompt-cache reuse is
      // concerned: the first request of the session and every request whose
      // head changed or whose history was rewritten (see
      // session/request-shapes.ts). Append-extensions are not stored — they
      // reuse the previous prefix by construction.
      onRequestShape: (shape) => {
        if (shape.change === undefined) return;
        this.deps.requestShapeRepo.record(session.id, shape);
        if (shape.change === "initial") {
          log.debug(
            `session ${session.id}: first request recorded (${shape.messageCount} messages)`,
          );
          return;
        }
        // The two shapes that cost the provider's whole cached prefix are
        // worth a log line: they explain a cache-read drop on the next
        // assistant message.
        log.info(
          `session ${session.id}: request ${shape.change} ` +
            `(${shape.messageCount} messages, head ${shape.headHash})`,
        );
      },
      backgroundManager: hubs.background,
      askHub: hubs.ask,
      ...(where.stella !== undefined
        ? {
            handoverHub: where.stella.handoverHub,
            envRequestHub: where.stella.envRequestHub,
            ...(this.deps.shareRequests !== undefined
              ? { shareRequestHub: this.deps.shareRequests.for(session.id) }
              : {}),
          }
        : {}),
      taskHub: hubs.tasks,
      toolRegistry: registries,
      codeExecution: where.codeExecution,
      contextProviders,
      imageAnalysisModel: this.deps.getImageAnalysisModel(),
      fastModel: this.deps.getFastModel(),
      // A stella conversation is named by its agent, and the user chose that
      // name: a generated title would contradict the header it is shown
      // under. Code mode has no other name, so its first prompt still
      // names the session.
      titleGeneration: where.stella === undefined,
      // A stella conversation's clients never receive the reply's text, so
      // the card written into it is extracted on the way out (see TextUi).
      uiFromText: where.stella !== undefined,
      language: this.deps.getLanguage(),
      compactionPolicy: () => this.deps.getCompactionPolicy(),
      // A stella conversation remembers the conversation (the record the
      // search can fill in); every other session remembers the work.
      compactionStyle:
        where.stella !== undefined
          ? STELLA_COMPACTION_STYLE
          : WORK_COMPACTION_STYLE,
      ...(where.stella !== undefined
        ? {
            // The prompt carries the identity the agent wrote. It stays
            // fixed while the session lives (a rewrite would cost the
            // provider's cached head), and a compaction regenerates it —
            // the point where the history behind it was replaced anyway.
            refreshSystemPrompt: () =>
              ensureSystemPrompt(this.deps, session, workspace, code.sdk),
            idleCompaction: STELLA_IDLE_COMPACTION,
            // A stella conversation is the only one whose transcript outlives
            // every window it crosses, so it is the only one that may drop
            // what a checkpoint covered (see session/prune.ts). Read at every
            // prune rather than here: the user's answer can change while the
            // conversation is open.
            shouldPruneCondensed: () => !this.deps.getStellaKeepFullLog(),
            ...(this.deps.recordFreedBytes === undefined
              ? {}
              : { onFreedBytes: this.deps.recordFreedBytes }),
          }
        : {}),
      renameSession: (name) => this.deps.renameSession(session.id, name),
      onEvent: (event) => {
        // Remember failures for clients that do not see the WS stream;
        // a new run clears the stale error.
        if (event.type === "session_error") {
          runtime.lastError = event.message;
        } else if (event.type === "agent_start") {
          runtime.lastError = undefined;
        }
        this.deps.emit(event);
      },
    });
    agent.attachMcp(mcp);
    runtime.agent = agent;
    return agent;
  }

  /** Rebuild an open session's agent in place, keeping the hubs and the
   * attachment. A session that is not open is left alone: its next open reads
   * the stored value. `dropMcp` is for a sign-in: the config did not change,
   * so the attachment the session holds may be the one whose connection
   * already failed, and the rebuild must not reuse it. */
  rebuild(session: SessionInfo, options: { dropMcp?: boolean } = {}): void {
    const runtime = this.runtimes.get(session.id);
    const current = runtime?.agent;
    if (runtime === undefined || current === undefined) return;
    const workspace = this.deps.requireWorkspace(session.workspaceId);
    const messages = current.messages;
    const baseIndex = current.baseIndex;
    // Closes the old agent, which also releases its view of the MCP servers.
    current.close();
    if (options.dropMcp === true) runtime.dropMcp();
    this.open(session, workspace, messages, baseIndex);
  }

  /** Tear an open session's resources down and forget it. Resolves once every
   * background kill has taken effect and every MCP child process is dead. */
  async close(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    this.runtimes.delete(id);
    await runtime.close();
  }

  /** Close every open session (core shutdown). */
  async closeAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => runtime.close()));
  }

  /**
   * Bring one open session's discoverable tools onto its current
   * capabilities without replacing its agent. Used when the change is a
   * capability toggle the pool could not express as a rebuild (the session
   * is streaming): the run keeps the tool set it started with, and what the
   * session can find through tool_search follows the toggle.
   *
   * Every family is reseeded, not only the one that changed, so this path
   * and `open` cannot disagree: both answer "which tools does where this
   * session works imply" with the same function.
   */
  reseedDiscoverable(session: SessionInfo, workspace: Workspace): void {
    const runtime = this.runtimes.get(session.id);
    const registries = runtime?.registries;
    if (runtime === undefined || registries === undefined) return;
    try {
      const where = resolveSessionWhere(this.deps, session, workspace);
      seedDiscoverableTools(this.deps, where, registries, session.id);
      runtime.agent?.ensureSearchTools();
    } catch (error) {
      // The setting is already stored; failing the caller's whole change
      // would report a failure that did happen. The session hears about it.
      const message = `Could not apply the change to this session: ${errorMessage(
        error,
      )}`;
      runtime.lastError = message;
      this.deps.emit({ type: "session_error", sessionId: session.id, message });
    }
  }

  /** Move a session to its current MCP config without rebuilding its agent
   * (the session is streaming, and replacing the agent would corrupt its
   * run). The attachment is swapped for a fresh one — new child processes,
   * new discovery — and the agent adopts it, so the servers behind
   * tool_search / tool_call and the status the settings UI reads follow the
   * new config while the run keeps the tools it started with. An idle
   * session is rebuilt instead, which reaches the same wiring through
   * open. */
  refreshMcp(
    session: SessionInfo,
    workspace: Workspace,
    options: { reloadCredentials?: boolean } = {},
  ): void {
    const runtime = this.runtimes.get(session.id);
    const agent = runtime?.agent;
    if (runtime === undefined || agent === undefined) return;
    // An unchanged config is no reason to respawn every server process —
    // unless what changed is the credentials. A sign-in leaves the config
    // byte-for-byte the same, and the connection that already got its 401
    // (and was dropped) is the whole reason to reload: skipping it would
    // keep the session on a manager that never sees the new grant.
    const merged = mergedMcpForSession(this.deps, session, workspace);
    const previous = runtime.mcp;
    if (
      options.reloadCredentials !== true &&
      previous !== undefined &&
      sameMcpConfig(previous.config, merged.config) &&
      sameMachineServers(previous, merged)
    ) {
      return;
    }
    const attachment = replaceMcpAttachment(
      this.deps,
      session,
      workspace,
      runtime,
      merged,
      (candidate) => runtime.mcp === candidate,
    );
    agent.replaceMcpAttachment(attachment);
    // The sub-agents share the session's attachment, so the running ones are
    // re-pointed at the new tools too (see TaskHub.setMcp).
    const registries = runtime.registries;
    if (registries !== undefined) {
      runtime.tasks?.setMcp(attachment, registries.subagent);
    }
  }
}
