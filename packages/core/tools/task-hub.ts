import { Agent } from "../ai/agent.ts";
import type { AgentEvent, StreamFn } from "../ai/types.ts";
import type { Api, AssistantMessage, Model } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import {
  MAX_RATE_LIMIT_RETRIES,
  rateLimitRetryDelayMs,
  sleepAbortable,
} from "../ai/rate-limit.ts";
import { isRetryableRateLimit } from "../agent/llm-retry.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import {
  addToolsToAgent,
  appendMcpToolsNote,
  registryToolPair,
} from "../mcp/tools.ts";
import type { ToolRegistry } from "./registry.ts";
import type { NotificationPayload } from "../types/notification.ts";
import { toLlmMessages } from "../types/notification.ts";
import type {
  SubagentStatus,
  SubagentType,
  TaskInfo,
  ThinkingLevel,
} from "../shared/mod.ts";
import type { ClientEvent } from "../types/event.ts";
import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { createBashTool } from "./bash.ts";
import { createEvalTool } from "./eval.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import { toAgentTool } from "./pi-adapter.ts";
import type { Tool } from "./schema.ts";
import {
  readOnlyInvestigationTools,
  sandboxFileTools,
  sessionSkills,
} from "./toolsets.ts";
import { createSkillTool } from "../skills/tool.ts";
import {
  formatTaskCompletion,
  lastAssistantText,
  notificationMessage,
  subagentSystemPrompt,
} from "./subagent-format.ts";
import {
  createSendMessageTool,
  createTaskOutputTool,
  createTaskTool,
} from "./task.ts";

/** Concurrent sub-agents per session. Bounds LLM parallelism and memory;
 * the task tool reports the limit so the agent can wait for a slot. */
export const MAX_SUBAGENTS = 8;
/** Nesting depth of sub-agents (the parent agent is depth 0). At the limit
 * the task tool is not part of the tool set, so no deeper chains can form. */
export const MAX_SUBAGENT_DEPTH = 2;
/** Live-response tail reported while a sub-agent runs. */
const TASK_TAIL_LIMIT = 8 * 1024;
/** Settled sub-agents kept queryable (task_output / resync) per session;
 * older entries are dropped so a long session's metadata stays bounded. */
const MAX_FINISHED_SUBAGENTS = 100;
/** `to` values of send_message that resolve to the caller's parent agent. */
const PARENT_ALIASES = ["parent", "main"] as const;

/** Read-only investigation tools of the `explore` sub-agent. */
function exploreTools(
  workspace: Workspace,
  browserAvailable: boolean,
): Tool[] {
  const sandbox = new Sandbox(workspace.folders);
  return [
    ...readOnlyInvestigationTools(sandbox),
    createSkillTool({
      skills: sessionSkills(workspace.folders, { browserAvailable }),
    }),
  ];
}

/** Full coding tool set of the `general` sub-agent: the session's tools
 * without ask/todo/async_bash. Sub-agents have no UI round trip (ask), no
 * plan panel of their own (todo), and no background commands that would
 * outlive them (async_bash). `safety` (when present) gates their bash/eval
 * tools like the main agent's; browser-lab tools are not preloaded either
 * — general sub-agents reach them through the session's tool registry via
 * the search/call pair, exactly like the main agent. */
function generalTools(
  workspace: Workspace,
  safety: CommandSafety | undefined,
  browserAvailable: boolean,
): Tool[] {
  const sandbox = new Sandbox(workspace.folders);
  return [
    ...sandboxFileTools(sandbox),
    createBashTool({ sandbox, safety }),
    createEvalTool({ safety }),
    createSkillTool({
      skills: sessionSkills(workspace.folders, { browserAvailable }),
    }),
  ];
}

/** One live sub-agent and its runtime state. `agent` is released (set to
 * null) once the run settles — only the lightweight snapshot fields stay
 * queryable — so finished sub-agents cannot pin their message history in
 * memory for the rest of the session. */
