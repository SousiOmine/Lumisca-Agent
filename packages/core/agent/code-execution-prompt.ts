/**
 * The system-prompt section of the scripting tool call.
 *
 * It belongs in the system prompt rather than a context message because the
 * preloaded tool set it declares is fixed for the life of an agent: the pool
 * rebuilds the agent when the set changes (the mode toggle, a model or
 * workspace change), and session-prompt.ts's ensureSystemPrompt rewrites the
 * stored prompt with the new declarations. The discoverable registry is the
 * part that changes while a session lives, and it stays out of the
 * declarations; tool_search reads it live.
 */
export function codeExecutionPrompt(sdk: string): string {
  return [
    "## Scripting tool call",
    "",
    "This conversation has ONE tool, `execute`. Every other tool is called from",
    "inside the program with `await tools.<name>(args)`, which resolves to that",
    "tool's text result and throws when the tool fails. A top-level `return`",
    "gives the result; only that result comes back.",
    "",
    "The tools below are declared for you. Tools not declared here are found",
    "with `tools.tool_search({ query })`, which returns their descriptions and",
    "argument schemas.",
    "",
    "```ts",
    sdk,
    "```",
    "",
    "Small JSON values survive between calls: `store(key, value)` writes one,",
    "`load(key)` reads one, and `store(key, undefined)` deletes it. Writes are",
    "kept only when the program succeeds. Each value is at most 256 KiB and the",
    "whole store at most 1 MiB.",
  ].join("\n");
}
