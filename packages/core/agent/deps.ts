import type { Api, Model } from "../ai/types.ts";
import type { StreamFn } from "../ai/types.ts";
import type { ThinkingLevel } from "../shared/mod.ts";
import type { Locale } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import type { ClientEvent } from "../types/event.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import type { BackgroundProcessManager } from "../tools/background.ts";
import type { TodoHub } from "../tools/todo.ts";
import type { TaskHub } from "../tools/task-hub.ts";
import type { McpConfig } from "../mcp/config.ts";
import type { McpOAuthStore } from "../mcp/oauth.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { SessionAgent } from "./session-agent.ts";
import type { SessionVisualStore } from "../session/visuals.ts";
import type { SessionAttachmentStore } from "../session/attachments.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { RequestShapeRepo } from "../session/request-shapes.ts";
import type { BrowserBackend } from "../browser/types.ts";
import type { ComputerHost } from "../computer/types.ts";
import type { SearchProvider } from "../websearch/types.ts";
import type { StellaRuntime } from "../vm/runtime.ts";
/** Model resolution the agent factory needs (catalog + stored levels). */
export interface ModelResolver {
  /** Resolve a model or throw `not_found` (the pool's model guard shares
   * the core's "Model not found" shape). */
  requireModel(provider: string, modelId: string): Model<Api>;
  /** The configured image-analysis model (undefined when unset): interprets
   * images as text for text-only session models. */
  getImageAnalysisModel(): Model<Api> | undefined;
  /** The configured fast model (undefined when unset): generates session
   * titles from the first user message. */
  getFastModel(): Model<Api> | undefined;
  /** The configured fast model with its provider/model ids (undefined when
   * unset or gone from the catalog). Sub-agents run on it, with its stored
   * thinking level. */
  getFastModelInfo():
    | { provider: string; modelId: string; model: Model<Api> }
    | undefined;
  /** The stored thinking level of a model, clamped to what it supports. */
  getThinkingLevel(provider: string, modelId: string): ThinkingLevel;
  /** The app language (the stored setting, else the machine's locale). It
   * is read when a session's agent is built: it fixes the language of the
   * sub-agents' output rule and of the text the core generates into the
   * transcript (compaction checkpoints, goal notices). The session's own
   * prompt resolves it separately at creation — that snapshot is what the
   * session keeps. */
  getLanguage(): Locale;
  /** The compaction tuning read from the settings store (see
   * shared/settings-keys.ts). The agents read it on every compaction check,
   * so a settings change applies without rebuilding them. */
  getCompactionPolicy(): CompactionPolicyInput;
  /** Record that a prune freed bytes in the store, so the next start rewrites
   * the database file (see db/vacuum.ts). Omitted → the figure is dropped
   * (tests, an in-memory core). */
  recordFreedBytes?(bytes: number): void;
}

/** Session persistence the agent factory needs (repos + prompt snapshot). */
export interface SessionPersistence {
  messageRepo: MessageRepo;
  /** The session's request-shape record: the first request of a session and
   * every request whose head changed or whose history was rewritten — the
   * events that cost the provider's prompt cache (see
   * session/request-shapes.ts). */
  requestShapeRepo: RequestShapeRepo;
  /** Persist a new session title and notify clients. */
  renameSession(id: string, name: string): void;
  /** Full generated system prompt for a workspace; used once per session,
   * the first time it is opened (the stored snapshot is reused
   * afterwards). `model` fills in the environment section, `tools` are the
   * session's preloaded tool names — the guidelines render only the
   * sections whose tools the session has. */
  buildGeneratedPrompt(
    workspace: Workspace,
    model?: { provider: string; modelId: string },
    tools?: readonly string[],
    /** A stella agent's persona (its prompt is the machine's, plus the role
     * it works from), or undefined for every other session. `id` is what
     * names the session's working folder. The name is deliberately absent: it
     * is the label the user can change, and the model does not need it. */
    stella?: { role: string; id: string },
  ): string;
  /** Persist a rebuilt system prompt (legacy-session migration). */
  updateSystemPrompt(id: string, systemPrompt: string): void;
  /** The machine-level AGENTS.md (path + current content), or undefined
   * when none is configured: published as dynamic context together with
   * the workspace instruction files. */
  personalInstructions?: () => { path: string; content: string } | undefined;
  /** Session-bound goal persistence (the sessions table). The pool binds
   * these to one session when building its agent; the agent's loop calls
   * them to persist progress shown in the right-side panel. */
  loadGoal(sessionId: string): import("../shared/goal.ts").GoalInfo | undefined;
  saveGoal(
    sessionId: string,
    text: string,
    maxIterations: number,
  ): import("../shared/goal.ts").GoalInfo;
  updateGoal(
    sessionId: string,
    patch: {
      iteration?: number;
      status?: import("../shared/goal.ts").GoalStatus;
      lastReason?: string | null;
    },
  ): import("../shared/goal.ts").GoalInfo | undefined;
  clearGoal(sessionId: string): string | undefined;
  requireWorkspace(id: string): Workspace;
}

