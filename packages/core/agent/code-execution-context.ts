import type { ContextProvider } from "../ai/context-providers.ts";

/**
 * The note that tells the model how code execution works.
 *
 * It travels as a context message rather than as part of the system prompt
 * for the same reason as the tool_search note (see mcp/context.ts): the
 * language a turn answers in, the model and the folder shares all reach a
 * live session this way, and the prompt is a snapshot that never changes.
 * Here the note also coincides with a rebuild — turning code execution on
 * replaces the whole tool set, which costs the provider's cached prefix
 * once — but publishing it instead of writing it into the prompt keeps the
 * two mechanisms from being different for no reason.
 *
 * The note names no individual tool. The same text reaches a chat session
 * (no file tools) and a stella conversation (no `eval`), and `tools.tool_search`
 * is what answers "which tools do I have".
 */

/** Provider name of the code-execution context. */
export const CODE_EXECUTION_PROVIDER = "code-execution";

export const CODE_EXECUTION_NOTE =
  "Code execution is on: this conversation has ONE tool, `execute`. Every " +
  "other tool — files, shell, web, MCP servers, the session's own tools — " +
  "is called from inside the program with `await tools.<name>(args)`, which " +
  "resolves to that tool's text result and throws when the tool fails. " +
  "`await tools.tool_search({ query })` finds tools and returns their " +
  "argument schemas; with no query it lists every tool by name. A " +
  "top-level `return` gives the result, and only that result comes back: " +
  "keep intermediate output in the program.";

interface CodeExecutionState {
  execution: boolean;
}

function enabledOf(state: unknown): boolean | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const execution = (state as CodeExecutionState).execution;
  return typeof execution === "boolean" ? execution : undefined;
}

/** The provider of the code-execution note. Built only while the mode is
 * on; the agent is rebuilt when the toggle changes, so the note exists
 * exactly when `execute` does. */
export function createCodeExecutionProvider(): ContextProvider {
  let announced = false;
  return {
    name: CODE_EXECUTION_PROVIDER,
    next() {
      if (announced) return [];
      announced = true;
      return [
        {
          title: "Code execution",
          body: CODE_EXECUTION_NOTE,
          state: { execution: true } satisfies CodeExecutionState,
        },
      ];
    },
    rebase(state: unknown): void {
      announced = enabledOf(state) === true;
    },
  };
}
