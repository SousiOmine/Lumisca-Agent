/**
 * Starting one sub-agent: the checks, the agent it runs on, the row it leaves,
 * and the run it starts.
 *
 * The hub (tools/task-hub.ts) owns the delegation protocol — who may spawn
 * whom, how deep a chain may go, and where a result goes — but the step itself
 * is a story of its own: a capacity check, a runtime to resolve, an agent to
 * assemble (tool set, prompt, seeded messages), a row written before anything
 * runs, a roster entry, and the event that tells clients a task began.
 *
 * The tools come from subagent-tools.ts (the coding set, the read-only set,
 * the session's search/call pair) and task.ts (the new agent's own task-family
 * tools); the agent is built by the agent layer (agent/subagent-runner.ts).
 * This module decides the ORDER, which is what makes a crashed spawn leave
 * nothing running.
 */
import { createSubagentAgent } from "../agent/subagent-runner.ts";
import { TranscriptStore } from "../agent/transcript.ts";
import type { Model } from "../ai/catalog.ts";
import { contextMessage } from "../ai/context-providers.ts";
import type { StreamFn } from "../ai/transport.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { Api } from "../domain/model.ts";
import { CoreError } from "../errors.ts";
import { withOnDemandToolsNote } from "../mcp/context.ts";
import type { Tool } from "../ports/tool.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { AgentRepo } from "../session/agents.ts";
import type { MessageRepo } from "../session/messages.ts";
import { createShareProvider, shareSeedMessages } from "../share/context.ts";
import type { ShareHub } from "../share/hub.ts";
import type {
  Locale,
  SubagentType,
  TaskInfo,
  ThinkingLevel,
} from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import { createSkillCatalogProvider } from "../skills/catalog.ts";
import type { SkillDef } from "../skills/discover.ts";
import type { SearchProvider } from "../websearch/types.ts";
import { toAgentTool } from "./pi-adapter.ts";
import { subagentSystemPrompt } from "./subagent-format.ts";
import type {
  Subagent,
  SubagentHub,
  SubagentRegistry,
} from "./subagent-registry.ts";
import type { SubagentRunner } from "./subagent-run.ts";
import { exploreTools, generalTools } from "./subagent-tools.ts";
import { createTaskFamilyTools } from "./task.ts";
import type { ToolBackends } from "./tool-pieces.ts";

/** Concurrent sub-agents per session. Bounds LLM parallelism and memory;
 * the task tool reports the limit so the agent can wait for a slot. */
export const MAX_SUBAGENTS = 8;
/** Nesting depth of sub-agents (the parent agent is depth 0). At the limit
 * the task tool is not part of the tool set, so no deeper chains can form. */
export const MAX_SUBAGENT_DEPTH = 2;

/** The runtime a new sub-agent spawns into: the tool backends the session
 * runs on (this machine or the stella VM), the model, its stored thinking
 * level, and the skill catalog its `skill` tool may load.
 *
 * The catalog is the session's, not a discovery of the hub's: a stella
 * conversation's skills live inside the machine, and only the runtime knows
 * how to read them. A getter because the coding set re-discovers on every
 * call (a skill written mid-session is loadable by the next call); a stella
 * session returns the catalog it read when the conversation opened, exactly
 * like the main agent's own skill tool does. */
export interface SubagentRuntime {
  backends: ToolBackends;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  /** Whether the sub-agent gets `eval`. False for a session that works
   * inside the stella machine: the tool runs in the server process, which
   * is exactly the boundary that mode exists to hold. */
  eval: boolean;
  /** The catalog the sub-agent may load: the session's catalog minus the
   * guides whose tools a sub-agent does not have (see
   * tool-pieces.subagentSkills). */
  skills: () => SkillDef[];
}

/**
 * What a spawn reads of its session: the state the pool re-sets on every
 * session open, and the runtime it resolves per spawn.
 *
 * A spawn reads it once and the sub-agent keeps what it was started with — a
 * language change, a new search provider or a loan made later reaches the
 * sub-agents spawned after it, not the ones already running. Mutable because
 * the hub outlives a session rebuild; the hub's setters write here.
 */
export class SubagentSession {
  /** The runtime a new sub-agent gets (the fast model with its stored
   * thinking level when configured, otherwise the session model). Read at
   * spawn time, so model/workspace/thinking-level changes apply without
   * waiting for a session rebuild. */
  resolveRuntime: () => SubagentRuntime;
  /** The language the sub-agents answer in (see tools/language). */
  language: Locale;
  /** The user's web-search provider. Undefined → no web tools in the set. */
  webSearch: SearchProvider | undefined;
  /** The computers lending folders to this session. Undefined → none are
   * named to the sub-agent (see shareSeedMessages). */
  sharesHub: ShareHub | undefined;
  /** The compaction tuning read from the settings store (see
   * shared/settings-keys.ts), passed on as the getter it is: the sub-agent
   * reads it on every check. Undefined → the default policy. */
  readonly compactionPolicy: (() => CompactionPolicyInput) | undefined;

  constructor(init: {
    resolveRuntime: () => SubagentRuntime;
    language: Locale;
    compactionPolicy: (() => CompactionPolicyInput) | undefined;
  }) {
    this.resolveRuntime = init.resolveRuntime;
    this.language = init.language;
    this.compactionPolicy = init.compactionPolicy;
  }
}

/** The one request the task tool makes of the hub (see SubagentHub.spawn). */
export interface SubagentSpawnRequest {
  parentId: string;
  /** The spawning agent's own depth; the new agent is one deeper. */
  parentDepth: number;
  type: SubagentType;
  description: string;
  prompt: string;
}

/** What a spawn needs from the hub that owns the session. The mutable parts
 * are functions or a settings object, so the hub can build this once. */