interface Subagent {
  id: string;
  parentId: string;
  type: SubagentType;
  depth: number;
  description: string;
  status: SubagentStatus;
  agent: Agent | null;
  startedAt: number;
  finishedAt?: number;
  /** Tail of the current response (bounded; reported while running). */
  tail: string;
  /** Final response text once the run settled. */
  resultText: string;
  unsubscribe: () => void;
  waiters: Set<Waiter>;
  /** Aborts the backoff sleep of a rate-limit retry when the sub-agent is
   * killed or the session closes, so a stop during the wait is not ignored. */
  abort: AbortController;
}

/** A blocking task_output wait on a running sub-agent. */
interface Waiter {
  /** The agent that issued the wait (used to suppress the completion
   * notification when it receives the result through the tool instead). */
  callerId: string;
  settle: (info: TaskInfo) => void;
  cancel: () => void;
}

/** The runtime a new sub-agent spawns into: the workspace (tool sandbox),
 * the model, and its stored thinking level. */
export interface SubagentRuntime {
  workspace: Workspace;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
}

/** Where the parent (main) agent receives injected notifications. Set by
 * the session agent while the session is open. */
export interface ParentDelivery {
  isActive(): boolean;
  deliver(payload: NotificationPayload): void;
}

export interface TaskHubOptions {
  /** The parent (main) session this hub's agents belong to. Its id is also
   * the parent agent's id. */
  sessionId: string;
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
  emit: (event: ClientEvent) => void;
}

/**
 * Owns the sub-agent tasks of one session: spawns ephemeral agents (in
 * memory only — nothing is persisted), relays their live responses as
 * `task_delta` events, delivers their completion as notifications, and
 * routes agent-to-agent messages (mesh: any agent can reach any other in
 * the session's tree).
 *
 * The lifecycle is bound to the session (owned by the session pool), not to
 * one agent: sub-agents run independently of the agent run — aborting a run
 * never stops them — and survive agent rebuilds. close() aborts them all.
 */
export class TaskHub {
  private readonly subs = new Map<string, Subagent>();
  private counter = 0;
  private parentDelivery: ParentDelivery | null = null;
  private closed = false;

  private readonly sessionId: string;
  private resolveRuntime: () => SubagentRuntime;
  private readonly streamFn: StreamFn;
  private readonly safety: CommandSafety | undefined;
  private readonly emit: (event: ClientEvent) => void;
  /** Whether the session has a browser backend attached (set by the pool on
   * every open). Gates the built-in web-browser skill in the sub-agent tool
   * sets, matching the main agent's tool set and prompt listing. */
  private browserAvailable = false;
  /** The session's tool registry (set by the pool on every open): holds
   * every discoverable tool (MCP tools, browser-lab tools, future
   * extensions) whose definitions stay out of the LLM context. General
   * sub-agents get the tool_search / tool_call pair over it. */
  private registry: ToolRegistry | null = null;
  /** The attachment whose discovery has been (or will be) applied to the
   * registry and the running sub-agents. Guards against stale callbacks: a
   * config change replaces the attachment mid-discovery, and the old
   * attachment's ready must not overwrite the current registry or attach
   * its tools. */
  private handledAttachment: McpAttachment | null = null;

  constructor(options: TaskHubOptions) {
    this.sessionId = options.sessionId;
    this.resolveRuntime = options.resolveRuntime;
    this.streamFn = options.streamFn;
    this.safety = options.safety;
    this.emit = options.emit;
  }

  /** Replace the runtime resolver (called on every session open/rebuild so
   * the closure never holds a stale session or model). */
  setRuntimeResolver(resolver: () => SubagentRuntime): void {
    this.resolveRuntime = resolver;
  }

