import type { McpAttachment } from "../mcp/attachment.ts";
import type { BackgroundProcessManager } from "../tools/background.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import type { TaskHub } from "../tools/task-hub.ts";
import type { TodoHub } from "../tools/todo.ts";
import type { SessionAgent } from "./session-agent.ts";

/** Everything one open session owns beside its persisted row. AgentFactory
 * keeps one per open session, so a resource is one field here (and one clear
 * in {@link close}) instead of another parallel map kept in lockstep with
 * the agent's.
 *
 * The hubs and the MCP attachment outlive an agent rebuild on purpose: they
 * belong to the session, not to the agent that happens to be wired to them
 * right now. */
export class SessionRuntime {
  /** The live agent (replaced on rebuild; absent when closed). */
  agent?: SessionAgent;
  /** Background-command manager: commands keep running while a model or
   * workspace change rebuilds the agent, and die with the session. */
  background?: BackgroundProcessManager;
  /** The session's progress plan, which a rebuild must not lose. */
  todos?: TodoHub;
  /** The live sub-agents, which run independently of the agent's run. */
  tasks?: TaskHub;
  /** The shared MCP attachment: its server processes serve the main agent
   * and the sub-agents, and survive a rebuild while the config is
   * unchanged. */
  mcp?: McpAttachment;
  /** The main and sub-agent tool registries, rebuilt with the attachment. */
  registries?: SessionToolRegistries;
  /** The last failure of the session, cleared when a new run starts. Lets
   * non-WebSocket clients learn about failures of fire-and-forget prompts. */
  lastError?: string;

  /** Whether the live agent is streaming. A closed session is never
   * streaming: there is no agent to run. */
  get streaming(): boolean {
    return this.agent?.isStreaming === true;
  }

  /** Drop the MCP attachment and its registries (a sign-in: the config is
   * unchanged, but the connection the session holds may be the one that got
   * the 401). The caller rebuilds next. */
  dropMcp(): void {
    const previous = this.mcp;
    this.mcp = undefined;
    this.registries = undefined;
    if (previous !== undefined) void previous.manager.close();
  }

  /** Tear the session's resources down: the agent, the sub-agents, then the
   * background kills and the MCP child processes, whose death is only
   * guaranteed once this resolves. The persisted row is the caller's. */
  async close(): Promise<void> {
    this.agent?.close();
    this.tasks?.close();
    await this.background?.killAll();
    await this.mcp?.manager.close();
  }
}
