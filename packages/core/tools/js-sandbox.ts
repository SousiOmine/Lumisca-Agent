import { inspect } from "node:util";
import { type Context, createContext, runInContext } from "node:vm";
import { errorMessage } from "../errors.ts";
import { withTimeoutError } from "../shared/mod.ts";
import { MAX_TOOL_OUTPUT, truncatedNote } from "./truncate.ts";

/**
 * A JavaScript sandbox for the two sessions that run model-written code:
 * the `eval` tool (a REPL whose globals persist across calls) and code
 * execution (`execute`, one program per call).
 *
 * The sandbox is deliberately NOT a security boundary: the host `Deno`
 * namespace, `fetch` and the standard web globals are exposed, so code
 * here has the same *permissions* as `bash` (files, network, processes,
 * env). It is still a separate vm context, so only the globals this module
 * lists exist in addition to the ECMAScript built-ins — node internals
 * (`process`, `require`, `Buffer`) are absent on purpose.
 *
 * stella never uses this: its code runs inside the virtual machine (see
 * code-execution/vm.ts), because running a server-process sandbox there
 * would be a way out of the machine.
 */

/** inspect depth for the completion value (arrays of objects stay readable). */
const RESULT_DEPTH = 4;
/** inspect bounds: huge arrays/strings would otherwise materialize a giant
 * result string before truncation even runs. */
const RESULT_MAX_ARRAY = 200;
const RESULT_MAX_STRING = 8192;

/** Type stripper, loaded lazily on the first call so the server startup
 * does not pay for parsing it. Sucrase is a pure-JS transpiler with a
 * stable API that does not depend on the typescript package — typescript 7
 * (the native compiler) exposes no transpile API, and ts-blank-space pins
 * typescript 5/6, so sucrase keeps the code tools updateable independently. */
let sucrase: typeof import("sucrase") | undefined;

/** Strip TypeScript type annotations so vm can run the snippet. Plain
 * JavaScript passes through unchanged; a syntax error throws with the line it
 * is on, because the parser's own message carries only a position. Imports
 * are left untouched (disableESTransforms) and fail in vm with a clear
 * error. */
export async function transpileToJs(code: string): Promise<string> {
  const { transform } = (sucrase ??= await import("sucrase"));
  try {
    return transform(code, {
      transforms: ["typescript"],
      disableESTransforms: true,
    }).code;
  } catch (error) {
    throw new Error(syntaxErrorText(code, error));
  }
}

/** How much of a source line a syntax error shows on each side of the caret.
 * A program that embeds a shell command has lines of thousands of characters,
 * and the caret has to stay on screen. */
const ERROR_LINE_WINDOW = 100;

/** sucrase reports `Unexpected token, expected "," (6:51)`: a position and
 * nothing else. The mistake is usually one unescaped character in a template
 * literal, so the line and the caret are what let the model find it without
 * guessing at the cause. */
function syntaxErrorText(code: string, error: unknown): string {
  const message = errorMessage(error);
  const match = /^(.*) \((\d+):(\d+)\)$/s.exec(message);
  if (match === null) return message;
  const [, reason, lineText, columnText] = match;
  const line = Number(lineText);
  const column = Number(columnText);
  const source = code.split("\n")[line - 1];
  if (source === undefined) return message;
  const { text, caret } = windowAround(source, column);
  const number = String(line);
  return [
    `Syntax error at line ${line}, column ${column}: ${reason}`,
    "",
    `${number} | ${text}`,
    `${" ".repeat(number.length)} | ${" ".repeat(caret)}^`,
    "",
    "Common cause: a backtick or `${` inside a template literal. Write " +
      "them as \\` and \\${, and close every quoted string on its own line.",
  ].join("\n");
}

/** The part of `source` around `column`, one space per tab so the caret lines
 * up, with an ellipsis marking a cut on either side. */
function windowAround(
  source: string,
  column: number,
): { text: string; caret: number } {
  const at = Math.min(Math.max(column - 1, 0), source.length);
  const start = Math.max(0, at - ERROR_LINE_WINDOW);
  const end = Math.min(source.length, at + ERROR_LINE_WINDOW);
  const head = start > 0 ? "…" : "";
  const tail = end < source.length ? "…" : "";
  return {
    text: head + source.slice(start, end).replace(/\t/g, " ") + tail,
    caret: head.length + (at - start),
  };
}

/** True when `value` is a promise-like completion that the host must await
 * before the call can report its result. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** V8 reports top-level await in a script in different ways depending on
 * what follows the `await` (`await f(...)` parses as an identifier call
 * and fails with "missing ) after argument list"); the only reliable
 * signal is the token itself. */
function hasAwait(code: string): boolean {
  return /\bawait\b/.test(code);
}

export interface JsSandboxOptions {
  /** Host values every snippet sees in addition to the standard web
   * globals (the scripting tool call puts its `tools` namespace here).
   * Re-applied by {@link JsSandbox.reset}. */
  globals?: Record<string, unknown>;
}

/** One REPL session: an isolated vm context whose globals persist across
 * calls. Top-level `var`/`let`/`const` and function declarations persist;
 * re-declaring a `let`/`const` name in a later call throws. */
