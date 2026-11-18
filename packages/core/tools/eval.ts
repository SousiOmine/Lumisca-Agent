import { errorMessage } from "../errors.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import { TOOL_EVAL } from "../shared/mod.ts";
import { composeScriptResult, JsSandbox, transpileToJs } from "./js-sandbox.ts";
import { safetyBlockResult } from "./safety.ts";
import {
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";
import { truncate, truncatedNote } from "./truncate.ts";

const DEFAULT_TIMEOUT_MS = 5000;
/** Longest a snippet may run. The sandbox shares the server process, so a
 * snippet cannot be allowed to hold it for minutes. */
const MAX_TIMEOUT_MS = 120_000;

function composeResult(output: string, value: unknown): string {
  const joined = composeScriptResult(output, value);
  if (joined.length === 0) return "(no output)";
  const { text, truncated } = truncate(joined);
  return truncated ? text + truncatedNote("output") : joined;
}

const evalSchema = object({
  code: string("JavaScript/TypeScript code to evaluate"),
  timeout: optional(
    integer("Timeout in milliseconds (default 5000)", {
      min: 1,
      max: MAX_TIMEOUT_MS,
    }),
  ),
  reset: optional(
    boolean(
      "Clear the REPL state before evaluating (default: false — variables persist between calls)",
    ),
  ),
});

/** Options for the eval tool. `safety` (when present) makes the fast model
 * judge the snippet before it runs; a blocked snippet returns the reason
 * as the tool result. */
export interface EvalToolOptions {
  safety?: CommandSafety;
}

export function createEvalTool(
  options: EvalToolOptions = {},
): Tool<typeof evalSchema> {
  const session = new JsSandbox();
  // Parallel tool calls share the session; serialize them so state and
  // console output cannot interleave.
  let queue: Promise<ToolResult> = Promise.resolve({
    content: [],
    details: {},
  });

  return {
    name: TOOL_EVAL,
    label: "Eval",
    description:
      "Run a JavaScript/TypeScript snippet in a persistent REPL and return " +
      "its completion value (a promise is awaited) and its logs. Top-level " +
      "declarations persist between calls. Code with top-level `await` " +
      "returns nothing, so `console.log` there. It runs with bash's " +
      "permissions and the standard web globals (no node internals). An " +
      "error in the snippet comes back as `[error] <message>`, not as a tool " +
      "failure.",
    parameters: evalSchema,
    execute: async (_id, params): Promise<ToolResult> => {
      const run = async (): Promise<ToolResult> => {
        // Eval runs in the server process, so its working-directory context
        // is the process cwd (part of the approval key). A blocked snippet
        // is reported like a user-code failure: a result, not a tool
        // failure, so the agent sees the reason.
        const blocked = await safetyBlockResult(
          options.safety,
          "eval",
          params.code,
          process.cwd(),
          {
            prefix: "[error]\n",
            fallbackReason: "The snippet was judged unsafe.",
            details: { reset: params.reset === true },
          },
        );
        if (blocked !== undefined) return blocked;
        if (params.reset === true) session.reset();
        const timeoutMs = Math.max(1, params.timeout ?? DEFAULT_TIMEOUT_MS);
        try {
          const js = await transpileToJs(params.code);
          const { value, output } = await session.run(js, timeoutMs);
          return {
            content: [{ type: "text", text: composeResult(output, value) }],
            details: { reset: params.reset === true },
          };
        } catch (error) {
          // User-code failures (syntax, runtime, timeout) are results, not
          // tool failures; the session state stays for the next call.
          return {
            content: [
              {
                type: "text",
                text: `[error]\n${errorMessage(error)}`,
              },
            ],
            details: { reset: params.reset === true, error: true },
          };
        }
      };
      return await (queue = queue.then(run, run));
    },
    dispose: () => session.close(),
  };
}
