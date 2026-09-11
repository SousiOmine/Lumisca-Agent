import type { AgentMessage } from "../ai/types.ts";
import type { ClientEvent } from "../types/event.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import { createChatTools, createCodingTools } from "../tools/mod.ts";
import { BackgroundProcessManager } from "../tools/background.ts";
import { AskHub } from "../tools/ask.ts";
import { TodoHub } from "../tools/todo.ts";
import { TaskHub } from "../tools/task-hub.ts";
import type { McpConfig } from "../mcp/config.ts";
import { McpManager } from "../mcp/manager.ts";
import { McpAttachment } from "../mcp/attachment.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SessionAgent as SessionAgentImpl } from "./session-agent.ts";
import type { SessionAgent } from "./session-agent.ts";
import {
  BROWSER_TOOL_NAMES,
  createBrowserToolsFrom,
} from "../browser/tools.ts";
import { createPdfTools, PDF_TOOL_NAMES } from "../pdf/tools.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { createLogger } from "../log.ts";
import type { SessionPoolDeps } from "./pool.ts";
import type { SessionResources } from "./pool.ts";

/** Module logger (debug-gated): attachment rebuilds are the first thing
 * to check when MCP tools misbehave. */
const log = createLogger("pool");

/** True when two merged configs describe the same servers, comparing their
 * canonical (key-sorted) JSON so a settings round-trip that reorders fields
 * does not spuriously tear down and respawn MCP server processes. */
function sameMcpConfig(a: McpConfig, b: McpConfig): boolean {
  return stableJson(a.servers) === stableJson(b.servers);
}

/** Key-sorted JSON (recursively), so equality is independent of object key
 * order. Used by sameMcpConfig for small configs only. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${
          stableJson(
            (value as Record<string, unknown>)[key],
          )
        }`
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Builds the live agent of a session with every runtime it needs
 * (MCP attachment, tool registry, hubs, tools). Extracted from
 * SessionPool.open so the pool stays a lifecycle manager: the factory owns
 * the wiring, the pool owns the map. */
export class AgentFactory {
  constructor(private readonly deps: SessionPoolDeps) {}

