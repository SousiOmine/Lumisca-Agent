import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { contentText } from "../content.ts";
import { CoreError, errorMessage } from "../errors.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import type {
  NotificationMessage,
  NotificationPayload,
} from "../types/notification.ts";
import { toLlmMessages } from "../types/notification.ts";
import {
  type SubagentStatus,
  type SubagentType,
  type TaskInfo,
  type ThinkingLevel,
  TOOL_SEND_MESSAGE,
  TOOL_TASK,
  TOOL_TASK_OUTPUT,
} from "../shared.ts";
import { discoverSkills, type SkillDef } from "../skills/discover.ts";
import { createSkillTool } from "../skills/tool.ts";
import type { ClientEvent } from "../types/event.ts";
import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { createBashTool } from "./bash.ts";
import { createEvalTool } from "./eval.ts";
import {
  createEditFileTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from "./filesystem.ts";
import { toAgentTool } from "./pi-adapter.ts";
import {
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";
import { createGlobTool, createGrepTool } from "./search.ts";
import { MAX_TOOL_OUTPUT, truncate, truncatedNote } from "./truncate.ts";

/** Concurrent sub-agents per session. Bounds LLM parallelism and memory;
 * the task tool reports the limit so the agent can wait for a slot. */
export const MAX_SUBAGENTS = 8;
/** Nesting depth of sub-agents (the parent agent is depth 0). At the limit
 * the task tool is not part of the tool set, so no deeper chains can form. */
export const MAX_SUBAGENT_DEPTH = 2;
/** Live-response tail reported while a sub-agent runs. */
const TASK_TAIL_LIMIT = 8 * 1024;
/** `to` values of send_message that resolve to the caller's parent agent. */
const PARENT_ALIASES = ["parent", "main"] as const;

/** Skills for a sub-agent, in the same precedence order as the session's:
 * workspace `.agents/skills`, then agent plugin skills, then global. */
function subagentSkills(folders: string[]): SkillDef[] {
  const plugins = discoverPlugins(folders);
  return discoverSkills(folders, {
    pluginSkills: plugins.flatMap((p) => p.skills),
  });
}

/** Read-only investigation tools of the `explore` sub-agent. */
function exploreTools(workspace: Workspace): Tool[] {
  const sandbox = new Sandbox(workspace.folders);
  return [
    createReadFileTool({ sandbox }),
    createListDirTool({ sandbox }),
    createGrepTool({ sandbox }),
    createGlobTool({ sandbox }),
    createSkillTool({ skills: subagentSkills(workspace.folders) }),
  ];
}

/** Full coding tool set of the `general` sub-agent: the session's tools
 * without ask/todo/async_bash. Sub-agents have no UI round trip (ask), no
 * plan panel of their own (todo), and no background commands that would
 * outlive them (async_bash). */
function generalTools(workspace: Workspace): Tool[] {
  const sandbox = new Sandbox(workspace.folders);
  return [
    createReadFileTool({ sandbox }),
    createWriteFileTool({ sandbox }),
    createEditFileTool({ sandbox }),
    createListDirTool({ sandbox }),
    createGrepTool({ sandbox }),
    createGlobTool({ sandbox }),
    createBashTool({ sandbox }),
    createEvalTool(),
    createSkillTool({ skills: subagentSkills(workspace.folders) }),
  ];
}

/** The system prompt of one sub-agent. Teaches the notification prefixes so
 * injected messages are never mistaken for user input, and the agent ids so
 * send_message can address the right agent. */
function subagentSystemPrompt(
  agentId: string,
  parentId: string,
  type: SubagentType,
  canDelegate: boolean,
): string {
  const role = type === "explore" ? "research" : "coding";
  const lines = [
    `You are a ${role} sub-agent of Lumisca, started by agent ${parentId} ` +
    `to handle one piece of work. Your own id is ${agentId}.`,
    `Work on the assigned task and answer with a complete final report as ` +
    `your last message.`,
    `- A message starting with "[Message from ...]" is a message from ` +
    `another agent, not from the user: answer it with send_message or ` +
    `fold it into your work.`,
    `- If you need input mid-task, send a message to ${parentId} with ` +
    `send_message. You cannot ask the user directly.`,
  ];
  if (type === "explore") {
    lines.push(
      `- You are read-only: investigate with read/grep/glob/list_dir/skill ` +
        `and report findings with file references (path:line). Never modify ` +
        `files or run commands.`,
      `- Be thorough before concluding: the parent agent relies on your ` +
        `report.`,
    );
  } else {
    if (canDelegate) {
      lines.push(
        `- You can delegate independent work to further sub-agents with the ` +
          `task tool: they start in the background, so keep working while ` +
          `they run. Their completion arrives as a "[Task ...]" ` +
          `notification, or use task_output (wait: true) when your next ` +
          `step depends on the result.`,
      );
    }
    lines.push(
      `- Make the final report self-contained: what you did, what you ` +
        `found, and what remains open.`,
    );
  }
  return lines.join("\n");
}

/** The text of the final assistant message of a finished sub-agent run. */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant") return contentText(message.content);
  }
  return "";
}

