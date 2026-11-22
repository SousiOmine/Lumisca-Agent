import { sleepAbortable } from "../ai/rate-limit.ts";
import type { StreamFn } from "../ai/transport.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import type { Tool } from "../ports/tool.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { AgentRepo } from "../session/agents.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { ShareHub } from "../share/hub.ts";
import type { SubagentType, TaskInfo } from "../shared/mod.ts";
import { DEFAULT_LOCALE, type Locale } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import type { SearchProvider } from "../websearch/types.ts";
import type { ToolRegistry } from "./registry.ts";
import type { ParentDelivery } from "./subagent-mesh.ts";
import { SubagentMesh } from "./subagent-mesh.ts";
import type { SubagentHub } from "./subagent-registry.ts";
import { SubagentRegistry } from "./subagent-registry.ts";
import { restoreSubagents } from "./subagent-restore.ts";
import { SubagentRunner } from "./subagent-run.ts";
import type { SubagentRuntime, SubagentSpawnHost } from "./subagent-spawn.ts";
import { SubagentSession, spawnSubagent } from "./subagent-spawn.ts";
import { SubagentToolWiring } from "./subagent-tools.ts";
import { createTaskFamilyTools } from "./task.ts";

/** Concurrent sub-agents per session, and the nesting depth a spawn may
 * reach (see subagent-spawn.ts, which enforces both). */
export { MAX_SUBAGENT_DEPTH, MAX_SUBAGENTS } from "./subagent-spawn.ts";
/** The runtime a new sub-agent spawns into (see subagent-spawn.ts, which
 * owns what one is). */
/** Where the parent (main) agent receives injected notifications (see
 * subagent-mesh.ts, which owns delivery). */
export type { ParentDelivery, SubagentRuntime };

export interface TaskHubOptions {
  /** The session this hub's agents belong to. It is what the events and the
   * store's session column address. */
  sessionId: string;
  /** The session's main agent (see session/agents.ts). It is the parent of
   * the sub-agents spawned at depth 1 and the id send_message resolves
   * "parent" to; the session id is not an agent id. */
  mainAgentId: string;
  /** The session's agents: the sub-agent rows are written and settled here,
   * and a session's settled ones are restored from it when the hub is built. */
  agents: AgentRepo;
  /** The message store: each sub-agent's transcript is written through a
   * TranscriptStore over its own agent id. */
  messages: MessageRepo;
  /** Resolves the runtime a new sub-agent gets (the fast model with its
   * stored thinking level when configured, otherwise the session model).
   * Called at spawn time, so model/workspace/thinking-level changes apply
   * to new sub-agents without waiting for a session rebuild. */
  resolveRuntime(): SubagentRuntime;
  streamFn: StreamFn;
  /** Command safety check for the general sub-agent's bash/eval tools (the
   * fast model judges commands before they run). Omitted → the sub-agent's
   * command tools run unchecked. */
  safety?: CommandSafety;
  /** The app language the sub-agents must answer in (see tools/language).
   * Defaults to the catalogue's fallback language; the pool re-sets it on
   * every session open (setLanguage), like the browser gate. */
  language?: Locale;
  /** The compaction tuning read from the settings store (see
   * shared/settings-keys.ts): the sub-agents condense their history with
   * the same policy as the main agent. Read on every check. */
  compactionPolicy?: () => CompactionPolicyInput;
  /** Sleep before a retry backoff (injectable for tests, like
   * SessionAgent's rateLimitRetrySleep). Defaults to the real timer. */
  backoffSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  emit: (event: ClientEvent) => void;
}

/**
 * Owns the sub-agent tasks of one session: spawns agents whose rows and
 * transcripts go to the store (session/agents.ts), relays their live
 * responses as `task_delta` events, delivers their completion as
 * notifications, and routes agent-to-agent messages (mesh: any agent can
 * reach any other in the session's tree).
 *
 * The lifecycle is bound to the session (owned by the session pool), not to
 * one agent: sub-agents run independently of the agent run — aborting a run
 * never stops them — and survive agent rebuilds. close() aborts them all.
 *
 * The facade over the pieces: the roster (subagent-registry.ts), the runs
 * (subagent-run.ts), the tool sets (subagent-tools.ts), the spawn
 * (subagent-spawn.ts), the routing (subagent-mesh.ts) and the restore
 * (subagent-restore.ts). What stays here is the session's own state and the
 * seams the pool turns.
 */
/** The hub the task-family tools are written against (see SubagentHub): a
 * signature that moves on this class and not on the interface fails to
 * compile here. */
export type TaskHubImplementsToolsSeam = TaskHub extends SubagentHub
  ? true
  : never;

export class TaskHub {
  private readonly subagents: SubagentRegistry;
  private readonly runner: SubagentRunner;
  private readonly mesh: SubagentMesh;
  private readonly wiring: SubagentToolWiring;
  /** The session's own state, as a spawn reads it (see subagent-spawn.ts). */
  private readonly session: SubagentSession;
  private readonly spawnHost: SubagentSpawnHost;
  private closed = false;

  private readonly sessionId: string;
  /** The session's main agent (see TaskHubOptions.mainAgentId). */
  private readonly mainAgentId: string;
  private readonly agents: AgentRepo;