export interface SubagentSpawnHost {
  /** The hub the new agent's task-family tools call back into. */
  hub: SubagentHub;
  /** The session the spawn belongs to: the row's foreign key, the events'
   * address, and whose loans are announced. */
  sessionId: string;
  agents: AgentRepo;
  messages: MessageRepo;
  roster: SubagentRegistry;
  runner: SubagentRunner;
  settings: SubagentSession;
  safety: CommandSafety | undefined;
  streamFn: StreamFn;
  /** Whether the session has closed: a closed session accepts no new task. */
  isClosed(): boolean;
  /** The session's tool_search / tool_call pair (empty for `explore`, which
   * has no registry). Their presence is what decides whether the prompt
   * carries the on-demand-tools note. */
  searchTools(): Tool[];
  /** The pre-step history compaction of one sub-agent. */
  compactBeforeStep(agentId: string, signal: AbortSignal): Promise<void>;
  emit(event: ClientEvent): void;
}

/**
 * Start one sub-agent and return its snapshot immediately: the agent runs in
 * the background and the caller keeps working; completion arrives through a
 * notification (or a waiting task_output).
 *
 * Throws when the session is closed, or when its running sub-agents already
 * fill MAX_SUBAGENTS.
 */
export function spawnSubagent(
  host: SubagentSpawnHost,
  request: SubagentSpawnRequest,
): TaskInfo {
  const { parentId, parentDepth, type, description, prompt } = request;
  if (host.isClosed()) {
    throw new CoreError("The session is closed", "unavailable");
  }
  const running = [...host.roster.all()].filter(
    (sub) => sub.status === "running",
  ).length;
  if (running >= MAX_SUBAGENTS) {
    throw new CoreError(
      `Too many agents running (max ${MAX_SUBAGENTS}); wait for one to ` +
        `finish or check them with task_output`,
      "unavailable",
    );
  }
  const id = host.agents.nextSubagentId();
  const depth = parentDepth + 1;
  const canDelegate = type === "general" && depth < MAX_SUBAGENT_DEPTH;
  const runtime = host.settings.resolveRuntime();
  // General sub-agents share the session's discoverable tools through the
  // registry (seeded by the pool with browser-lab tools before any spawn; MCP
  // tools merge in when discovery finishes — sub-agents spawned before that
  // get the pair via SubagentToolWiring).
  const searchable = type === "general" ? host.searchTools() : [];
  const tools = [
    ...(type === "general"
      ? generalTools(
          runtime.backends,
          runtime.eval,
          host.safety,
          host.settings.webSearch,
          runtime.skills,
        )
      : exploreTools(runtime.backends, host.safety, runtime.skills)),
    ...searchable,
    ...createTaskFamilyTools(host.hub, id, depth, canDelegate),
  ];
  const basePrompt = subagentSystemPrompt(
    id,
    parentId,
    type,
    host.settings.language,
  );
  const systemPrompt =
    searchable.length > 0 ? withOnDemandToolsNote(basePrompt) : basePrompt;
  // A sub-agent has no context providers and nothing republishes its context,
  // so the skill catalog is seeded once, at spawn, in the same shape the main
  // agent publishes. Without it the `skill` tool points at a listing the
  // sub-agent never received.
  const catalog = createSkillCatalogProvider({ skills: runtime.skills });
  const messages = catalog
    .next()
    .map((update) => contextMessage(catalog.name, update, Date.now()));
  // The folders lent to this session, in the same one-shot form: the
  // sub-agent's backends hold them, and nothing else would ever name them (see
  // shareSeedMessages).
  const shares = createShareProvider({
    grants: () => host.settings.sharesHub?.grantsFor(host.sessionId) ?? [],
  });
  messages.push(...shareSeedMessages(shares, Date.now()));
  // The transcript is written through the same ledger the main agent uses,
  // over this agent's own id: a checkpoint inserted into the middle of the
  // view lands at the same position in the store.
  const transcript = new TranscriptStore(id, host.messages);
  // The agent is built by the agent layer (agent/subagent-runner.ts): the hub
  // owns the delegation protocol, not how an agent is assembled.
  const { agent, compactor } = createSubagentAgent(
    {
      id,
      model: runtime.model,
      systemPrompt,
      messages,
      tools: tools.map(toAgentTool),
      thinkingLevel: runtime.thinkingLevel,
      streamFn: host.streamFn,
    },
    {
      beforeStep: (signal) => host.compactBeforeStep(id, signal),
      insert: (index, message) => transcript.insertAt(index, message),
      ...(host.settings.compactionPolicy !== undefined
        ? { compactionPolicy: host.settings.compactionPolicy }
        : {}),
    },
  );
  // The row lands before the run starts: a process that dies mid-run still
  // leaves the task behind, and the next open settles it as aborted. The agent
  // built above has no listener and has been sent nothing, so a failed write
  // leaves nothing running.
  const startedAt = Date.now();
  host.agents.createSubagent({
    id,
    sessionId: host.sessionId,
    parentAgentId: parentId,
    type,
    depth,
    description,
    startedAt,
  });
  const sub: Subagent = {
    id,
    parentId,
    type,
    depth,
    description,
    status: "running",
    agent,
    compactor,
    transcript,
    startedAt,
    tail: "",
    resultText: "",
    unsubscribe: agent.subscribe((event) =>
      host.runner.handleEvent(sub, event),
    ),
    waiters: new Set(),
    abort: new AbortController(),
  };
  host.roster.add(sub);
  host.emit({
    type: "task_start",
    sessionId: host.sessionId,
    agentId: id,
    parentAgentId: parentId,
    subagentType: type,
    description,
  });
  host.runner.start(sub, agent, prompt);
  return host.roster.info(id);
}
