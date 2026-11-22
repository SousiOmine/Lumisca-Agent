/**
 * The session's system prompt, and the context messages that must not be in it.
 *
 * The prompt is re-derived from what it is a function of: the mode, the
 * workspace folders, a stella agent's role and identity, its working folder,
 * and the experimental app-card switch. Persisted, but not frozen: a stored
 * value that no longer matches what this build generates is replaced.
 *
 * Everything that changes while a session lives (the date, the model, the
 * language, the skill catalog, the lent folders) is published as a context
 * message instead, because the prompt is the prefix the provider caches.
 */

import type { Model } from "../ai/catalog.ts";
import type { ContextProvider } from "../ai/context-providers.ts";
import type { Api } from "../domain/model.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { createMcpToolsProvider } from "../mcp/context.ts";
import { createInstructionsProvider } from "../memory/instructions.ts";
import { createShareProvider } from "../share/context.ts";
import { createSkillCatalogProvider } from "../skills/catalog.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import { sessionSkills } from "../tools/toolsets.ts";
import { codeExecutionPrompt } from "./code-execution-prompt.ts";
import { createDateProvider } from "./date-context.ts";
import type { SessionPoolDeps } from "./deps.ts";
import { createLanguageProvider } from "./language-context.ts";
import { createModelProvider } from "./model-context.ts";
import type { SessionWhere } from "./session-location.ts";

/**
 * The session's system prompt, re-derived from what the prompt is a function
 * of (see the module comment). The identity is read here rather than delivered
 * as a context message, so it is fixed when the prompt is generated.
 * Re-deriving the prompt again while the session lives would change the
 * request's first tokens; the one caller that may do it is a compaction (see
 * SessionAgentOptions.refreshSystemPrompt), which has just replaced the history
 * behind the prompt anyway.
 *
 * Re-deriving on every open is what makes a folder edit and a prompt change in
 * a new release reach a session that already exists. The generation is
 * deterministic in those inputs — no date, no model, and no setting but the
 * app-card switch (whose change rebuilds the open sessions) — so a session
 * nothing happened to regenerates the same string and pays nothing: the write
 * and the cache break happen only when the prompt actually differs.
 */
export function ensureSystemPrompt(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
  codeSdk?: string,
): string {
  const base = deps.buildGeneratedPrompt(
    workspace,
    // A stella session's prompt is the machine's plus the role this agent
    // works from; the persona comes from the agent registry, through the
    // pool. A session without an agent id still says the machine's part —
    // stella is the mode, not a property of the row.
    session.stella === true
      ? (deps.stellaAgentPersona?.(session) ?? {
          role: "",
          identity: "",
          id: session.personaId ?? "",
        })
      : undefined,
  );
  const generated =
    codeSdk === undefined ? base : base + "\n\n" + codeExecutionPrompt(codeSdk);
  if (generated !== session.systemPrompt) {
    deps.updateSystemPrompt(session.id, generated);
    // Keep the in-memory row in step: a compaction re-derives the prompt
    // through this same check, and comparing against the value the session
    // was opened with would rewrite the stored row every time.
    session.systemPrompt = generated;
  }
  return generated;
}

/**
 * The dynamic contexts (skill catalog, workspace instructions, the date, the
 * model, the lent folders, the on-demand-tools note, the language). Published
 * as transcript messages when they change, so an edit reaches an open session
 * while the prompt above stays stable — the request's first tokens are what the
 * provider's prompt cache serves.
 */
export function buildContextProviders(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
  where: SessionWhere,
  registries: SessionToolRegistries,
  model: Model<Api>,
): ContextProvider[] {
  const { stella, chat, chatOnly, browserAvailable } = where;
  return [
    // What the catalog IS depends on where the session works: a workspace
    // session discovers `.agents/skills`, and a stella session discovers
    // the machine's own directory plus the host's global and built-in set
    // (vm/skills.ts). Both resolve through the same seam, so the published
    // listing is exactly what the session's skill tool can load.
    createSkillCatalogProvider({
      skills:
        stella !== undefined
          ? () => stella.skills()
          : () =>
              sessionSkills(workspace.folders, {
                browserAvailable,
                computerAvailable: where.computerAvailable(),
                // A chat session has no tool hub, so it cannot start one.
                subagents: !chat,
                // This catalog is the main agent's: it holds the MCP
                // administration tools when the session has them.
                mcpAdmin: where.mcpAdmin !== undefined,
                // Only a session with file tools can write a skill.
                skillAuthoring: !chat,
                ...(deps.appSkillDirs !== undefined
                  ? { appSkillDirs: deps.appSkillDirs }
                  : {}),
                ...(deps.globalSkillDirs !== undefined
                  ? { globalDirs: deps.globalSkillDirs }
                  : {}),
              }),
    }),
    createInstructionsProvider({
      folders: workspace.folders,
      personal: deps.personalInstructions,
    }),
    // The folders lent from the user's own computer: a temporary addition to
    // what this session can reach, so it is published rather than written
    // into the prompt, and withdrawn the same way. A chat session has no
    // file tools, so there is nothing it could reach.
    ...(chatOnly
      ? []
      : [
          createShareProvider({
            grants: () => deps.shares?.()?.grantsFor(session.id) ?? [],
          }),
        ]),
    createDateProvider(),
    // The model the session runs on. Published rather than put in the
    // prompt for the same reason as the date: a session can be switched to
    // another model, and the prompt is a snapshot that never changes. The
    // agent is rebuilt on a switch (see SessionPool.applyChange), so the
    // model captured here is the one this agent runs on.
    createModelProvider({
      model: () => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
      }),
    }),
    // The tool_search / tool_call pair exists exactly while the session's
    // registry holds something to discover; the note follows the same
    // condition, so a late MCP discovery publishes it instead of
    // rewriting the prompt.
    createMcpToolsProvider({
      searchable: () => !registries.main.isEmpty,
    }),
    // The language the session answers in. Published rather than put in
    // the prompt for the same reason as the date and the model: it is a
    // setting, so it can change while the session lives, and the prompt is
    // a snapshot that never changes.
    createLanguageProvider({ language: () => deps.getLanguage() }),
  ];
}