  /** Set whether the session has a browser backend attached (called on
   * every session open/rebuild like setRuntimeResolver, so the gate never
   * holds a stale value across attach/detach). */
  setBrowserAvailable(browserAvailable: boolean): void {
    this.browserAvailable = browserAvailable;
  }

  /** Attach the session's shared MCP attachment and tool registry: general
   * sub-agents get the tool_search / tool_call pair over the registry —
   * spawned ones read it at spawn, agents still running while discovery was
   * in flight receive the pair when it finishes. Only the current
   * attachment is registered for: an attachment replaced by a config
   * change must never apply its (stale or empty) tools. */
  setMcp(
    attachment: McpAttachment | null,
    registry: ToolRegistry | null,
  ): void {
    this.registry = registry;
    if (attachment !== null && attachment !== this.handledAttachment) {
      this.handledAttachment = attachment;
      attachment.whenReady((tools) =>
        this.attachMcpToRunning(attachment, tools)
      );
    }
  }

  /** Discovery finished for the session's current attachment: merge the
   * MCP tools into the session's tool registry (which the pool may already
   * have seeded with browser-lab tools — discovery must never wipe them)
   * and attach the search/call pair — plus the on-demand-tools note — to
   * every running general sub-agent that spawned before the registry held
   * anything. Callbacks of older attachments (a config change replaced the
   * manager mid-discovery) return here: only the current attachment may
   * write the registry. */
  private attachMcpToRunning(attachment: McpAttachment, tools: Tool[]): void {
    if (attachment !== this.handledAttachment) return;
    if (this.registry === null) return;
    this.registry.addTools(tools);
    if (this.registry.isEmpty) return;
    const pair = this.searchTools();
    for (const sub of this.subs.values()) {
      if (sub.status !== "running" || sub.type !== "general") continue;
      if (sub.agent === null) continue;
      addToolsToAgent(sub.agent, pair);
      sub.agent.state.systemPrompt = appendMcpToolsNote(
        sub.agent.state.systemPrompt,
      );
    }
  }

  /** The tool_search / tool_call pair backed by the session's registry
   * (empty when the session has no discoverable tools). The pair resolves
   * the registry through a provider, so a config change that swaps the
   * registry (pool.open with a new MCP attachment) redirects pairs already
   * attached to running sub-agents without replacing them. */
  private searchTools(): Tool[] {
    if (this.registry === null || this.registry.isEmpty) return [];
    return registryToolPair(() => this.registry!);
  }

  /** Hook the parent (main) session agent into the hub: it receives task
   * completion notifications and messages while the session is open. The
   * session agent registers itself on construction and deregisters on
   * close. */
  setParentDelivery(delivery: ParentDelivery | null): void {
    this.parentDelivery = delivery;
  }

  /** The task-family tools of the parent (main) agent. */
  parentTools(): Tool[] {
    return this.agentTools(this.sessionId, 0, true);
  }

