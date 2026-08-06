import { Type } from "npm:@earendil-works/pi-ai@0.83.0";
import type { AgentTool } from "npm:@earendil-works/pi-agent-core@0.83.0";
import { decodeOutput, detectOemLabel } from "./decode.ts";
import { MAX_TOOL_OUTPUT, truncate } from "./truncate.ts";

const bashSchema = Type.Object({
  command: Type.String({ description: "The shell command to execute" }),
  timeout: Type.Optional(
    Type.Integer({ description: "Timeout in seconds (default 120)" }),
  ),
});

export interface BashToolOptions {
  /** Default working directory for commands. */
  cwd: string;
  /** Extra env vars to expose. */
  env?: Record<string, string>;
  /** Default timeout in seconds. */
  defaultTimeoutSec?: number;
}

/**
 * Execute a shell command. On Windows uses cmd.exe, elsewhere /bin/sh.
 * The command runs with the workspace folder as its working directory;
 * it is not sandboxed beyond that (same policy as pi).
 */
export function createBashTool(
  options: BashToolOptions,
): AgentTool<typeof bashSchema> {
  const defaultTimeoutSec = options.defaultTimeoutSec ?? 120;

  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a shell command in the workspace. Output is limited to the last 64KB. " +
      "Use for build, test, git, and other commands. `timeout` is in seconds.",
    parameters: bashSchema,
    execute: async (_id, params, signal) => {
      const timeoutSec = params.timeout ?? defaultTimeoutSec;
      const shell = Deno.build.os === "windows"
        ? { file: "cmd.exe", args: ["/d", "/s", "/c"] }
        : { file: "/bin/sh", args: ["-c"] };

      const command = new Deno.Command(shell.file, {
        args: [...shell.args, params.command],
        cwd: options.cwd,
        env: options.env,
        stdout: "piped",
        stderr: "piped",
      });

      const child = command.spawn();
      const kill = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      };
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
        if (outTruncated) body += "\n[stdout truncated to the last 64KB]";
        if (errTrimmed.length > 0) {
          body += body.length > 0 ? "\n\n[stderr]\n" : "";
          body += errTrimmed;
          if (errTruncated) body += "\n[stderr truncated to the last 64KB]";
        }
        body += `\n[exit code: ${code}]`;
        return {
          content: [{ type: "text", text: body }],
          details: { exitCode: code, cwd: options.cwd },
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
