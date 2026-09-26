/**
 * `lumisca-server service …`: the commands that make a packaged server
 * resident on a Linux machine, as a systemd *user* unit plus linger.
 *
 * Shape of the feature, and why it looks like this:
 *
 * - The unit is a user unit, so the agent (which runs arbitrary shell
 *   commands) runs as its owner, never as root, and needs no `sudo` to
 *   install. Only `loginctl enable-linger` may need it, and the install
 *   reports that as the one remaining step instead of hiding it.
 * - The shipped template is the first composition layer and the installed
 *   `service.env` the second, so `config` shows exactly what `install` would
 *   write, and reinstalling keeps the credential and the values the operator
 *   already has (compose.ts owns the order).
 * - Installing is the only thing that touches the system; every precondition
 *   (Linux, a packaged binary, a writable install directory, a free port) is
 *   checked first and reported as a clear failure, because the alternative is
 *   a restart loop under systemd's `Restart=always` with the reason buried in
 *   the journal.
 * - Supervision stays systemd's job: this module writes the definition and
 *   asks systemd to (re)start it. `LUMISCA_UPDATE_RESTART=supervisor` in the
 *   document is what tells an applied update to exit so systemd brings up the
 *   new binary (see update/service.ts).
 *
 * This file is the dispatcher only: it parses the command line, picks a verb,
 * and maps what that verb throws onto an exit code. One file per verb
 * (config.ts, install.ts, status.ts, uninstall.ts) holds the verb itself,
 * shared.ts what they all use, deps.ts the outside world they work through,
 * and plan.ts / compose.ts / document.ts / template.ts / runner.ts the
 * definition and the systemd boundary underneath.
 */
import { runConfig } from "./config.ts";
import { defaultServiceDeps, type ServiceDeps } from "./deps.ts";
import { ServiceDefinitionError } from "./document.ts";
import { runInstall } from "./install.ts";
import {
  parseServiceArgs,
  SERVICE_USAGE,
  type ServiceInvocation,
  ServiceUsageError,
} from "./plan.ts";
import { runStatus } from "./status.ts";
import { runUninstall } from "./uninstall.ts";

/**
 * Run one `service` invocation and return the process exit code:
 * `0` success, `1` an action that failed, `2` a command line or environment
 * this installation cannot act on.
 *
 * Resolving this machine (HOME, the user, the paths) is part of the work, so
 * it happens inside the error mapping: a missing HOME must be reported here,
 * not escape as a rejection the process would swallow into a silent exit 0.
 */
export async function runServiceCommand(
  args: readonly string[],
  deps?: ServiceDeps,
): Promise<number> {
  let invocation: ServiceInvocation;
  try {
    invocation = parseServiceArgs(args);
  } catch (error) {
    if (error instanceof ServiceUsageError) {
      console.error(`lumisca-server service: ${error.message}\n`);
      console.error(SERVICE_USAGE);
      return 2;
    }
    throw error;
  }
  if (invocation.verb === "help") {
    console.log(SERVICE_USAGE);
    return 0;
  }

  let service: ServiceDeps | undefined;
  try {
    service = deps ?? defaultServiceDeps();
    const { verb } = invocation;
    if (verb === "config") return await runConfig(invocation, service);
    if (verb === "install") return await runInstall(invocation, service);
    if (verb === "status") return await runStatus(service);
    return await runUninstall(service);
  } catch (error) {
    // Without a resolved host there is no `err` to use yet; the fallback
    // writes to the console directly (the same stream the real one uses).
    const report = service?.err ?? ((line: string) => console.error(line));
    report(
      `lumisca-server service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (
      error instanceof ServiceUsageError ||
      error instanceof ServiceDefinitionError
    ) {
      return 2;
    }
    return 1;
  }
}
