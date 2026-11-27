import type { Model } from "../ai/catalog.ts";
import type { StreamFn } from "../ai/transport.ts";
import type { BrowserBackend } from "../browser/types.ts";
import type { CodeStoreRepo } from "../code-execution/store.ts";
import type { ComputerHost } from "../computer/types.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { Api } from "../domain/model.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import type { McpConfig } from "../mcp/config.ts";
import type { MachineRunner } from "../mcp/machine.ts";
import type { McpAdmin } from "../mcp/manage-tools.ts";
import type { McpOAuthStore } from "../mcp/oauth.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { AgentRepo } from "../session/agents.ts";
import type { SessionAttachmentStore } from "../session/attachments.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { RequestShapeRepo } from "../session/request-shapes.ts";
import type { SessionVisualStore } from "../session/visuals.ts";
import type { ShareHub } from "../share/hub.ts";
import type { ShareRequestRegistry } from "../share/request.ts";
import type { Locale, ThinkingLevel } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import type { StellaRuntime } from "../vm/runtime.ts";
import type { SearchProvider } from "../websearch/types.ts";
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
  /** Whether a stella conversation keeps its whole transcript (see
   * STELLA_KEEP_FULL_LOG_KEY and session/prune.ts). A getter rather than a
   * value captured at open: the agents consult it on every prune, so the
   * settings toggle reaches a running conversation without rebuilding its
   * agent. */
  getStellaKeepFullLog(): boolean;
  /** Record that a prune freed bytes in the store, so the next start rewrites
   * the database file (see db/vacuum.ts). Omitted → the figure is dropped
   * (tests, an in-memory core). */
  recordFreedBytes?(bytes: number): void;
}

/** Session persistence the agent factory needs (repos + prompt snapshot). */
export interface SessionPersistence {
  messageRepo: MessageRepo;
  /** The session's agents: the main one, whose row is written with the
   * session, and the sub-agents the task hub spawns. */
  agents: AgentRepo;
  /** The session's request-shape record: the first request of a session and
   * every request whose head changed or whose history was rewritten — the
   * events that cost the provider's prompt cache (see
   * session/request-shapes.ts). */
  requestShapeRepo: RequestShapeRepo;
  /** The scripting tool call's store: small JSON values a program keeps
   * between calls and across session resumes. Always present in a core; a
   * pool built by hand must pass one when it turns the mode on. */
  codeStore: CodeStoreRepo;
  /** Persist a new session title and notify clients. */
  renameSession(id: string, name: string): void;
  /** Full generated system prompt for a workspace, re-derived every time a
   * session is opened (a stored value that differs is replaced). What it is
   * a function of is the mode, the workspace folders a stella agent's role
   * and identity, and the experimental app-card switch — nothing that
   * changes while a session lives (moving the switch rebuilds the open
   * sessions), so an unchanged session regenerates the same string. */
  buildGeneratedPrompt(
    workspace: Workspace,
    /** A stella agent's persona (its prompt is the machine's, plus the role
     * and identity it works from), or undefined for every other session.
     * `id` is what names the session's working folder. The name is
     * deliberately absent: it is the label the user can change, and the model
     * does not need it. */
    stella?: { role: string; identity: string; id: string },
  ): string;
  /** Store the session's current system prompt (see
   * agent/session-prompt.ts's ensureSystemPrompt: written only when it changed). */
  updateSystemPrompt(id: string, systemPrompt: string): void;
  /** The machine-level AGENTS.md (path + current content), or undefined
   * when none is configured: published as dynamic context together with
   * the workspace instruction files. */
  personalInstructions?: () => { path: string; content: string } | undefined;
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
  /** One agent's MCP config: the servers that run inside its machine (see
   * mcp/service.ts). Absent for a pool without a machine: a stella session
   * then has no machine servers, and code mode never asks. */
  loadAgentMcp?(agentId: string): { config: McpConfig; errors: string[] };
  /** How to start a process inside one agent's machine (see
   * mcp/machine.ts). Absent where no machine exists. */
  machineRunner?(agentId: string): MachineRunner | undefined;
  /** The MCP config the agent may change through `mcp_add` /
   * `mcp_remove` / `mcp_list` (see mcp/manage-tools.ts). The argument is
   * the persona of a stella session: its tools then edit that agent's own
   * config, which is where its servers run. Omitted only where the pool is
   * built by hand without one (tests): the session then simply has no
   * administration tools. */
  mcpAdmin?: (agentId?: string) => McpAdmin;
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
  /** Whether the user turned the scripting tool call on (see
   * CODE_EXECUTION_ENABLED_KEY). Read once per open: it decides the whole
   * tool set of the agent, so the pool rebuilds the open sessions when the
   * toggle changes (see SessionPool.applyAgentBuildChange). */
  isCodeExecutionEnabled(): boolean;
  /** Whether the model is offered the ask tool (see ASK_TOOL_ENABLED_KEY).
   * Read once per open for the same reason: it is part of the tool set, and
   * the pool rebuilds the open sessions when the toggle changes. */
  isAskToolEnabled(): boolean;
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
  /** The computers lending folders to conversations (see share/hub.ts), or
   * undefined when this pool has no share channel (a pool built by hand).
   * A getter because the hub is read on every open; the grants themselves are
   * read on every call, so a loan made while a session runs is reachable
   * without rebuilding its agent. */
  shares?: () => ShareHub | undefined;
  /** The per-session hubs of the folder requests (`share_request` /
   * `share_disconnect`). Omitted → a stella session gets neither tool (a pool
   * built by hand without a share channel). */
  shareRequests?: ShareRequestRegistry;
  /** The persona of a stella session: the role its agent works from and the
   * identity it wrote about itself, which are what make one conversation
   * different from another (see stella/agents.ts and stella/identity.ts). The
   * agent's NAME is not part of it: it is a label the user can change at any
   * time, and the prompt is a snapshot. */
  stellaAgentPersona?: (
    session: SessionInfo,
  ) => { role: string; identity: string; id: string } | undefined;
  /** Global skills directory override (default ~/.agents/skills).
   * LumiscaCore.forTesting passes an empty list, so a test's skill catalog
   * is built from its own fixture only. */
  globalSkillDirs?: string[];
  /** The mode's shared skills folders (see `appSkillDirs`): the Lumisca
   * skills folder, which the file tools may also write to. Resolved once by
   * the core; `forTesting` passes an empty list so a test never reads the
   * machine's own shared folder. */
  appSkillDirs?: string[];
}

/** Everything the pool needs to build and manage agents, injected by
 * LumiscaCore so the pool stays free of repository wiring. Split into
 * ModelResolver / SessionPersistence / AgentRuntime so consumers depend
 * only on the slice they use. */
export type SessionPoolDeps = ModelResolver & SessionPersistence & AgentRuntime;