function notificationMessage(
  payload: NotificationPayload,
): NotificationMessage {
  return {
    role: "notification",
    ...payload,
    timestamp: Date.now(),
  };
}

/** The notification injected into the spawning agent's loop when a
 * sub-agent completes. The title starts with "[Task ...]" so system prompts
 * can teach agents to recognize it as a system notification. */
function formatTaskCompletion(
  sub: Subagent,
  failure?: string,
): NotificationPayload {
  if (sub.status === "finished") {
    const result = truncate(sub.resultText, MAX_TOOL_OUTPUT);
    return {
      kind: "task",
      title: `[Task ${sub.id} (${sub.description}) finished]`,
      body: result.text +
        (result.truncated ? truncatedNote("task result") : ""),
      status: "success",
    };
  }
  const verb = sub.status === "aborted" ? "was aborted" : "failed";
  return {
    kind: "task",
    title: `[Task ${sub.id} (${sub.description}) ${verb}]`,
    body: failure ?? "",
    status: "error",
  };
}

/** The text shown by task_output for one task. */
function formatTaskOutput(info: TaskInfo): string {
  const head =
    `Agent ${info.agentId} (${info.subagentType}, ${info.description}): ${info.status}`;
  const text = info.text.trim();
  if (info.status === "running") {
    return text.length > 0 ? `${head}\nLive output (tail):\n${text}` : head;
  }
  return text.length > 0 ? `${head}\n${text}` : head;
}

/** One live sub-agent and its runtime state. */
interface Subagent {
  id: string;
  parentId: string;
  type: SubagentType;
  depth: number;
  description: string;
  status: SubagentStatus;
  agent: Agent;
  startedAt: number;
  finishedAt?: number;
  /** Tail of the current response (bounded; reported while running). */
  tail: string;
  /** Final response text once the run settled. */
  resultText: string;
  unsubscribe: () => void;
  waiters: Set<Waiter>;
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
  private readonly emit: (event: ClientEvent) => void;
  /** The session's shared MCP attachment (set by the pool on every open):
   * general sub-agents get its tools. */
  private mcp: McpAttachment | null = null;

  constructor(options: TaskHubOptions) {
    this.sessionId = options.sessionId;
    this.resolveRuntime = options.resolveRuntime;
    this.streamFn = options.streamFn;
    this.emit = options.emit;
  }

  /** Replace the runtime resolver (called on every session open/rebuild so
   * the closure never holds a stale session or model). */
  setRuntimeResolver(resolver: () => SubagentRuntime): void {
    this.resolveRuntime = resolver;
  }

