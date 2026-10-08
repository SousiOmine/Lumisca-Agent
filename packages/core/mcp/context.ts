import type {
  ContextProvider,
  ContextUpdate,
} from "../agent/context-providers.ts";

/**
 * The on-demand-tools context provider: publishes the contract for the
 * `tool_search` / `tool_call` pair as a durable transcript message instead
 * of appending it to the system prompt.
 *
 * The pair exists only while the session's tool registry holds something to
 * discover (MCP servers, the browser lab, the PDF and computer tools), and
 * discovery may finish after the session was opened. Appending the note to
 * the prompt at that moment would rewrite the request's first tokens — the
 * whole cached prefix — so the note travels the same way as every other
 * late fact: appended to history, published when the pair appears and only
 * then (see agent/context-providers.ts).
 *
 * Sub-agents have no context providers; their prompt carries the same note
 * from the start (see withOnDemandToolsNote), so the contract text stays in
 * one place.
 */

/** Provider name of the on-demand-tools context. */
export const MCP_TOOLS_PROVIDER = "mcp";

/** The model-facing note: what the pair is for and the one boundary fact
 * that is not in the tools' own descriptions. */
export const ON_DEMAND_TOOLS_NOTE =
  "On-demand tools: tools beyond the preloaded set (MCP servers, " +
  "extensions, the browser lab) are found with tool_search and run with " +
  "tool_call; `mcp__` tools can access resources outside the workspace.";

/** The system-prompt form of the note, for agents without context
 * providers (sub-agents). */
export const ON_DEMAND_TOOLS_PROMPT_NOTE = `\n\nNote: ${ON_DEMAND_TOOLS_NOTE}`;

/** Append the note to a system prompt unless it is already there.
 * Idempotent: a sub-agent spawned before discovery may receive it when the
 * pair is attached later, and the prompt must not grow a second copy. */
export function withOnDemandToolsNote(systemPrompt: string): string {
  return systemPrompt.includes(ON_DEMAND_TOOLS_PROMPT_NOTE)
    ? systemPrompt
    : systemPrompt + ON_DEMAND_TOOLS_PROMPT_NOTE;
}

/** Published when the pair disappears again (a rebuilt registry with no
 * discoverable tools): the earlier note is stale, so the model must stop
 * looking for the pair. */
const ON_DEMAND_TOOLS_GONE =
  "The on-demand tools are no longer available in this session: tool_search " +
  "and tool_call are gone.";

export interface McpToolsContextOptions {
  /** Whether the session currently exposes the pair (its tool registry
   * holds at least one discoverable tool). Read on every check, so a
   * registry that fills in after the session started publishes the note. */
  searchable: () => boolean;
}

interface McpToolsState {
  available: boolean;
}

function availableOf(state: unknown): boolean | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const available = (state as McpToolsState).available;
  return typeof available === "boolean" ? available : undefined;
}

export function createMcpToolsProvider(
  options: McpToolsContextOptions,
): ContextProvider {
  /** The last announced availability, or undefined while nothing has been
   * announced: a session whose registry was never non-empty stays silent
   * (there is nothing to explain and nothing to withdraw). */
  let announced: boolean | undefined;

  return {
    name: MCP_TOOLS_PROVIDER,
    next(): ContextUpdate[] {
      const available = options.searchable();
      if (announced === undefined && !available) {
        announced = false;
        return [];
      }
      if (announced === available) return [];
      announced = available;
      return [{
        title: available ? "On-demand tools" : "On-demand tools (gone)",
        body: available ? ON_DEMAND_TOOLS_NOTE : ON_DEMAND_TOOLS_GONE,
        state: { available } satisfies McpToolsState,
      }];
    },
    rebase(state: unknown): void {
      announced = availableOf(state);
    },
  };
}
