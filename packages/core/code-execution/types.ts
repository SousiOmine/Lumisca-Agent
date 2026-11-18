/**
 * The contract between the `execute` tool and the place a program runs.
 *
 * Two runtimes implement it for the same tool: the server-process sandbox
 * on the host (host.ts), and the node inside a stella machine (vm.ts). The
 * tool itself does the bookkeeping that must not depend on where the code
 * runs — the safety check, the call cap, the image cap, the result text —
 * so the two paths cannot drift in what the model sees.
 */

/** One image a nested tool returned, as the outer result forwards it. */
export interface CodeToolImage {
  data: string;
  mimeType: string;
}

/** What a nested call hands back to the script. */
export interface CodeToolResult {
  /** The tool's text result: what `tools.<name>(args)` resolves to. */
  text: string;
  /** Images the tool returned. A script cannot use them, so the runtime
   * does not hand them over; the cap in execute.ts decides which ones the
   * model sees afterwards. */
  images: readonly CodeToolImage[];
}

/**
 * Run one tool on behalf of a script. Throws when the tool failed: the
 * script catches it like any other exception, and the failure inside a
 * `try` is the reason `tools.<name>(args)` is a rejected promise rather
 * than an object carrying an error flag.
 */
export type CodeToolCall = (
  name: string,
  args: unknown,
) => Promise<CodeToolResult>;

export interface CodeRunContext {
  call: CodeToolCall;
  /** Wall-clock budget of the whole program, tool waits included. The
   * runtime enforces it; the tool enforces it again around the calls. */
  timeoutMs: number;
  /** The run's abort signal: a stopped turn stops the program. */
  signal?: AbortSignal;
}

export interface CodeRunOutcome {
  /** The program's completion value. */
  value: unknown;
  /** Everything it printed. */
  output: string;
}

export interface CodeRuntime {
  /** Run one program to completion. Rejects on a script error, on the
   * timeout, and on an abort. */
  run(code: string, context: CodeRunContext): Promise<CodeRunOutcome>;
}

/** Wrap a program so a top-level `return` and a top-level `await` both
 * work: a completion value is how the model reports what the answer needs,
 * and a bare module body has no `return`. */
export function programOf(code: string): string {
  return `(async () => {\n${code}\n})()`;
}