  /** Build the agent of a session, recording its runtime in `resources`. */
  open(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
    resources: SessionResources,
    isCurrentAttachment: (attachment: McpAttachment) => boolean,
  ): SessionAgent {
    const model = this.deps.requireModel(
      session.modelProvider,
      session.modelId,
    );

    // One shared MCP attachment per session: its server processes serve
    // every agent of the session (the main agent and the sub-agents) and
    // survive agent rebuilds while the merged config is unchanged. A
    // changed config rebuilds the attachment and tears down the old
    // processes. Config errors and failed servers are reported once per
    // attachment, so a rebuild must not re-report them.
    const mergedMcp = this.deps.loadMergedMcp(workspace);
    let mcp = resources.mcp;
    if (mcp === undefined || !sameMcpConfig(mcp.config, mergedMcp.config)) {
      const previous = mcp;
      if (previous !== undefined) {
        log.debug(`session ${session.id}: MCP config changed, rebuilding`);
      }
      mcp = new McpAttachment(
        new McpManager(mergedMcp.config, workspace.folders[0] ?? Deno.cwd()),
        mergedMcp.config,
      );
      resources.mcp = mcp;
      // A config change builds fresh tools, so the registry is rebuilt
      // with the attachment — stale tools must not survive it. A rebuild
      // with an unchanged config reuses both.
      resources.registry = new ToolRegistry();
      if (previous !== undefined) void previous.manager.close();
      const emitError = (message: string) => {
        resources.lastError = message;
        this.deps.emit({
          type: "session_error",
          sessionId: session.id,
          message,
        });
      };
      for (const message of mergedMcp.errors) emitError(message);
      const attachment = mcp;
      void attachment.ready.then(() => {
        // The session may have been closed or rebuilt (with a new
        // attachment) while discovery ran; only report for the attachment
        // the session still holds.
        if (!isCurrentAttachment(attachment)) return;
        const failed = attachment.manager
          .getStatus()
          .filter((s) => s.status === "error");
        if (failed.length > 0) {
          emitError(
            `MCP servers failed: ${
              failed.map((s) => `${s.name}: ${s.error}`).join("; ")
            }`,
          );
        }
      });
    }
    // One tool registry per session, created with the attachment above and
    // reused across agent rebuilds so the session's discoverable tools
    // survive them. The main agent's attachMcp fills it once discovery
    // finishes; every agent of the session searches it.
    const registry = resources.registry!;
    // The browser-lab tools live in the session's tool registry
    // (discoverable via tool_search), never preloaded into the LLM context
    // — the same contract as MCP tools. Seeded at open so every agent of
    // the session — the main agent and the sub-agents — finds them from
    // the first prompt. The tools resolve the backend at execute time, so
    // a later setBrowserBackend (replacement or detach) is honored even
    // without a rebuild; when the backend is gone at open, the seeded
    // tools are removed instead — a rebuilt session then finds no browser
    // tools, matching the detach contract.
    const browser = this.deps.browser !== undefined
      ? this.deps.browser()
      : undefined;
    // Whether the session advertises the browser-lab: the tools are
    // seeded below, and the built-in web-browser skill (main agent,
    // sub-agents, prompt listing) is gated on the same value.
    const browserAvailable = browser !== undefined;
    if (browser !== undefined) {
      registry.addTools(
        createBrowserToolsFrom(() => this.deps.browser?.()),
      );
    } else {
      registry.removeTools(BROWSER_TOOL_NAMES);
    }
    // Chat sessions ("simple chat" without a workspace) have no shell or
    // sub-agent surface: the background-command manager, the task hub and
    // the runtime resolver are skipped, and the tool set is the chat one.
    const chat = workspace.chat;
    // The PDF page-as-image tool lives in the session's tool registry
    // (discoverable via tool_search), never preloaded into the LLM
    // context — the same contract as MCP and browser-lab tools. Unlike
    // the browser-lab tools it needs no host backend beyond the workspace
    // itself, so every coding session seeds it; chat sessions (no
    // workspace folders to resolve against) remove it. Remove-then-add
    // rebuilds the sandbox on every open, so workspace folder changes
    // apply without stale paths (the registry itself is reused across
    // agent rebuilds).
    registry.removeTools(PDF_TOOL_NAMES);
    if (!chat) {
      registry.addTools(
        createPdfTools({ sandbox: new Sandbox(workspace.folders) }),
      );
    }
    // Reuse the session's manager when one exists (agent rebuild); create
    // it on first open. Shared by the async_bash tools and the session
    // agent: the tools start/check/kill commands, the agent turns
    // completions into notifications. Commands die with the session (pool
    // close/delete/closeAll → killAll), not with the agent. Chat sessions
    // never build it (no async_bash tools).
    let background = resources.background;
    if (!chat && background === undefined) {
      background = new BackgroundProcessManager({
        sessionId: session.id,
        emit: (event) => this.deps.emit(event),
      });
      resources.background = background;
    }
    // One hub per open agent: it holds the questions of the live run, so a
    // rebuild (which closes the old agent first) starts with a clean slate.
    const askHub = new AskHub(session.id, (event) => this.deps.emit(event));
    // Reuse the session's todo hub when one exists (agent rebuild): the
    // plan is the session's progress, not the agent's, so it must survive.
    // Created on first open; discarded when the session closes.
    let todo = resources.todos;
    if (todo === undefined) {
      todo = new TodoHub(session.id, (event) => this.deps.emit(event));
      resources.todos = todo;
    }
    // Sub-agents run on the fast model when configured, otherwise on the
    // session model; the thinking level follows the chosen model's stored
    // level. One hub per session (it owns the live sub-agents, which
    // survive agent rebuilds). The runtime is resolved at spawn time, so
    // model/workspace/thinking-level changes apply to new sub-agents even
    // without a rebuild; the resolver itself is refreshed on every open
    // (it must never hold a stale session). Coding sessions only — the
    // task tools are absent from chat sessions, which run in a workspace
    // without folders (sub-agents would get coding tools that resolve
    // nothing).
    let tasks = resources.tasks;
    if (!chat) {
      const runtimeResolver = () => {
        const fast = this.deps.getFastModelInfo();
        const workspace = this.deps.requireWorkspace(session.workspaceId);
        if (fast !== undefined) {
          return {
            workspace,
            model: fast.model,
            thinkingLevel: this.deps.getThinkingLevel(
              fast.provider,
              fast.modelId,
            ),
          };
        }
        return {
          workspace,
          model,
          thinkingLevel: this.deps.getThinkingLevel(
            session.modelProvider,
            session.modelId,
          ),
        };
      };
      if (tasks === undefined) {
        tasks = new TaskHub({
          sessionId: session.id,
          resolveRuntime: runtimeResolver,
          streamFn: this.deps.streamFn,
          safety: this.deps.commandSafety,
          emit: (event: ClientEvent) => this.deps.emit(event),
        });
        resources.tasks = tasks;
      } else {
        tasks.setRuntimeResolver(runtimeResolver);
      }
      // The sub-agents share the session's MCP attachment and tool
      // registry (general sub-agents get the search/call pair over it),
      // and the browser availability gate (the web-browser built-in skill
      // in their skill tool).
      tasks.setMcp(mcp, registry);
      tasks.setBrowserAvailable(browserAvailable);
    } else {
      tasks = undefined;
    }
    const tools = chat
      ? createChatTools({
        ask: askHub,
        todo,
        safety: this.deps.commandSafety,
        browserAvailable,
      })
      : createCodingTools(workspace, {
        background,
        ask: askHub,
        todo,
        task: tasks,
        safety: this.deps.commandSafety,
        browserAvailable,
      });
    // The system prompt is a per-session snapshot taken at creation
    // (custom prompts are stored verbatim). Only legacy sessions without a
    // stored prompt (created before snapshots) rebuild once — and the
    // rebuilt prompt is persisted right away so subsequent opens stay
    // frozen against AGENTS.md edits.
    let systemPrompt = session.systemPrompt;
    if (systemPrompt === undefined) {
      systemPrompt = this.deps.buildGeneratedPrompt(workspace, {
        provider: session.modelProvider,
        modelId: session.modelId,
      }, browserAvailable);
      this.deps.updateSystemPrompt(session.id, systemPrompt);
    }
    const agent = new SessionAgentImpl({
      sessionId: session.id,
      systemPrompt,
      model,
      tools,
      messages,
      thinkingLevel: this.deps.getThinkingLevel(
        session.modelProvider,
        session.modelId,
      ),
      streamFn: this.deps.streamFn,
      messageRepo: this.deps.messageRepo,
      backgroundManager: background,
      askHub,
      taskHub: tasks,
      toolRegistry: registry,
      imageAnalysisModel: this.deps.getImageAnalysisModel(),
      fastModel: this.deps.getFastModel(),
      renameSession: (name) => this.deps.renameSession(session.id, name),
      goalStore: {
        loadGoal: () => this.deps.loadGoal(session.id),
        saveGoal: (text, maxIterations) =>
          this.deps.saveGoal(session.id, text, maxIterations),
        updateGoal: (patch) => this.deps.updateGoal(session.id, patch),
        clearGoal: () => this.deps.clearGoal(session.id),
      },
      onEvent: (event) => {
        // Remember failures for clients that do not see the WS stream;
        // a new run clears the stale error.
        if (event.type === "session_error") {
          resources.lastError = event.message;
        } else if (event.type === "agent_start") {
          resources.lastError = undefined;
        }
        this.deps.emit(event);
      },
    });
    agent.attachMcp(mcp);
    resources.agent = agent;
    return agent;
  }
}