  /** Attach the session's shared MCP attachment: general sub-agents get
   * its tools — spawned ones read them at spawn, agents still running
   * while discovery was in flight receive them when it finishes. The
   * replacement is wholesale (all `mcp__` tools are swapped), so a config
   * change or a rebuild can never leave stale tools behind. */
  setMcp(attachment: McpAttachment | null): void {
    this.mcp = attachment;
    if (attachment !== null) {
      attachment.whenReady((tools) => this.attachMcpToRunning(tools));
    }
  }

  /** Attach MCP tools to every running general sub-agent, replacing any
   * older `mcp__` tools (a config change tears down the old manager's
   * processes, so its tools must not stay behind). */
  private attachMcpToRunning(tools: Tool[]): void {
    for (const sub of this.subs.values()) {
      if (sub.status !== "running" || sub.type !== "general") continue;
      this.attachMcpTools(sub, tools);
    }
  }

  private attachMcpTools(sub: Subagent, tools: Tool[]): void {
    sub.agent.state.tools = [
      ...sub.agent.state.tools.filter((t) => !t.name.startsWith("mcp__")),
      ...tools.map(toAgentTool),
    ];
    if (
      tools.length > 0 &&
      !sub.agent.state.systemPrompt.includes(
        "MCP tools (names starting with mcp__)",
      )
    ) {
      sub.agent.state.systemPrompt +=
        "\n\nNote: MCP tools (names starting with mcp__) can access resources outside the workspace.";
    }
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
    // General sub-agents share the session's MCP tools (empty while
    // discovery is still in flight — attachMcpToRunning adds them later).
    const mcpTools = type === "general" ? this.mcp?.getTools() ?? [] : [];
    const tools = [
      ...(type === "general"
        ? generalTools(runtime.workspace)
        : exploreTools(runtime.workspace)),
      ...mcpTools,
      ...this.agentTools(id, depth, canDelegate),
    ];
    const systemPrompt = subagentSystemPrompt(
      id,
      parentId,
      type,
      canDelegate,
    ) + (mcpTools.length > 0
      ? "\n\nNote: MCP tools (names starting with mcp__) can access resources outside the workspace."
      : "");
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
    void agent.prompt(prompt).then(
      () =>
        this.finalize(
          sub,
          sub.agent.state.errorMessage !== undefined ? "failed" : "finished",
          sub.agent.state.errorMessage,
        ),
      (error) => this.finalize(sub, "failed", errorMessage(error)),
    );
    return this.info(id);
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
    sub.agent.steer(notificationMessage(payload));
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
      sub.agent.steer(notificationMessage(payload));
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
    sub.resultText = lastAssistantText(sub.agent.state.messages);
    sub.unsubscribe();
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
      this.notify(sub.parentId, formatTaskCompletion(sub, failure));
    }
  }

  /** Abort every running sub-agent and drop the parent delivery hook.
   * Called by the session pool when the session closes. */
  close(): void {
    this.closed = true;
    this.parentDelivery = null;
    for (const sub of [...this.subs.values()]) {
      if (sub.status !== "running") continue;
      sub.agent.abort();
      this.finalize(sub, "aborted");
    }
  }
}

// --- tools -------------------------------------------------------------------

const taskSchema = object({
  subagent_type: string(
    'The kind of sub-agent to launch: "general" (full coding agent) or "explore" (read-only research)',
  ),
  description: string(
    "A short (3-5 word) description of the work, shown in the UI",
  ),
  prompt: string(
    "Complete, self-contained instructions for the sub-agent. It starts " +
      "with no context, so include every fact it needs.",
  ),
});

/** Build the tool that starts a sub-agent. The agent runs in the background
 * and the tool returns immediately, so the caller can keep working; the
 * result arrives later as a "[Task ...]" notification (or via
 * task_output). */
