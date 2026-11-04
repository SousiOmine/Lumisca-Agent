/**
 * The launcher tool: `vm_launch`.
 *
 * A screen with no desktop menu — the machine runs openbox, which draws
 * frames and nothing else — leaves the agent two questions it cannot answer
 * from a picture: what is installed, and how to start it. Both are this tool.
 *
 * `action: "list"` reads the same freedesktop entries a desktop menu reads
 * (see applications.ts), so "installed" means what it means to a person at
 * that machine. `action: "start"` runs one of them with `DISPLAY` set (the
 * image declares it, and `podman exec` inherits it), detached: a program that
 * runs until the user closes it must not hold the tool call open.
 */
import { CoreError } from "../errors.ts";
import { TOOL_VM_LAUNCH } from "../shared/mod.ts";
import {
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import {
  APPLICATION_DIRS,
  applicationFromDesktopFile,
  describeApplications,
  sortApplications,
  type VmApplication,
} from "./applications.ts";
import type { VmExec } from "./container.ts";

/** How long the listing may take. Reading a directory of small text files is
 * instant; the timeout only stops a hung machine from holding the call. */
const LIST_TIMEOUT_MS = 15_000;

/** How long the start may take to be accepted. The program itself keeps
 * running (it is detached); this only bounds the shell that starts it. */
const START_TIMEOUT_MS = 15_000;

const launchSchema = object({
  action: string(
    'What to do: "list" (the programs installed in the machine) or "start" ' +
      "(run one of them on the screen).",
  ),
  id: optional(string(
    "The program to start, as `list` named it (the `.desktop` id). Required " +
      "for `start`.",
  )),
  wait_ms: optional(integer(
    "How long to wait after starting before returning, so the window has a " +
      "chance to appear (default 1500, at most 10000). Take a screenshot " +
      "afterwards to see it.",
  )),
});

export interface VmLaunchOptions {
  exec: VmExec;
  /** Where the entries are read from. Defaults to the specification's
   * directories; a test passes its own. */
  dirs?: readonly string[];
}

/** Every entry the machine has, one per id (the earlier directory wins, the
 * way a desktop resolves them). */
export async function listApplications(
  options: VmLaunchOptions,
): Promise<VmApplication[]> {
  const dirs = options.dirs ?? APPLICATION_DIRS;
  const byId = new Map<string, VmApplication>();
  for (const dir of dirs) {
    // `ls` rather than a directory walk from the host: this runs INSIDE the
    // machine, and the file tools are not available to every caller here.
    const listed = await options.exec(
      ["sh", "-c", `ls -1 ${quoteAll(dir)}/*.desktop 2>/dev/null || true`],
      { timeoutMs: LIST_TIMEOUT_MS },
    );
    const names = listed.stdout.split("\n").map((line) => line.trim())
      .filter((line) => line !== "");
    for (const file of names) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (byId.has(name.slice(0, -".desktop".length))) continue;
      const read = await options.exec(["cat", file], {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      if (read.exitCode !== 0) continue;
      const app = applicationFromDesktopFile(name, read.stdout);
      if (app === undefined) continue;
      byId.set(app.id, app);
    }
  }
  return sortApplications([...byId.values()]);
}

/** Start one program, detached, and give its window a moment to appear. */
async function startApplication(
  options: VmLaunchOptions,
  id: string,
  waitMs: number,
): Promise<VmApplication> {
  const applications = await listApplications(options);
  const app = applications.find((candidate) => candidate.id === id);
  if (app === undefined) {
    throw new CoreError(
      `No program with that id is installed: ${id}. Call vm_launch with ` +
        `action "list" to see what is.`,
      "invalid",
    );
  }
  // Detached with `setsid` and both streams redirected: the program must
  // outlive this shell (it is a window the user will interact with), and a
  // child holding the pipe would make this call wait for the program to exit.
  const started = await options.exec(
    [
      "sh",
      "-c",
      `setsid ${app.exec} >/dev/null 2>&1 < /dev/null & echo $!`,
    ],
    { timeoutMs: START_TIMEOUT_MS },
  );
  if (started.exitCode !== 0) {
    throw new CoreError(
      `Could not start ${app.name}: ${
        (started.stderr || started.stdout).trim() || "no output"
      }`,
      "unavailable",
    );
  }
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return app;
}

/** `sh` needs the path quoted; entries live under fixed directories but the
 * shell would still split on a space in a name. */
function quoteAll(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

export function createVmLaunchTool(
  options: VmLaunchOptions,
): Tool<typeof launchSchema> {
  return {
    name: TOOL_VM_LAUNCH,
    label: "VM Launch",
    description:
      "The programs installed in the machine, and starting one on its " +
      'screen. `action: "list"` returns what is installed (the same entries ' +
      'a desktop menu reads). `action: "start"` runs one by its id, ' +
      "detached, and waits a moment for its window; take a screenshot " +
      "afterwards to see it. The machine has no desktop menu: a program " +
      "that is not started this way has no window.",
    parameters: launchSchema,
    async execute(_id, params): Promise<ToolResult> {
      const action = params.action.trim();
      switch (action) {
        case "list": {
          const applications = await listApplications(options);
          return {
            content: [{
              type: "text",
              text: describeApplications(applications),
            }],
            details: { applications },
          };
        }
        case "start": {
          const id = params.id?.trim();
          if (id === undefined || id === "") {
            throw new CoreError(
              "start needs `id`: the program as `list` named it",
              "invalid",
            );
          }
          const waitMs = params.wait_ms ?? 1500;
          if (waitMs < 0 || waitMs > 10_000) {
            throw new CoreError(
              "wait_ms must be between 0 and 10000",
              "invalid",
            );
          }
          const app = await startApplication(options, id, waitMs);
          return {
            content: [{
              type: "text",
              text:
                `Started ${app.name}. Its window may take a moment; take a ` +
                "screenshot to see the screen.",
            }],
            details: { id: app.id, name: app.name, exec: app.exec },
          };
        }
        default:
          throw new CoreError(
            `Unknown action "${params.action}". Use "list" or "start".`,
            "invalid",
          );
      }
    },
  };
}
