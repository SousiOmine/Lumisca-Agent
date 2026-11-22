/**
 * The per-session hubs an agent is wired to.
 *
 * A hub outlives an agent rebuild because its work does: background commands
 * keep running while the model or the workspace changes, a todo plan is the
 * session's progress rather than the agent's, and sub-agents run
 * independently of the run that started them. The ask hub is the exception —
 * it holds the questions of one live run, so a rebuild starts it clean.
 */

import type { ClientEvent } from "../domain/event.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import { AskHub } from "../tools/ask.ts";
import { BackgroundProcessManager } from "../tools/background.ts";
import { TaskHub } from "../tools/task-hub.ts";
import { TodoHub } from "../tools/todo.ts";
import { sessionSkills, subagentSkills } from "../tools/toolsets.ts";
import type { SessionPoolDeps, SessionResources } from "./deps.ts";
import type { SessionWhere } from "./session-location.ts";

/** The per-session hubs one open agent is wired to. All but the ask hub
 * survive an agent rebuild (they live in SessionResources). */
export interface SessionHubs {
  background: BackgroundProcessManager | undefined;
  ask: AskHub;
  todo: TodoHub | undefined;
  tasks: TaskHub | undefined;
}

/**
 * The per-session hubs that back the tools and outlive an agent rebuild:
 * the ask hub (per agent), the todo plan, the background-command manager
 * and the sub-agent hub. Created on first open and reused afterwards, so a
 * model or workspace change does not lose the session's running work.
 */
export function buildSessionHubs(
  deps: SessionPoolDeps,
  session: SessionInfo,
  where: SessionWhere,
  resources: SessionResources,
  mcp: McpAttachment,
): SessionHubs {
  // Commands die with the session (pool close/delete/closeAll → killAll),
  // not with the agent. A chat-only session never builds it (no
  // async_bash); a stella conversation does, even though its row lives in
  // the chat workspace — it works in the machine, which has a spawner.
  let background = resources.background;
  if (!where.chatOnly && background === undefined) {
    background = new BackgroundProcessManager({
      sessionId: session.id,
      emit: (event) => deps.emit(event),
      ...(where.stella !== undefined
        ? { spawner: where.stella.backgroundSpawner }
        : {}),
    });
    resources.background = background;
  }
  // One hub per open agent: it holds the questions of the live run, so a
  // rebuild (which closes the old agent first) starts with a clean slate.
  const ask = new AskHub(session.id, (event) => deps.emit(event));
  // The plan is the session's progress, not the agent's, so it survives a
  // rebuild. A stella conversation has no progress panel to render it, but
  // the plan is not FOR the panel: it is how a run remembers what the user
  // asked for in a request that has more than one part. Without it, the
  // list of outstanding requests lives only in the history, which a long
  // conversation condenses away — and a run then stops after the first
  // request it finished.
  let todo = resources.todos;
  if (todo === undefined) {
    todo = new TodoHub(session.id, (event) => deps.emit(event));
    resources.todos = todo;
  }
  // Sub-agents run on the fast model when configured, otherwise on the
  // session model; the thinking level follows the chosen model's stored
  // level. One hub per session (it owns the live sub-agents, which survive
  // agent rebuilds). The runtime is resolved at spawn time, so model /
  // workspace / thinking-level changes apply to new sub-agents even
  // without a rebuild.
  let tasks = resources.tasks;
  if (!where.chatOnly) {
    const runtimeResolver = () => {
      const fast = deps.getFastModelInfo();
      const workspace = deps.requireWorkspace(session.workspaceId);
      // The catalog a sub-agent may load: the session's, minus the guides
      // whose tools a sub-agent does not have. A stella conversation's
      // catalog lives inside the machine, so only its runtime can name the
      // skills; the filter keeps the main-only guides out either way.
      const stella = where.stella;
      const skills =
        stella !== undefined
          ? () =>
              subagentSkills(stella.skills(), {
                browserAvailable: where.browserAvailable,
                computerAvailable: where.computerAvailable(),
              })
          : () =>
              sessionSkills(workspace.folders, {
                browserAvailable: where.browserAvailable,
                computerAvailable: where.computerAvailable(),
                ...(deps.appSkillDirs !== undefined
                  ? { appSkillDirs: deps.appSkillDirs }
                  : {}),
                ...(deps.globalSkillDirs !== undefined
                  ? { globalDirs: deps.globalSkillDirs }
                  : {}),
              });
      // `eval` runs in the server process, so a stella session's
      // sub-agents must not have it (its tools all run inside the
      // machine; see generalTools).
      const evalTool = stella === undefined;
      if (fast !== undefined) {
        return {
          backends: where.backends,
          model: fast.model,
          thinkingLevel: deps.getThinkingLevel(fast.provider, fast.modelId),
          eval: evalTool,
          skills,
        };
      }
      return {
        backends: where.backends,
        model: deps.requireModel(session.modelProvider, session.modelId),
        thinkingLevel: deps.getThinkingLevel(
          session.modelProvider,
          session.modelId,
        ),
        eval: evalTool,
        skills,
      };
    };
    if (tasks === undefined) {
      tasks = new TaskHub({
        sessionId: session.id,
        mainAgentId: session.mainAgentId,
        agents: deps.agents,
        messages: deps.messageRepo,
        resolveRuntime: runtimeResolver,
        streamFn: deps.streamFn,
        safety: deps.commandSafety,
        language: deps.getLanguage(),
        compactionPolicy: () => deps.getCompactionPolicy(),
        emit: (event: ClientEvent) => deps.emit(event),
      });
      resources.tasks = tasks;
    } else {
      tasks.setRuntimeResolver(runtimeResolver);
    }
    // The sub-agents share the session's MCP attachment (their own
    // registry holds the shared tools the discovery merges in), the
    // language their reports come back in, and the web-search provider —
    // re-read on every open. The skill catalog and the capability gates
    // travel with the runtime resolver instead: they are what the runtime
    // (the machine or this workspace) answers for.
    tasks.setMcp(mcp, resources.registries!.subagent);
    tasks.setWebSearch(where.webSearch);
    tasks.setShares(deps.shares?.());
    tasks.setLanguage(deps.getLanguage());
  } else {
    tasks = undefined;
  }
  return { background, ask, todo, tasks };
}
