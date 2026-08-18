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
import type { CommandSafety } from "../safety/command-safety.ts";
import { decodeOutput, detectOemLabel } from "./decode.ts";
import { killProcessTree } from "./background.ts";
import { getShell } from "./shell.ts";
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
  /** Command safety check (the fast model judges the command before it
   * runs; a blocked command returns the reason as the tool result).
   * Omitted → the command runs unchecked. */
  safety?: CommandSafety;
}

/**
 * Execute a shell command. On Windows uses PowerShell (pwsh if installed,
 * else Windows PowerShell), elsewhere /bin/sh. The working directory is a
 * required argument, resolved against the workspace; the command itself is
 * not sandboxed beyond that (same policy as pi).
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
      "Use for build, test, git, and other commands. `timeout` is in seconds. " +
      "On Windows, commands run in PowerShell (PowerShell 7 if installed, " +
      "else Windows PowerShell; systems without PowerShell fall back to " +
      "Git Bash or cmd.exe): use `$env:VAR` for environment variables, `;` " +
      "to separate commands, `2>&1` to merge stderr into stdout; `&&` is " +
      "only available with PowerShell 7. cmd-style aliases (`cd`, `dir`, " +
      "`type`, `copy`) work. On macOS/Linux, commands run in /bin/sh.",
    parameters: bashSchema,
    execute: async (_id, params, signal) => {
      // Resolve the working directory before the safety check so the check
      // judges the exact context the command would run in.
      const resolved = await options.sandbox.resolve(params.cwd);
      if (!resolved.ok) throw new Error(resolved.reason);
      if (options.safety !== undefined) {
        const verdict = await options.safety.check(
          "bash",
          params.command,
          resolved.path,
        );
        if (!verdict.ok) {
          // The fast model judged the command unsafe: report its reason as
          // the tool result (the command is never spawned).
          return {
            content: [{
              type: "text",
              text: "[blocked by safety check]\n" +
                (verdict.reason ?? "The command was judged unsafe."),
            }],
            details: { blocked: true, reason: verdict.reason ?? "" },
          };
        }
      }
      const timeoutSec = params.timeout ?? defaultTimeoutSec;
      const shell = getShell();

      const command = new Deno.Command(shell.file, {
        args: [...shell.args, params.command],
        cwd: resolved.path,
        // Per-call env vars override the tool-level env and the shell env.
        env: { ...options.env, ...shell.env, ...params.env },
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