export function createTaskTool(
  hub: TaskHub,
  agentId: string,
  depth: number,
): Tool<typeof taskSchema> {
  return {
    name: TOOL_TASK,
    label: "Task",
    description:
      "Start a sub-agent that works on one job in the background while you " +
      "continue with other work. Returns immediately with the agent id. " +
      'The result arrives later as a "[Task ...]" notification; use ' +
      "task_output to check progress, or wait: true when your next step " +
      "depends on the result. Reach a running sub-agent with send_message.",
    parameters: taskSchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      if (
        params.subagent_type !== "general" &&
        params.subagent_type !== "explore"
      ) {
        throw new CoreError(
          `Unknown subagent_type "${params.subagent_type}": expected ` +
            `"general" or "explore"`,
          "invalid",
        );
      }
      const info = hub.spawn(
        agentId,
        depth,
        params.subagent_type,
        params.description,
        params.prompt,
      );
      return Promise.resolve({
        content: [{
          type: "text",
          text:
            `Task started: ${info.agentId} (${info.subagentType}) — ${info.description}\n` +
            `It runs in the background: continue with other work. Its ` +
            `completion arrives as a "[Task ${info.agentId} ...]" ` +
            `notification; check progress with task_output or reach it with ` +
            `send_message.`,
        }],
        details: { ...info },
      });
    },
  };
}

const taskOutputSchema = object({
  agent_id: string(
    "The id of the sub-agent (returned by the task tool when it was started)",
  ),
  wait: optional(boolean(
    "Wait until the agent finishes instead of returning immediately (default false)",
  )),
  timeout_sec: optional(integer(
    "With wait: how long to wait in seconds before returning the current state (default 30, max 300)",
  )),
});

/** Build the tool that reports on a sub-agent: its status and, when
 * settled, its final report; while running, the tail of its live response.
 * `wait: true` blocks the caller until the agent settles (bounded by
 * `timeout_sec`, and settled by the caller's run abort). */
export function createTaskOutputTool(
  hub: TaskHub,
  agentId: string,
): Tool<typeof taskOutputSchema> {
  return {
    name: TOOL_TASK_OUTPUT,
    label: "Task Output",
    description:
      "Check a sub-agent started with task: its status and, when finished, " +
      "its final report; while running, the tail of its live response. " +
      "Use wait: true to block until it finishes.",
    parameters: taskOutputSchema,
    async execute(_toolCallId, params, signal): Promise<ToolResult> {
      const timeoutSec = params.timeout_sec ?? 30;
      if (timeoutSec < 1 || timeoutSec > 300) {
        throw new CoreError(
          `timeout_sec must be between 1 and 300 (got ${timeoutSec})`,
          "invalid",
        );
      }
      const info = params.wait === true
        ? await hub.wait(params.agent_id, agentId, timeoutSec, signal)
        : hub.info(params.agent_id);
      return {
        content: [{ type: "text", text: formatTaskOutput(info) }],
        details: { ...info },
      };
    },
  };
}

const sendMessageSchema = object({
  to: string(
    'The id of the agent to message. Use "parent" to reach the agent that started this one.',
  ),
  summary: string("A short (5-10 word) summary of the message"),
  message: string("The full message text"),
});

/** Build the tool that sends a message to another agent (mesh: the main
 * agent or any sub-agent of the session's tree). The recipient sees it as a
 * "[Message from ...]" notification on its next step. */
export function createSendMessageTool(
  hub: TaskHub,
  agentId: string,
): Tool<typeof sendMessageSchema> {
  return {
    name: TOOL_SEND_MESSAGE,
    label: "Send Message",
    description:
      "Send a message to another agent (the main agent or a sub-agent " +
      'started with task). The recipient sees it as a "[Message from ' +
      '...]" notification on its next step. Use "parent" as the id to ' +
      "reach the agent that started this one. This only delivers the " +
      "message; replies arrive as messages from the other side.",
    parameters: sendMessageSchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      const { deliveredTo } = hub.sendMessage(
        agentId,
        params.to,
        params.summary,
        params.message,
      );
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Message sent to ${deliveredTo}: ${params.summary}`,
        }],
        details: { from: agentId, to: deliveredTo, summary: params.summary },
      });
    },
  };
}