  constructor(options: TaskHubOptions) {
    this.sessionId = options.sessionId;
    this.mainAgentId = options.mainAgentId;
    this.agents = options.agents;
    this.subagents = new SubagentRegistry(options.mainAgentId);
    this.session = new SubagentSession({
      resolveRuntime: options.resolveRuntime,
      language: options.language ?? DEFAULT_LOCALE,
      compactionPolicy: options.compactionPolicy,
    });
    this.mesh = new SubagentMesh({
      mainAgentId: this.mainAgentId,
      roster: this.subagents,
      isClosed: () => this.closed,
    });
    this.runner = new SubagentRunner({
      sessionId: this.sessionId,
      roster: this.subagents,
      agents: this.agents,
      emit: options.emit,
      notify: (parentId, payload) => this.mesh.notify(parentId, payload),
      isClosed: () => this.closed,
      backoffSleep: options.backoffSleep ?? sleepAbortable,
    });
    this.wiring = new SubagentToolWiring({
      runningAgents: () => this.subagents.all(),
    });
    this.spawnHost = {
      hub: this,
      sessionId: this.sessionId,
      agents: this.agents,
      messages: options.messages,
      roster: this.subagents,
      runner: this.runner,
      settings: this.session,
      safety: options.safety,
      streamFn: options.streamFn,
      isClosed: () => this.closed,
      searchTools: () => this.wiring.searchTools(),
      compactBeforeStep: (agentId, signal) =>
        this.runner.compactBeforeStep(agentId, signal),
      emit: options.emit,
    };
    restoreSubagents({
      agents: this.agents,
      sessionId: this.sessionId,
      roster: this.subagents,
    });
  }

  /** Replace the runtime resolver (called on every session open/rebuild so
   * the closure never holds a stale session or model). */
  setRuntimeResolver(resolver: () => SubagentRuntime): void {
    this.session.resolveRuntime = resolver;
  }

  /** Set the language sub-agents answer in (called on every session
   * open/rebuild, like setRuntimeResolver, so a language change applies to
   * the sub-agents spawned after it — running ones keep the language they
   * were started with). */
  setLanguage(language: Locale): void {
    this.session.language = language;
  }

  /** Set the user's web-search provider (called on every session
   * open/rebuild, so a provider configured or changed later reaches the
   * sub-agents spawned after it). */
  setWebSearch(provider: SearchProvider | undefined): void {
    this.session.webSearch = provider;
  }

  /** Set the computers lending folders to this session (called on every
   * session open/rebuild, like the web provider). Read at spawn: a loan made
   * after a sub-agent started does not reach it, exactly like the skill
   * catalog it was seeded with. */
  setShares(hub: ShareHub | undefined): void {
    this.session.sharesHub = hub;
  }

  /** Attach the session's shared MCP attachment and tool registry: general
   * sub-agents get the tool_search / tool_call pair over the registry —
   * spawned ones read it at spawn, agents still running while discovery was
   * in flight receive the pair when it finishes (see SubagentToolWiring). */
  setMcp(
    attachment: McpAttachment | null,
    registry: ToolRegistry | null,
  ): void {
    this.wiring.set(attachment, registry);
  }

  /** Hook the parent (main) session agent into the hub: it receives task
   * completion notifications and messages while the session is open. The
   * session agent registers itself on construction and deregisters on
   * close. */
  setParentDelivery(delivery: ParentDelivery | null): void {
    this.mesh.setParentDelivery(delivery);
  }

  /** The task-family tools of the parent (main) agent. */
  parentTools(): Tool[] {
    return createTaskFamilyTools(this, this.mainAgentId, 0, true);
  }

  /** Start a sub-agent for `parentId` (the parent agent is the session id)
   * and return its snapshot immediately — the agent runs in the background
   * and the caller keeps working; completion is reported via a notification
   * (or a waiting task_output). */
  spawn(
    parentId: string,
    parentDepth: number,
    type: SubagentType,
    description: string,
    prompt: string,
  ): TaskInfo {
    return spawnSubagent(this.spawnHost, {
      parentId,
      parentDepth,
      type,
      description,
      prompt,
    });
  }

  /** Snapshot of one sub-agent for task_output and the resync endpoint. */
  info(agentId: string): TaskInfo {
    return this.subagents.info(agentId);
  }

  /** Snapshots of every sub-agent, newest first (the tasks resync
   * endpoint; mirrors the todo plan snapshot). */
  list(): TaskInfo[] {
    return this.subagents.list();
  }

  /** Register a blocking wait on a sub-agent. Resolves when the agent
   * settles, when the timeout elapses (with the current state), or rejects
   * when the caller's run aborts — a torn-down run must never leave a tool
   * hanging. */
  wait(
    agentId: string,
    callerId: string,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<TaskInfo> {
    return this.subagents.wait(agentId, callerId, timeoutSec, signal);
  }

  /** Send a message from one agent to another (mesh). The target receives
   * it as a "[Message from ...]" user message: steered into a running
   * agent, or injected as a fresh run when the parent is idle. */
  sendMessage(
    from: string,
    to: string,
    summary: string,
    message: string,
  ): { deliveredTo: string } {
    return this.mesh.send(from, to, summary, message);
  }

  /** Abort every running sub-agent and drop the parent delivery hook.
   * Called by the session pool when the session closes. */
  close(): void {
    this.closed = true;
    this.mesh.setParentDelivery(null);
    for (const sub of [...this.subagents.all()]) {
      if (sub.status !== "running") continue;
      // Running agents always have a live Agent (finalize releases it).
      sub.abort.abort();
      sub.agent!.abort();
      this.runner.finalize(sub, "aborted");
    }
  }
}
