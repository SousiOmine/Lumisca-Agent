import { inspect } from "node:util";
import { type Context, createContext, runInContext } from "node:vm";
import { TOOL_EVAL } from "../shared.ts";
import { errorMessage } from "../errors.ts";
import {
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";
import { MAX_TOOL_OUTPUT, truncate, truncatedNote } from "./truncate.ts";

const DEFAULT_TIMEOUT_MS = 5000;
/** inspect depth for the completion value (arrays of objects stay readable). */
const RESULT_DEPTH = 4;
/** inspect bounds: huge arrays/strings would otherwise materialize a giant
 * result string before truncation even runs. */
const RESULT_MAX_ARRAY = 200;
const RESULT_MAX_STRING = 8192;

/** Type stripper, loaded lazily on the first eval so the server startup
 * does not pay for parsing it. Sucrase is a pure-JS transpiler with a
 * stable API that does not depend on the typescript package — typescript 7
 * (the native compiler) exposes no transpile API, and ts-blank-space pins
 * typescript 5/6, so sucrase keeps the eval tool updateable independently. */
let sucrase: typeof import("sucrase") | undefined;

/** Strip TypeScript type annotations so vm can run the snippet. Plain
 * JavaScript passes through unchanged; syntax errors throw. Imports are
 * left untouched (disableESTransforms) and fail in vm with a clear error. */
async function transpileToJs(code: string): Promise<string> {
  const { transform } = (sucrase ??= await import("sucrase"));
  return transform(code, {
    transforms: ["typescript"],
    disableESTransforms: true,
  }).code;
}

/** True when `value` is a promise-like completion that the host must await
 * before the call can report its result. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

/** Await a thenable but bail out with the standard timeout error after
 * `ms`, so a hung network call cannot stall the tool forever. */
async function awaitWithTimeout<T>(
  value: PromiseLike<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Script execution timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** V8 reports top-level await in a script in different ways depending on
 * what follows the `await` (`await f(...)` parses as an identifier call
 * and fails with "missing ) after argument list"); the only reliable
 * signal is the token itself. */
function hasAwait(code: string): boolean {
  return /\bawait\b/.test(code);
}

/** One REPL session: an isolated vm context whose globals persist across
 * calls. Top-level `var`/`let`/`const` and function declarations persist;
 * re-declaring a `let`/`const` name in a later call throws.
 *
 * The sandbox is deliberately NOT an isolation boundary: the host `Deno`
 * namespace, `fetch` and related web globals are exposed, so `eval` has
 * the same access as `bash` (files, network, processes, env). */
class EvalSession {
  private sandbox: Record<string, unknown>;
  private context: Context;
  private output: string[] = [];
  /** Cumulative console bytes; once the budget is exceeded further lines
   * are dropped (a note is appended to the result) so a huge console.log
   * loop can never accumulate unbounded output in memory. */
  private outputBytes = 0;
  private outputTruncated = false;

  constructor() {
    this.sandbox = this.newSandbox();
    this.context = createContext(this.sandbox);
  }

  private newSandbox(): Record<string, unknown> {
    const emit = (...args: unknown[]) => {
      if (this.outputTruncated) return;
      const line = args.map(formatConsoleArg).join(" ");
      this.outputBytes += line.length + 1;
      if (this.outputBytes > MAX_TOOL_OUTPUT) {
        this.outputTruncated = true;
        return;
      }
      this.output.push(line);
    };
    return {
      // Same trust level as bash: full host access. Web globals for
      // network work (fetch returns host Responses, so .json()/.text()
      // work on them).
      Deno,
      fetch,
      URL,
      URLSearchParams,
      Headers,
      setTimeout,
      clearTimeout,
      console: { log: emit, info: emit, warn: emit, error: emit },
    };
  }

  /** Discard all state (the `reset` argument). */
  reset(): void {
    this.sandbox = this.newSandbox();
    this.context = createContext(this.sandbox);
  }

  /** Run one snippet and return its completion value and console output.
   * Code that mentions `await` and fails to parse as a script is re-run in
   * an async wrapper (top-level await is only valid in modules): the
   * wrapper cannot return a completion value, so such calls report results
   * via `console.log` and `globalThis` state — the description tells the
   * agent this. Any promise-like completion of plain code is awaited
   * within the remaining timeout. */
  async evaluate(
    code: string,
    timeoutMs: number,
  ): Promise<{ value: unknown; output: string }> {
    this.output.length = 0;
    this.outputBytes = 0;
    this.outputTruncated = false;
    let value: unknown;
    try {
      value = runInContext(code, this.context, { timeout: timeoutMs });
    } catch (error) {
      if (!hasAwait(code)) throw error;
      // Genuine syntax errors surface again from the wrapper (under the
      // async interpretation); runtime errors and timeouts there are
      // reported as-is.
      value = undefined;
      await runInContext(
        `(async () => {\n${code}\n})()`,
        this.context,
        { timeout: timeoutMs },
      );
    }
    if (isThenable(value)) {
      value = await awaitWithTimeout(value, timeoutMs);
    }
    const output = this.output.join("\n") +
      (this.outputTruncated ? truncatedNote("console output") : "");
    return { value, output };
  }
}

function formatConsoleArg(arg: unknown): string {
  return typeof arg === "string" ? arg : inspect(arg);
}

function composeResult(output: string, value: unknown): string {
  const parts: string[] = [];
  if (output.length > 0) parts.push(`[output]\n${output}`);
  if (value !== undefined) {
    parts.push(`[result]\n${
      inspect(value, {
        depth: RESULT_DEPTH,
        maxArrayLength: RESULT_MAX_ARRAY,
        maxStringLength: RESULT_MAX_STRING,
      })
    }`);
  }
  if (parts.length === 0) return "(no output)";
  const joined = parts.join("\n\n");
  const { text, truncated } = truncate(joined);
  return truncated ? text + truncatedNote("output") : joined;
}

const evalSchema = object({
  code: string("JavaScript/TypeScript code to evaluate"),
  timeout: optional(integer("Timeout in milliseconds (default 5000)")),
  reset: optional(boolean(
    "Clear the REPL state before evaluating (default: false — variables persist between calls)",
  )),
});

export function createEvalTool(): Tool<typeof evalSchema> {
  const session = new EvalSession();
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
      "Evaluate a JavaScript/TypeScript snippet in a persistent REPL. " +
      "Top-level `var`, `let`, `const` and function declarations persist " +
      "between calls; re-declaring a `let`/`const` name in a later call " +
      "throws (use `var` for mutable state, or `reset` to start over). " +
      "Code with top-level `await` runs in an async wrapper — in such " +
      "calls print results with `console.log` (the completion value is " +
      "not returned) and declare persistent state with `globalThis`. " +
      "The completion value of plain code (awaited when it is a promise) " +
      "and console output are returned. The snippet runs in the server " +
      "process with the same access as bash — files (Deno.*), network " +
      "(fetch), processes and env are available; it is not a sandbox. " +
      "`reset` clears the state; `timeout` is in milliseconds.",
    parameters: evalSchema,
    execute: async (_id, params): Promise<ToolResult> => {
      const run = async (): Promise<ToolResult> => {
        if (params.reset === true) session.reset();
        const timeoutMs = Math.max(1, params.timeout ?? DEFAULT_TIMEOUT_MS);
        try {
          const js = await transpileToJs(params.code);
          const { value, output } = await session.evaluate(js, timeoutMs);
          return {
            content: [{ type: "text", text: composeResult(output, value) }],
            details: { reset: params.reset === true },
          };
        } catch (error) {
          // User-code failures (syntax, runtime, timeout) are results, not
          // tool failures; the session state stays for the next call.
          return {
            content: [{
              type: "text",
              text: `[error]\n${errorMessage(error)}`,
            }],
            details: { reset: params.reset === true, error: true },
          };
        }
      };
      return await (queue = queue.then(run, run));
    },
  };
}
