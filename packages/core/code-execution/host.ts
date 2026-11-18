import { JsSandbox, transpileToJs } from "../tools/js-sandbox.ts";
import {
  type CodeRunContext,
  type CodeRunOutcome,
  type CodeRuntime,
  type CodeToolCall,
  programOf,
} from "./types.ts";

/**
 * Code execution on the host: the program runs in the server-process
 * sandbox (tools/js-sandbox.ts), the same one `eval` uses, with a `tools`
 * namespace added.
 *
 * A sandbox per call, closed afterwards: a program is one request, so its
 * variables, its timers and its printed output must not survive into the
 * next one. That is the one difference from `eval`, which keeps its state
 * on purpose.
 *
 * The sandbox is not a boundary (see js-sandbox.ts): a program here has the
 * same permissions as `bash`. A stella conversation never lands here — its
 * programs run inside the machine (see vm.ts).
 */
export function createHostCodeRuntime(): CodeRuntime {
  return {
    async run(code: string, context: CodeRunContext): Promise<CodeRunOutcome> {
      context.signal?.throwIfAborted();
      const sandbox = new JsSandbox({
        globals: { tools: toolsOf(context.call) },
      });
      try {
        const js = await transpileToJs(code);
        const { value, output } = await sandbox.run(
          programOf(js),
          context.timeoutMs,
        );
        // A run aborted while its program was finishing must not report a
        // value: the turn it belonged to is gone.
        context.signal?.throwIfAborted();
        return { value, output };
      } finally {
        sandbox.close();
      }
    },
  };
}

/** The `tools` object a program sees: `tools.<name>(args)` runs that tool
 * and resolves to its text. Unknown names are not filtered here — the
 * catalog answers with the way to look one up, which is a better error
 * than an undefined call. */
function toolsOf(call: CodeToolCall): Record<string, unknown> {
  // `then` stays undefined: a proxy that answers every property would make
  // `await tools` (or any promise plumbing that probes it) treat the
  // namespace as a thenable and hang.
  const answer = (name: string) => (args?: unknown) =>
    call(name, args ?? {}).then((result) => result.text);
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined;
      return answer(property);
    },
    has() {
      return true;
    },
  });
}