export class JsSandbox {
  private sandbox: Record<string, unknown>;
  private context: Context;
  private output: string[] = [];
  /** Cumulative console bytes; once the budget is exceeded further lines
   * are dropped (a note is appended to the result) so a huge console.log
   * loop can never accumulate unbounded output in memory. */
  private outputBytes = 0;
  private outputTruncated = false;
  /** Timers the snippets scheduled (see newSandbox): reset() and close()
   * stop them, so a forgotten interval cannot outlive its sandbox. Typed
   * `unknown` because the host's timer handle is a number at runtime but
   * the Node typings in scope declare an object. */
  private readonly timers = new Set<unknown>();
  private readonly globals: Record<string, unknown>;

  constructor(options: JsSandboxOptions = {}) {
    this.globals = options.globals ?? {};
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
    // Timers are tracked so reset() can stop them. A snippet that leaves a
    // `setInterval` behind keeps running in THIS process — the sandbox is a
    // vm context, not a separate runtime — so an unattended interval would
    // outlive the call, the reset, and the session (replacing the sandbox
    // does not stop a timer the host already scheduled).
    const schedule =
      (repeat: boolean) =>
      (handler: unknown, ms?: number, ...rest: unknown[]): number => {
        const run = (): void => {
          if (typeof handler !== "function") return;
          try {
            (handler as (...args: unknown[]) => void)(...rest);
          } catch (error) {
            // A throwing callback must not take the server process down.
            console.error(`[script timer] ${errorMessage(error)}`);
          }
        };
        const id: unknown = repeat
          ? setInterval(run, ms)
          : setTimeout(() => {
              this.timers.delete(id);
              run();
            }, ms);
        this.timers.add(id);
        return id as number;
      };
    const cancel = (id: number): void => {
      this.timers.delete(id);
      clearTimeout(id);
      clearInterval(id);
    };
    return {
      // Same permission level as bash: full host access. The snippet runs in
      // a vm context, so only what is listed here exists — V8 provides the
      // ECMAScript built-ins, nothing else. The web globals below are
      // deliberately complete enough for real work: `fetch` is useless
      // without AbortController, and binary/text handling is impossible
      // without TextEncoder/TextDecoder (their absence used to fail
      // perfectly ordinary snippets). Node internals (process, require,
      // Buffer) stay out on purpose.
      Deno,
      fetch,
      Request,
      Response,
      Headers,
      FormData,
      Blob,
      ReadableStream,
      URL,
      URLSearchParams,
      WebSocket,
      AbortController,
      AbortSignal,
      TextEncoder,
      TextDecoder,
      atob,
      btoa,
      crypto,
      structuredClone,
      performance,
      queueMicrotask,
      setTimeout: schedule(false),
      clearTimeout: cancel,
      setInterval: schedule(true),
      clearInterval: cancel,
      console: { log: emit, info: emit, warn: emit, error: emit },
      ...this.globals,
    };
  }

  /** Discard all state (the `reset` argument), stopping every timer the
   * snippets scheduled: the sandbox they closed over is gone, so a surviving
   * interval could only write into a dead context. */
  reset(): void {
    this.clearTimers();
    this.sandbox = this.newSandbox();
    this.context = createContext(this.sandbox);
  }

  /** Stop every timer this session's snippets scheduled. */
  close(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const id of this.timers) {
      clearTimeout(id as number);
      clearInterval(id as number);
    }
    this.timers.clear();
  }

  /** Run one snippet and return its completion value and console output.
   * Code that mentions `await` and fails to parse as a script is re-run in
   * an async wrapper (top-level await is only valid in modules): the
   * wrapper cannot return a completion value, so such calls report results
   * via `console.log` and `globalThis` state — the tool descriptions tell
   * the model this. Every promise the snippet produces, including the
   * wrapper's own, is awaited within the remaining timeout: an async
   * wrapper that awaited forever used to hold the tool call (and with it
   * the run) for good, because `runInContext`'s timeout only bounds the
   * synchronous part. */
  async run(
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
      // reported as-is. The wrapper's promise IS the snippet: awaiting it
      // is what makes the timeout (and a failing await) observable at all.
      value = runInContext(`(async () => {\n${code}\n})()`, this.context, {
        timeout: timeoutMs,
      });
    }
    if (isThenable(value)) {
      value = await withTimeoutError(
        Promise.resolve(value),
        timeoutMs,
        () => new Error(`Script execution timed out after ${timeoutMs}ms`),
      );
    }
    const output =
      this.output.join("\n") +
      (this.outputTruncated ? truncatedNote("console output") : "");
    return { value, output };
  }
}

function formatConsoleArg(arg: unknown): string {
  return typeof arg === "string" ? arg : inspect(arg);
}

/** The text a script's outcome is reported as: its console output, then its
 * completion value. A string value is reported as itself: the model reads it
 * as text, and `inspect` would only add quotes and escaped newlines to every
 * line of what a tool returned. Everything else is inspected. */
export function composeScriptResult(output: string, value: unknown): string {
  const parts: string[] = [];
  if (output.length > 0) parts.push(`[output]\n${output}`);
  if (value !== undefined) parts.push(`[result]\n${resultText(value)}`);
  return parts.join("\n\n");
}

/** `inspect` bounds a huge array or string that a program built without
 * meaning to. A string returned whole is bounded by the caller's own
 * truncation of the composed result. */
function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(value, {
    depth: RESULT_DEPTH,
    maxArrayLength: RESULT_MAX_ARRAY,
    maxStringLength: RESULT_MAX_STRING,
  });
}
