import {
  integer,
  object,
  optional,
  string,
  stringMap,
  type Tool,
} from "./schema.ts";
import { TOOL_BASH } from "../shared.ts";
import type { Sandbox } from "../workspace/sandbox.ts";
import { decodeOutput, detectOemLabel } from "./decode.ts";
import { killProcessTree } from "./background.ts";
import { MAX_TOOL_OUTPUT, truncate, truncatedNote } from "./truncate.ts";

const bashSchema = object({
  cwd: string(
    "Working directory: a workspace folder name (e.g. `Aaa`) or an absolute path",
  ),
  command: string("The shell command to execute"),
  timeout: optional(integer("Timeout in seconds (default 120)")),
  env: optional(stringMap("Environment variables to pass to the command")),
});

export interface BashToolOptions {
  /** Workspace sandbox used to resolve the `cwd` argument. */
  sandbox: Sandbox;
  /** Extra env vars to expose. */
  env?: Record<string, string>;
  /** Default timeout in seconds. */
  defaultTimeoutSec?: number;
}

/**
 * Execute a shell command. On Windows uses cmd.exe, elsewhere /bin/sh.
 * The working directory is a required argument, resolved against the
 * workspace; the command itself is not sandboxed beyond that (same
 * policy as pi).
 */
export function createBashTool(
  options: BashToolOptions,
): Tool<typeof bashSchema> {
  const defaultTimeoutSec = options.defaultTimeoutSec ?? 120;

  return {
    name: TOOL_BASH,
    label: "Bash",
    description:
      "Execute a shell command in the workspace. `cwd` is required and must be " +
      "a workspace folder name or an absolute path. Output is limited to the last 64KB. " +
      "Use for build, test, git, and other commands. `timeout` is in seconds.",
    parameters: bashSchema,
    execute: async (_id, params, signal) => {
      const resolved = await options.sandbox.resolve(params.cwd);
      if (!resolved.ok) throw new Error(resolved.reason);
      const timeoutSec = params.timeout ?? defaultTimeoutSec;
      const shell = Deno.build.os === "windows"
        ? { file: "cmd.exe", args: ["/d", "/s", "/c"] }
        : { file: "/bin/sh", args: ["-c"] };

      const command = new Deno.Command(shell.file, {
        args: [...shell.args, params.command],
        cwd: resolved.path,
        // Per-call env vars override the tool-level env.
        env: { ...options.env, ...params.env },
        stdout: "piped",
        stderr: "piped",
      });

      const child = command.spawn();
      const kill = () => killProcessTree(child);
      const onAbort = () => kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(kill, timeoutSec * 1000);

      try {
        const { stdout, stderr, code } = await child.output();
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const oemLabel = await detectOemLabel();
        const outText = decodeOutput(stdout, oemLabel);
        const errText = decodeOutput(stderr, oemLabel);
        const { text: outTrimmed, truncated: outTruncated } = truncate(
          outText,
          MAX_TOOL_OUTPUT,
        );
        const { text: errTrimmed, truncated: errTruncated } = truncate(
          errText,
          MAX_TOOL_OUTPUT,
        );
        let body = outTrimmed;
        if (outTruncated) body += truncatedNote("stdout");
        if (errTrimmed.length > 0) {
          body += body.length > 0 ? "\n\n[stderr]\n" : "";
          body += errTrimmed;
          if (errTruncated) body += truncatedNote("stderr");
        }
        body += `\n[exit code: ${code}]`;
        return {
          content: [{ type: "text", text: body }],
          details: { exitCode: code, cwd: resolved.path },
        };
      } catch (error) {
        // output() failed (pipe error, spawn-time failure): make sure the
        // child is dead before surfacing the failure — a stray process
        // would keep running (and hold the pipes) otherwise.
        kill();
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
