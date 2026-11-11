/** `bun test` only: the runtime shim plus `Deno.test` mapped to `bun:test`. */
import { test } from "bun:test";
import "../../packages/core/runtime/deno.ts";

type DenoTestOptions = {
  name: string;
  fn: () => void | Promise<void>;
  ignore?: boolean;
  only?: boolean;
};

const denoTest = (
  nameOrOptions: string | DenoTestOptions,
  optionsOrFn?: { ignore?: boolean; only?: boolean } | (() => unknown),
  maybeFn?: () => unknown,
) => {
  if (typeof nameOrOptions === "string") {
    const options =
      typeof optionsOrFn === "function" ? {} : (optionsOrFn ?? {});
    const body = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (typeof body !== "function") {
      throw new Error(`test expects a function as the body: ${nameOrOptions}`);
    }
    if (options.ignore) return test.skip(nameOrOptions, body as () => unknown);
    if (options.only) return test.only(nameOrOptions, body as () => unknown);
    test(nameOrOptions, body as () => unknown);
    return;
  }
  const { name, fn: body, ignore, only } = nameOrOptions;
  if (ignore) return test.skip(name, body as () => unknown);
  if (only) return test.only(name, body as () => unknown);
  test(name, body as () => unknown);
};

// deno-lint-ignore no-explicit-any
((globalThis as any).Deno as Record<string, unknown>).test = denoTest;