  /** The task-family tools of one sub-agent. `canDelegate` gates the task
   * and task_output tools (the depth limit); send_message is always present
   * — it is how agents communicate. */
  private agentTools(
    agentId: string,
    depth: number,
    canDelegate: boolean,
  ): Tool[] {
    const tools: Tool[] = [createSendMessageTool(this, agentId)];
    if (canDelegate) {
      tools.push(
        createTaskTool(this, agentId, depth),
        createTaskOutputTool(this, agentId),
      );
    }
    return tools;
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
    if (this.closed) {
      throw new CoreError("The session is closed", "unavailable");
    }
    const running = [...this.subs.values()]
      .filter((sub) => sub.status === "running").length;
    if (running >= MAX_SUBAGENTS) {
      throw new CoreError(
        `Too many agents running (max ${MAX_SUBAGENTS}); wait for one to ` +
          `finish or check them with task_output`,
        "unavailable",
      );
    }
    const id = `agent_${++this.counter}`;
    const depth = parentDepth + 1;
    const canDelegate = type === "general" && depth < MAX_SUBAGENT_DEPTH;
    const runtime = this.resolveRuntime();
    // General sub-agents share the session's discoverable tools through
    // the registry (seeded by the pool with browser-lab tools before any
    // spawn; MCP tools merge in when discovery finishes — sub-agents
    // spawned before that get the pair via attachMcpToRunning).
    const searchable = type === "general" ? this.searchTools() : [];
    const tools = [
      ...(type === "general"
        ? generalTools(
          runtime.workspace,
          this.safety,
          this.browserAvailable,
        )
        : exploreTools(runtime.workspace, this.browserAvailable)),
      ...searchable,
      ...this.agentTools(id, depth, canDelegate),
    ];
    const basePrompt = subagentSystemPrompt(
      id,
      parentId,
      type,
      canDelegate,
    );
    const systemPrompt = searchable.length > 0
      ? appendMcpToolsNote(basePrompt)
      : basePrompt;
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: runtime.model,
        tools: tools.map(toAgentTool),
        thinkingLevel: runtime.thinkingLevel,
      },
      streamFn: this.streamFn,
      sessionId: id,
      // Steered notifications must reach the sub-agent's LLM as user
      // messages (the default conversion would drop their role).
      convertToLlm: (messages) => toLlmMessages(messages),
    });
    const abort = new AbortController();
    const sub: Subagent = {
      id,
      parentId,
      type,
      depth,
      description,
      status: "running",
      agent,
      startedAt: Date.now(),
      tail: "",
      resultText: "",
      unsubscribe: agent.subscribe((event) => this.handleEvent(sub, event)),
      waiters: new Set(),
      abort,
    };
    this.subs.set(id, sub);
    this.emit({
      type: "task_start",
      sessionId: this.sessionId,
      agentId: id,
      parentAgentId: parentId,
      subagentType: type,
      description,
    });
    void this.runSubagent(sub, agent, prompt);
    return this.info(id);
  }

  /** Run a sub-agent to completion, retrying rate-limited (429) turns with
   * exponential backoff. The first attempt uses the spawn prompt; a rate-limit
   * failure drops the empty error turn and continues from the same prompt (no
   * duplicate user message), backing off before each retry up to
   * MAX_RATE_LIMIT_RETRIES times. Any other outcome — success, a non-rate
   * error, an abort, or the exhausted budget — settles the sub-agent once. */
  private async runSubagent(
    sub: Subagent,
    agent: Agent,
    prompt: string,
  ): Promise<void> {
    let first = true;
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES + 1; attempt++) {
      if (sub.agent === null || this.closed) return;
      try {
        if (first) {
          await agent.prompt(prompt);
          first = false;
        } else {
          await agent.continue();
        }
      } catch {
        // The agent rejected (a race with another run): settle as failed.
        this.finalize(sub, "failed", "Sub-agent run was interrupted");
        return;
      }
      if (sub.agent === null || this.closed) return;
      const last = sub.agent.state.messages.at(-1) as
        | AssistantMessage
        | undefined;
      const rateLimited = last !== undefined &&
        last.role === "assistant" &&
        isRetryableRateLimit(last);
      if (!rateLimited) break;
      if (attempt >= MAX_RATE_LIMIT_RETRIES + 1) break;
      // Drop the failed error turn so the continuation re-uses the prompt.
      const messages = sub.agent.state.messages;
      if (messages.length > 0 && messages.at(-1)!.role === "assistant") {
        sub.agent.state.messages = messages.slice(0, -1);
      }
      try {
        await sleepAbortable(rateLimitRetryDelayMs(attempt), sub.abort.signal);
      } catch {
        // Aborted during backoff (session closed / killed): leave the error
        // surfaced and settle.
        this.finalize(sub, "failed", sub.agent.state.errorMessage);
        return;
      }
      if (sub.agent === null || this.closed) return;
    }
    const last = sub.agent?.state.messages.at(-1) as
      | AssistantMessage
      | undefined;
    this.finalize(
      sub,
      // Still running here (finalize settles it), so the agent is live.
      last?.stopReason === "error" ? "failed" : "finished",
      sub.agent?.state.errorMessage,
    );
  }

  /** Resolve a sub-agent by id, or throw with the list of known ids. */
  private require(agentId: string): Subagent {
    const sub = this.subs.get(agentId);
    if (sub === undefined) {
      throw new CoreError(
        `Unknown agent: ${agentId}. Known agents: ${this.knownIds()}`,
        "not_found",
      );
    }
    return sub;
  }

  /** Snapshot of one sub-agent for task_output and the resync endpoint. */
  info(agentId: string): TaskInfo {
    return this.infoOf(this.require(agentId));
  }

  private infoOf(sub: Subagent): TaskInfo {
    return {
      agentId: sub.id,
      parentAgentId: sub.parentId,
      subagentType: sub.type,
      description: sub.description,
      status: sub.status,
      startedAt: sub.startedAt,
      ...(sub.finishedAt !== undefined ? { finishedAt: sub.finishedAt } : {}),
      text: sub.status === "running" ? sub.tail : sub.resultText,
    };
  }

  /** Snapshots of every sub-agent, newest first (the tasks resync
   * endpoint; mirrors the todo plan snapshot). */
  list(): TaskInfo[] {
    return [...this.subs.values()].map((sub) => this.infoOf(sub)).reverse();
  }

  private knownIds(): string {
    return [this.sessionId, ...this.subs.keys()].join(", ");
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
    const sub = this.require(agentId);
    if (sub.status !== "running") return Promise.resolve(this.infoOf(sub));
    if (signal?.aborted) {
      return Promise.reject(
        new CoreError(`Cancelled while waiting for ${agentId}`, "unavailable"),
      );
    }
    return new Promise<TaskInfo>((resolve, reject) => {
      let settled = false;
      const onAbort = () => waiter.cancel();
      const cleanup = () => {
        settled = true;
        sub.waiters.delete(waiter);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        callerId,
        settle: (info) => {
          cleanup();
          resolve(info);
        },
        cancel: () => {
          cleanup();
          reject(
            new CoreError(
              `Cancelled while waiting for ${agentId}`,
              "unavailable",
            ),
          );
        },
      };
      const timer = timeoutSec > 0
        ? setTimeout(() => {
          if (settled) return;
          cleanup();
          resolve(this.infoOf(sub));
        }, timeoutSec * 1000)
        : undefined;
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) {
        waiter.cancel();
        return;
      }
      sub.waiters.add(waiter);
    });
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
    if (this.closed) {
      throw new CoreError("The session is closed", "unavailable");
    }
    if ((PARENT_ALIASES as readonly string[]).includes(to)) {
      const parentId = this.parentOf(from);
      if (parentId === undefined) {
        throw new CoreError("The main agent has no parent", "invalid");
      }
      this.deliverTo(parentId, from, summary, message);
      return { deliveredTo: parentId };
    }
    this.deliverTo(to, from, summary, message);
    return { deliveredTo: to };
  }

  private parentOf(agentId: string): string | undefined {
    if (agentId === this.sessionId) return undefined;
    return this.subs.get(agentId)?.parentId;
  }

  /** Route an explicit message. Throws when the target is unknown or no
   * longer active, so the calling agent learns immediately instead of
   * silently losing the message. */
  private deliverTo(
    targetId: string,
    from: string,
    summary: string,
    message: string,
  ): void {
    const payload: NotificationPayload = {
      kind: "message",
      title: `[Message from ${from} (${summary})]`,
      body: message,
      status: "neutral",
    };
    if (targetId === this.sessionId) {
      if (this.parentDelivery === null || !this.parentDelivery.isActive()) {
        throw new CoreError("The main agent is not active", "unavailable");
      }
      this.parentDelivery.deliver(payload);
      return;
    }
    const sub = this.subs.get(targetId);
    if (sub === undefined) {
      throw new CoreError(
        `Unknown agent: ${targetId}. Known agents: ${this.knownIds()}`,
        "not_found",
      );
    }
    if (sub.status !== "running") {
      throw new CoreError(
        `Agent is not active: ${targetId} (${sub.status})`,
        "unavailable",
      );
    }
    // Running agents always have a live Agent (finalize releases it).
    sub.agent!.steer(notificationMessage(payload));
  }

  /** Best-effort notification to the agent that spawned a task: the parent
   * agent gets it through the delivery hook (steer while running, a fresh
   * run while idle); a finished or aborted sub-agent can no longer act, so
   * the message is dropped. */
  private notify(parentId: string, payload: NotificationPayload): void {
    if (parentId === this.sessionId) {
      if (this.parentDelivery?.isActive()) {
        this.parentDelivery.deliver(payload);
      }
      return;
    }
    const sub = this.subs.get(parentId);
    if (sub !== undefined && sub.status === "running") {
      // Running agents always have a live Agent (finalize releases it).
      sub.agent!.steer(notificationMessage(payload));
    }
  }

  private handleEvent(sub: Subagent, event: AgentEvent): void {
    if (event.type !== "message_update") return;
    const inner = event.assistantMessageEvent;
    if (inner.type !== "text_delta") return;
    sub.tail = (sub.tail + inner.delta).slice(-TASK_TAIL_LIMIT);
    this.emit({
      type: "task_delta",
      sessionId: this.sessionId,
      agentId: sub.id,
      delta: inner.delta,
    });
  }

  /** Settle a sub-agent run: capture the result, resolve waiters, emit the
   * end event, and notify the spawning agent — unless it is waiting on this
   * task right now (it gets the result through task_output instead).
   * Idempotent: close() may settle the run first. */
  private finalize(
    sub: Subagent,
    status: SubagentStatus,
    failure?: string,
  ): void {
    if (sub.status !== "running") return;
    sub.status = status;
    sub.finishedAt = Date.now();
    sub.resultText = lastAssistantText(sub.agent!.state.messages);
    sub.unsubscribe();
    // The agent's message history is no longer needed: release it so a
    // long session's finished tasks cannot pin unbounded memory. Only the
    // snapshot fields (kept below) stay queryable.
    sub.agent = null;
    const parentWaiting = [...sub.waiters].some(
      (waiter) => waiter.callerId === sub.parentId,
    );
    const snapshot = this.infoOf(sub);
    for (const waiter of sub.waiters) waiter.settle(snapshot);
    sub.waiters.clear();
    this.emit({
      type: "task_end",
      sessionId: this.sessionId,
      agentId: sub.id,
      status,
    });
    if (!parentWaiting && !this.closed) {
      this.notify(sub.parentId, formatTaskCompletion(snapshot, failure));
    }
    this.evictFinished();
  }

  /** Drop the oldest settled sub-agents beyond MAX_FINISHED_SUBAGENTS, so
   * the metadata kept for task_output / resync stays bounded. */
  private evictFinished(): void {
    if (this.subs.size <= MAX_FINISHED_SUBAGENTS) return;
    for (const [id, sub] of this.subs) {
      if (sub.status === "running") continue;
      this.subs.delete(id);
      if (this.subs.size <= MAX_FINISHED_SUBAGENTS) return;
    }
  }

  /** Abort every running sub-agent and drop the parent delivery hook.
   * Called by the session pool when the session closes. */
  close(): void {
    this.closed = true;
    this.parentDelivery = null;
    for (const sub of [...this.subs.values()]) {
      if (sub.status !== "running") continue;
      // Running agents always have a live Agent (finalize releases it).
      sub.abort.abort();
      sub.agent!.abort();
      this.finalize(sub, "aborted");
    }
  }
}