/** Runtime collaborators the agent factory needs (tools + events). */
export interface AgentRuntime {
  streamFn: StreamFn;
  /** Command safety check for the session's bash/eval/async_bash tools
   * (the fast model judges commands before they run). Always present; the
   * check itself is a no-op while the feature is disabled. */
  commandSafety: CommandSafety;
  /** Merged MCP config (app-level + workspace .mcp.json + plugins) for a
   * workspace, with collected config errors. */
  loadMergedMcp(workspace: Workspace): { config: McpConfig; errors: string[] };
  /** Where MCP OAuth grants live: a session's connections use (and refresh)
   * the tokens the settings sign-in stored. Absent in tests that build the
   * pool by hand and never sign in. */
  mcpOAuth?: McpOAuthStore;
  /** Where the visual tool publishes (see tools/visual.ts). Always present
   * in a core (the store is a directory beside the database); a hand-built
   * pool without one simply gets no visual tool. */
  visuals: SessionVisualStore;
  /** Where the files an agent hands to the user are kept (see
   * tools/attach.ts and tools/send-chat.ts). Always present in a core; a
   * hand-built pool without one simply gets neither `chat_attach` nor
   * `send_chat`. */
  attachments: SessionAttachmentStore;
  /** Forward an agent event to every frontend listener. */
  emit(event: ClientEvent): void;
  /** The session's browser-lab backend (Desktop WebView host), or
   * undefined when no browser surface is available — the agent then gets
   * no browser tools. A getter so a backend attached after the pool was
   * built still reaches new agents. */
  browser?: () => BrowserBackend | undefined;
  /** The user's web-search provider, or undefined when none is configured:
   * a session that cannot search is never given `web_search` / `web_fetch`.
   * A getter so a provider configured after the pool was built reaches new
   * agents, and so a changed default takes effect on the next open. */
  webSearch?: () => SearchProvider | undefined;
  /** The machine's computer host (screen, mouse, keyboard), or undefined
   * when this session must not drive it — no host on this platform, or the
   * user has not enabled the feature. A getter so a feature toggled after
   * the pool was built still reaches new agents, and so a session whose
   * tools were seeded stops acting the moment the feature is turned off. */
  computer?: () => ComputerHost | undefined;
  /** The stella machine's runtime for a session, or undefined when the
   * session does not run inside it (every session but stella's). Resolved per
   * open, so a machine attached after the pool was built still reaches new
   * agents. Omitted → no stella session can be built. */
  stellaRuntime?: (session: SessionInfo) => StellaRuntime | undefined;
  /** The persona of a stella session: the role its agent works from, which
   * is what makes one conversation different from another (see
   * stella/agents.ts). The agent's NAME is not part of it: it is a label the
   * user can change at any time, and the prompt is a snapshot. */
  stellaAgentPersona?: (
    session: SessionInfo,
  ) => { role: string; id: string } | undefined;
  /** Global skills directory override (default ~/.agents/skills).
   * LumiscaCore.forTesting passes an empty list, so a test's skill catalog
   * is built from its own fixture only. */
  globalSkillDirs?: string[];
}

/** Everything the pool needs to build and manage agents, injected by
 * LumiscaCore so the pool stays free of repository wiring. Split into
 * ModelResolver / SessionPersistence / AgentRuntime so consumers depend
 * only on the slice they use. */
export type SessionPoolDeps = ModelResolver & SessionPersistence & AgentRuntime;

/** Everything one open session owns, keyed by session id. Consolidating the
 * per-session runtime state into one struct means a future resource is one
 * field here (and one clear in close/closeAll) instead of another parallel
 * map that must be kept in lockstep. */
export interface SessionResources {
  /** The live agent (replaced on rebuild; absent when closed). */
  agent?: SessionAgent;
  /** Background-command manager. Owned by the pool (not the agent) so
   * background commands survive agent rebuilds — model and workspace
   * changes rebuild the agent while the session stays open, and the
   * commands must keep running. Stopped when the session closes. */
  background?: BackgroundProcessManager;
  /** Todo hub, with the same rebuild-survival reason as `background`. */
  todos?: TodoHub;
  /** Task hub, with the same rebuild-survival reason as `background`
   * (sub-agents run independently of the agent run). Aborted on close. */
  tasks?: TaskHub;
  /** Shared MCP attachment: its server processes serve every agent of the
   * session — the main agent and the sub-agents — and survive agent
   * rebuilds while the merged config is unchanged. Closed on close. */
  mcp?: McpAttachment;
  /** The two tool registries of the session (the main agent's and its
   * sub-agents'), rebuilt together with the attachment when the config
   * changes. See tools/registries.ts for why they are separate. */
  registries?: SessionToolRegistries;
  /** The last failure of the session, if any (cleared when a new run
   * starts). Lets non-WebSocket clients learn about failures of
   * fire-and-forget prompts. */
  lastError?: string;
}
