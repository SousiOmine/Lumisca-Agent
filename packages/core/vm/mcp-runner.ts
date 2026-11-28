/**
 * The MCP machine runner: how an MCP server is started inside one agent's
 * machine (see mcp/machine.ts for what the caller does with it).
 *
 * It lives here, not in the MCP module, because the container's name, the
 * user and the default working directory are the VM module's business; the
 * MCP module only asks for a command line.
 */
import { isAbsolute, join } from "node:path";
import type { MachineRunner } from "../mcp/machine.ts";
import { vmAgentDir, vmContainerName } from "./contract.ts";
import { execArgv } from "./podman.ts";

export function vmMachineRunner(
  agentId: string,
  /** Wake the machine before the first spawn (see machine.ts). */
  ready?: () => Promise<void>,
): MachineRunner {
  const container = vmContainerName(agentId);
  // Relative to the agent's own folder, the way a workspace folder is the
  // base on the host: podman exec needs an absolute --workdir.
  const home = vmAgentDir(agentId);
  return {
    ...(ready !== undefined ? { ready } : {}),
    process: (command, options) => {
      const cwd =
        options?.cwd === undefined
          ? home
          : isAbsolute(options.cwd)
            ? options.cwd
            : join(home, options.cwd);
      const argv = execArgv(container, command, {
        interactive: true,
        ...(options?.env !== undefined ? { env: options.env } : {}),
        workdir: cwd,
      });
      return { file: argv[0]!, args: argv.slice(1) };
    },
  };
}
