/**
 * Constructing the live `Agent` a sub-agent runs on.
 *
 * The sub-agent hub (tools/task-hub.ts) owns the delegation protocol — who
 * may spawn whom, how results are formatted, how a parent is notified — but
 * it must not know how an agent is assembled: `tools/` defines what a tool
 * *is*, and `ai/` runs the model loop. Building an `Agent` there put a second
 * construction site beside `agent/factory.ts` in a layer that has no business
 * owning one (the same reason the factory owns the main agent's wiring).
 *
 * This module is that seam. The hub hands over the decisions it owns (which
 * model, which tools, which prompt) and gets back a started-shaped agent; the
 * `Agent` class stays private to `agent/`.
 */
import { Agent } from "./../ai/agent.ts";
import { WORK_COMPACTION_STYLE } from "../ai/compaction-style.ts";
import { ContextCompactor } from "../ai/context-compaction.ts";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  Api,
  Model,
  StreamFn,
} from "../ai/types.ts";
import { toLlmMessages } from "../domain/notification.ts";
import type { ThinkingLevel } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";

/** What one sub-agent's agent is built from. */
export interface SubagentAgentInit {
  /** The id the sub-agent answers to (its own, not its parent's). */
  id: string;
  model: Model<Api>;
  systemPrompt: string;
  /** Messages the sub-agent starts with. The only producer is the skill
   * catalog seed (see TaskHub.spawn): a sub-agent has no context providers
   * of its own, and the `skill` tool's names have to arrive some way. */
  messages: AgentMessage[];
  /** The sub-agent's tool set, already converted to the runtime's type. */
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  streamFn: StreamFn;
}

/** A built sub-agent agent, plus the pieces the hub has to hold on to. */
export interface SubagentAgent {
  agent: Agent;
  /** Condenses the sub-agent's history between steps (memory only: nothing
   * is persisted and no client watches it, so the checkpoint is spliced
   * straight into the in-memory transcript). */
  compactor: ContextCompactor;
}

/**
 * Build one sub-agent's agent.
 *
 * The hub passes everything that differs per sub-agent; this module owns what
 * every sub-agent agent has in common — the notification conversion, the
 * per-step compaction seam and the transcript splice.
 */
export function createSubagentAgent(
  init: SubagentAgentInit,
  hooks: {
    /** The sub-agent's history compaction, called between steps. */
    beforeStep: (signal: AbortSignal) => Promise<void>;
    /** The compaction tuning read from the settings store. */
    compactionPolicy?: () => CompactionPolicyInput;
  },
): SubagentAgent {
  const agent = new Agent({
    initialState: {
      systemPrompt: init.systemPrompt,
      model: init.model,
      tools: init.tools,
      messages: init.messages,
      thinkingLevel: init.thinkingLevel,
    },
    streamFn: init.streamFn,
    sessionId: init.id,
    // Steered notifications must reach the sub-agent's LLM as user messages
    // (the default conversion would drop their role).
    convertToLlm: (messages: AgentMessage[]) => toLlmMessages(messages),
    // Sub-agents run their own long tool chains, so they condense their
    // history like the main agent: same seam, same budgets.
    beforeStep: hooks.beforeStep,
  });
  const compactor = new ContextCompactor({
    model: init.model,
    systemPrompt: () => agent.state.systemPrompt,
    tools: () => agent.state.tools,
    streamFn: init.streamFn,
    sessionId: init.id,
    style: WORK_COMPACTION_STYLE,
    ...(hooks.compactionPolicy !== undefined
      ? { policy: hooks.compactionPolicy }
      : {}),
    // Memory only: a sub-agent's transcript is never persisted and no client
    // watches it, so the checkpoint is spliced straight into the in-memory
    // transcript the agent loop reads.
    insert: (index, message) => {
      agent.state.messages.splice(index, 0, message);
    },
  });
  return { agent, compactor };
}

/** Forward an agent event to the hub (re-exported so the hub needs no
 * second import of ai/types). */
export type { AgentEvent };
