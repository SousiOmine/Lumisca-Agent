/**
 * The launcher tool: listing what the machine has, and starting one of them.
 *
 * The two halves fail differently and both matter: a list that offers a
 * program that cannot start sends the agent after a window that never
 * appears, and a start that waits for the program to exit holds the tool call
 * open until the user closes a program they are still using.
 */
import { assertEquals, assertRejects } from "@std/assert";
import type { VmExec, VmExecResult } from "./container.ts";
import { createVmLaunchTool } from "./launcher.ts";

const ENTRY = `[Desktop Entry]
Name=Files
Comment=Browse the filesystem
Exec=nautilus %U
Type=Application
`;

function ok(stdout = ""): VmExecResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
  };
}

/** A machine with one entry, answering `ls` and `cat` from it. */
function makeExec(
  entries: Record<string, string>,
  onStart?: (command: string) => VmExecResult,
): { exec: VmExec; calls: string[] } {
  const calls: string[] = [];
  const exec: VmExec = (args) => {
    const command = args.join(" ");
    calls.push(command);
    if (command.startsWith("sh -c ls -1")) {
      return Promise.resolve(
        ok(
          Object.keys(entries)
            .map((name) => `/apps/${name}`)
            .join("\n"),
        ),
      );
    }
    if (command.startsWith("cat ")) {
      const path = command.slice("cat ".length);
      const name = path.slice(path.lastIndexOf("/") + 1);
      const text = entries[name];
      return Promise.resolve(text === undefined ? ok() : ok(text));
    }
    if (command.includes("setsid")) {
      return Promise.resolve(onStart?.(command) ?? ok("4242\n"));
    }
    return Promise.resolve(ok());
  };
  return { exec, calls };
}

function tool(
  entries: Record<string, string>,
  onStart?: (c: string) => VmExecResult,
) {
  const { exec, calls } = makeExec(entries, onStart);
  return {
    calls,
    launch: createVmLaunchTool({ exec, dirs: ["/apps"] }),
  };
}

Deno.test("vm_launch: list names what the machine installed", async () => {
  const { launch } = tool({ "files.desktop": ENTRY });
  const result = await launch.execute("t1", { action: "list" }, undefined);
  const text = result.content[0];
  assertEquals(text?.type === "text" && text.text.includes("Files"), true);
});

Deno.test("vm_launch: start runs the entry's command, detached", async () => {
  const { launch, calls } = tool({ "files.desktop": ENTRY });
  const result = await launch.execute(
    "t1",
    { action: "start", id: "files", wait_ms: 0 },
    undefined,
  );
  assertEquals(result.details?.id, "files");
  const started = calls.find((c) => c.includes("setsid"));
  assertEquals(started !== undefined, true, calls.join("\n"));
  // Detached with both streams redirected: the tool must not wait for the
  // program to be closed by the user.
  assertEquals(started!.includes("nautilus"), true, started);
  assertEquals(started!.includes(">/dev/null 2>&1"), true, started);
  assertEquals(started!.includes("&"), true, started);
});

Deno.test("vm_launch: an id that is not installed says so and lists", async () => {
  const { launch } = tool({ "files.desktop": ENTRY });
  const failure = assertRejects(
    () => launch.execute("t1", { action: "start", id: "nope" }, undefined),
    Error,
  );
  await failure.then((error) => {
    assertEquals(error.message.includes("No program"), true, error.message);
    assertEquals(error.message.includes("list"), true, error.message);
  });
});

Deno.test("vm_launch: start needs an id", async () => {
  const { launch } = tool({ "files.desktop": ENTRY });
  await assertRejects(
    () => launch.execute("t1", { action: "start" }, undefined),
    Error,
  );
});

Deno.test("vm_launch: a shell that refuses to start is reported", async () => {
  // The command line itself can fail (a missing binary): the tool says what
  // the shell said instead of claiming the program started.
  const { launch } = tool({ "files.desktop": ENTRY }, () => ({
    exitCode: 127,
    stdout: "",
    stderr: "sh: nautilus: not found",
    timedOut: false,
    truncated: false,
  }));
  const error = await assertRejects(
    () =>
      launch.execute(
        "t1",
        { action: "start", id: "files", wait_ms: 0 },
        undefined,
      ),
    Error,
  );
  assertEquals(error.message.includes("not found"), true, error.message);
});
