import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { createBashTool } from "./bash.ts";
import { HostCommandRunner } from "./host/command-runner.ts";
import { HostFileBackend } from "./host/files.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { formatDuration } from "./duration.ts";
import { MAX_SPILL_FILES, MAX_TOOL_OUTPUT } from "./truncate.ts";
import { removeDirRetry, toolText } from "../test-utils.ts";

/** The host tool over a fresh temp workspace. */
function hostTool(
  root: string,
  options: { env?: Record<string, string>; spillDir?: string } = {},
) {
  return createBashTool({
    files: new HostFileBackend(new Sandbox([root])),
    runner: new HostCommandRunner(),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.spillDir !== undefined ? { spillDir: options.spillDir } : {}),
  });
}

function makeTool() {
  // The sandbox resolves its roots through symlinks, so on macOS a temp dir
  // under /var comes back as /private/var. Comparing the spill path (which
  // goes through the backend) against the unresolved name would fail for
  // that reason alone, not because the spill went somewhere else.
  const root = realpathSync(Deno.makeTempDirSync({ prefix: "lumisca-bash-" }));
  // The spill follows the file backend (a per-test workspace), so a run
  // never shares the real directory with another one.
  return {
    tool: hostTool(root),
    root,
    spillDir: join(root, ".lumisca-tool-output"),
  };
}

/** The bound these tests give a call they expect to return. What they guard
 * against is a call that never returns, so the bound only has to sit well
 * under the tool's 120s default timeout. Windows gets a looser one: its
 * kill walks the process tree with PowerShell + WMI (taskkill needs the
 * pids), which a loaded CI runner stretches to several seconds. */
const CALL_BOUND_MS = Deno.build.os === "windows" ? 30_000 : 10_000;

/** Await a tool call with a bound: the regressions this file guards against
 * were calls that never returned, so a hang must fail the test instead of
 * running forever. */
async function bounded<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = CALL_BOUND_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} did not return within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("bash tool reports exit code", async () => {
  const { tool, root } = makeTool();
  try {
    const result = await tool.execute(
      "1",
      { cwd: root, command: "exit 3" },
      undefined,
    );
    assertEquals(result.details?.exitCode, 3);
    assertEquals(toolText(result).includes("[exit code: 3]"), true);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool reports how long the command took", async () => {
  const { tool, root } = makeTool();
  try {
    // A command that sleeps ~300ms: the measurement has to cover the wait,
    // not only the process creation.
    const command = Deno.build.os === "windows"
      ? "Start-Sleep -Milliseconds 300"
      : "sleep 0.3";
    const result = await tool.execute(
      "1",
      { cwd: root, command },
      undefined,
    );
    const text = toolText(result);
    const durationMs = result.details?.durationMs;
    assert(typeof durationMs === "number", `durationMs: ${durationMs}`);
    assert(durationMs >= 300, `durationMs: ${durationMs}`);
    assertEquals(text.includes("[exit code: 0]"), true);
    assertEquals(
      text.endsWith(`[duration: ${formatDuration(durationMs)}]`),
      true,
      `output: ${text}`,
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool merges stdout and stderr", async () => {
  const { tool, root } = makeTool();
  try {
    const command = Deno.build.os === "windows"
      ? "echo hello; [Console]::Error.WriteLine('boom')"
      : "echo hello; echo boom 1>&2";
    const result = await tool.execute(
      "1",
      { cwd: root, command },
      undefined,
    );
    const text = toolText(result);
    assertEquals(text.includes("hello"), true);
    assertEquals(text.includes("boom"), true);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool resolves cwd by workspace folder name", async () => {
  const { tool, root } = makeTool();
  try {
    // `pwd` prints the working directory on POSIX and in PowerShell (alias
    // for Get-Location); cmd's `cd` prints nothing when output is piped.
    const result = await tool.execute(
      "1",
      { cwd: basename(root), command: "pwd" },
      undefined,
    );
    const text = toolText(result);
    assertEquals(text.includes(basename(root)), true, `cwd mismatch: ${text}`);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool rejects an unknown cwd", async () => {
  const { tool, root } = makeTool();
  try {
    let message = "";
    try {
      await tool.execute(
        "1",
        { cwd: "nope", command: "echo x" },
        undefined,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("Unknown workspace folder"), `message: ${message}`);
  } finally {
    await removeDirRetry(root);
  }
});

// Regression test for Windows mojibake: cmd.exe internal commands emit the
// OEM code page (Shift_JIS on Japanese Windows), which must be decoded
// correctly instead of producing U+FFFD replacement characters.
Deno.test({
  name: "bash tool decodes cmd.exe output without mojibake (Windows)",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const { tool, root } = makeTool();
    try {
      const result = await tool.execute(
        "1",
        { cwd: root, command: "chcp" },
        undefined,
      );
      const text = toolText(result);
      assert(
        !text.includes("\uFFFD"),
        `output contains mojibake: ${text}`,
      );
      // The code page number must be visible — `chcp` prints a localized
      // label ("Active code page: 932" / "現在のコード ページ: 932"), so
      // only the number itself is asserted, never the label text. Real code
      // pages are 3 to 5 digits (932 = Shift_JIS, 65001 = UTF-8), and CI
      // runs Windows with the UTF-8 page, so 3 digits alone is too narrow.
      assert(
        /(^|\D)\d{3,5}(\D|$)/.test(text),
        `code page missing: ${text}`,
      );
    } finally {
      await removeDirRetry(root);
    }
  },
});

// Regression test for Windows quote mangling: cmd.exe /s /c turned a
// `"quoted path"` argument into a token with literal quote characters, so
// the child program could not find the file. PowerShell delivers quoted
// args intact, so Test-Path must see the clean path.
Deno.test({
  name: "bash tool passes quoted path arguments intact (Windows)",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const { tool, root } = makeTool();
    try {
      const file = `${root}\\my file.txt`;
      await Deno.writeTextFile(file, "x");
      const result = await tool.execute(
        "1",
        { cwd: root, command: `Test-Path "${file}"` },
        undefined,
      );
      const text = toolText(result);
      assertEquals(text.includes("True"), true, `output: ${text}`);
      assertEquals(text.includes("False"), false, `output: ${text}`);
    } finally {
      await removeDirRetry(root);
    }
  },
});

// `decodeOutput`'s own suite (decode_test.ts) pins the OEM fallback and the
// replacement-character path; the Windows tests above run the real shell
// through it. A third copy that returns early on every other platform only
// meant the test existed but never ran.

Deno.test("bash tool passes env vars to the command", async () => {
  const { tool, root } = makeTool();
  try {
    const echo = Deno.build.os === "windows"
      ? "echo $env:LUMISCA_TEST_VAR"
      : "echo $LUMISCA_TEST_VAR";
    const result = await tool.execute(
      "1",
      { cwd: root, command: echo, env: { LUMISCA_TEST_VAR: "hello-env" } },
      undefined,
    );
    assertEquals(toolText(result).includes("hello-env"), true);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool passes the tool-level env to the command", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  const tool = hostTool(root, { env: { LUMISCA_TEST_VAR: "tool-level" } });
  try {
    const echo = Deno.build.os === "windows"
      ? "echo $env:LUMISCA_TEST_VAR"
      : "echo $LUMISCA_TEST_VAR";
    const result = await tool.execute("1", { cwd: root, command: echo });
    assertEquals(toolText(result).includes("tool-level"), true);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool per-call env overrides the tool-level env", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  const tool = hostTool(root, { env: { LUMISCA_TEST_VAR: "tool-level" } });
  try {
    const echo = Deno.build.os === "windows"
      ? "echo $env:LUMISCA_TEST_VAR"
      : "echo $LUMISCA_TEST_VAR";
    const result = await tool.execute(
      "1",
      { cwd: root, command: echo, env: { LUMISCA_TEST_VAR: "call-level" } },
      undefined,
    );
    const text = toolText(result);
    assertEquals(text.includes("call-level"), true);
    assertEquals(text.includes("tool-level"), false);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool returns the safety reason when the check blocks", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  const safety = {
    check: () => ({ ok: false, reason: "rm -rf / destroys the host" }),
  } as unknown as Parameters<typeof createBashTool>[0]["safety"];
  const tool = createBashTool({
    files: new HostFileBackend(new Sandbox([root])),
    runner: new HostCommandRunner(),
    safety,
  });
  try {
    const result = await tool.execute(
      "1",
      { cwd: root, command: "rm -rf /" },
      undefined,
    );
    const text = toolText(result);
    assertEquals(result.details?.blocked, true);
    assertEquals(result.details?.reason, "rm -rf / destroys the host");
    assertEquals(text.includes("[blocked by safety check]"), true);
    assertEquals(text.includes("rm -rf / destroys the host"), true);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool runs normally when the check approves", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  const safety = {
    check: () => ({ ok: true }),
  } as unknown as Parameters<typeof createBashTool>[0]["safety"];
  const tool = createBashTool({
    files: new HostFileBackend(new Sandbox([root])),
    runner: new HostCommandRunner(),
    safety,
  });
  try {
    const result = await tool.execute(
      "1",
      { cwd: root, command: "echo approved" },
      undefined,
    );
    assertEquals(result.details?.blocked, undefined);
    assertEquals(toolText(result).includes("approved"), true);
  } finally {
    await removeDirRetry(root);
  }
});

// --- spilled output (DSH-style "spill") ------------------------------------
//
// A stream longer than MAX_TOOL_OUTPUT keeps its last 64KiB inline and the
// complete text is saved to a file under the spill directory, so the model
// can read what was cut instead of re-running the command.

const BIG_HEAD = "START-OF-OUTPUT";
const BIG_TAIL = "END-OF-OUTPUT";

/** ~240 KiB with a marker at each end: far past MAX_TOOL_OUTPUT, so only the
 * tail reaches the model and the head survives in the spill alone. */
function bigOutput(): string {
  return `${BIG_HEAD}\n${"filler line\n".repeat(20_000)}${BIG_TAIL}\n`;
}

/** The spill path of a truncation note (`…; full output: <path> — <how>]`). */
function spillPathFrom(text: string): string {
  const match = text.match(/full output: (.+?) — /);
  assert(match !== null, `no spill path in: ${text.slice(-200)}`);
  return match[1]!;
}

/** Run a command whose output is far larger than the inline cap. `cat` is a
 * Get-Content alias in PowerShell and a real binary on POSIX, so one command
 * covers both shells; the file itself is written by the test. */
async function runBigCommand(
  tool: ReturnType<typeof createBashTool>,
  root: string,
  command = "cat big.txt",
) {
  await Deno.writeTextFile(join(root, "big.txt"), bigOutput());
  return await tool.execute("1", { cwd: root, command }, undefined);
}

Deno.test("bash tool spills the complete stdout when it is truncated", async () => {
  const { tool, root, spillDir } = makeTool();
  try {
    const text = toolText(await runBigCommand(tool, root));
    // The standard wording stays, followed by the spill path on the same
    // line; the inline result keeps the tail and has lost the head.
    assert(
      text.includes("[stdout truncated to the last 65536 bytes;"),
      `note missing: ${text.slice(-200)}`,
    );
    assert(text.includes(BIG_TAIL), `tail missing: ${text.slice(-200)}`);
    assertEquals(text.includes(BIG_HEAD), false);

    const path = spillPathFrom(text);
    assertEquals(path.startsWith(spillDir), true, `path: ${path}`);
    assertEquals(path.endsWith("-stdout.txt"), true, `path: ${path}`);
    // The spill holds the FULL output: both ends, well past the inline cap.
    const spilled = await Deno.readTextFile(path);
    assert(spilled.includes(BIG_HEAD), `head missing in spill: ${path}`);
    assert(spilled.includes(BIG_TAIL), `tail missing in spill: ${path}`);
    assert(
      spilled.length > MAX_TOOL_OUTPUT,
      `spill too small: ${spilled.length}`,
    );
    // Spilled inside the workspace: the sandboxed read/grep tools reach it.
    assert(
      text.includes("use read with offset/limit, or grep this path"),
      `read hint missing: ${text.slice(-200)}`,
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool spills the complete stderr when it is truncated", async () => {
  const { tool, root } = makeTool();
  try {
    const command = Deno.build.os === "windows"
      ? "[Console]::Error.WriteLine((Get-Content big.txt -Raw))"
      : "cat big.txt 1>&2";
    const text = toolText(await runBigCommand(tool, root, command));
    assert(
      text.includes("[stderr truncated to the last 65536 bytes;"),
      `note missing: ${text.slice(-200)}`,
    );
    assertEquals(text.includes(BIG_HEAD), false);
    const path = spillPathFrom(text);
    assertEquals(path.endsWith("-stderr.txt"), true, `path: ${path}`);
    assert((await Deno.readTextFile(path)).includes(BIG_HEAD));
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool spills nothing when the output fits", async () => {
  const { tool, root, spillDir } = makeTool();
  try {
    const result = await tool.execute(
      "1",
      { cwd: root, command: "echo small" },
      undefined,
    );
    const text = toolText(result);
    assertEquals(text.includes("full output:"), false);
    assertEquals(text.includes("truncated"), false);
    // The directory is created lazily: a run that cut nothing leaves none.
    const created = await Deno.stat(spillDir).then(() => true, () => false);
    assertEquals(created, false, `spill directory was created: ${spillDir}`);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool keeps the result when the spill fails", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  // A regular file where the spill directory would go: the mkdir fails, so
  // the note must lose only the path — never the result itself.
  const blocked = join(root, "blocked.txt");
  await Deno.writeTextFile(blocked, "x");
  const tool = hostTool(root, { spillDir: join(blocked, "spill") });
  try {
    const text = toolText(await runBigCommand(tool, root));
    assert(
      text.includes("[stdout truncated to the last 65536 bytes]"),
      `plain note missing: ${text.slice(-200)}`,
    );
    assertEquals(text.includes("full output:"), false);
    assert(text.includes("[exit code: 0]"), `result lost: ${text.slice(-200)}`);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool keeps the plain note when the spill cannot be written", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  // A spill path under a regular file cannot be created at all; the result
  // must still arrive, with the plain note instead of a dead path.
  const blocked = Deno.makeTempDirSync({ prefix: "lumisca-bash-blocked-" });
  const file = join(blocked, "not-a-directory");
  await Deno.writeTextFile(file, "x");
  const tool = hostTool(root, { spillDir: join(file, "spill") });
  try {
    const text = toolText(await runBigCommand(tool, root));
    assert(
      text.includes("[stdout truncated to the last 65536 bytes]"),
      `plain note missing: ${text.slice(-200)}`,
    );
    assertEquals(text.includes("full output:"), false);
    assert(text.includes("[exit code: 0]"), `result lost: ${text.slice(-200)}`);
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(blocked);
  }
});

Deno.test("the spill is readable through the same file backend", async () => {
  const { tool, root } = makeTool();
  const files = new HostFileBackend(new Sandbox([root]));
  try {
    const text = toolText(await runBigCommand(tool, root));
    const path = spillPathFrom(text);
    // The point of the default location: the tool that ran the command and
    // the tools that read files agree on where the output went. A stella
    // session spills inside its machine for the same reason.
    const resolved = await files.resolve(path);
    assertEquals(resolved.ok, true, `unresolvable spill: ${path}`);
    assert((await files.readText(path)).includes(BIG_HEAD), `spill: ${path}`);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool description documents the spilled full output", async () => {
  const { tool, root } = makeTool();
  try {
    assert(tool.description.includes("full output: <path>"));
    assert(tool.description.includes("truncated to the last 65536 bytes;"));
  } finally {
    await removeDirRetry(root);
  }
});

// Regression test for the call that froze a session: a command that
// backgrounds a process inheriting the output pipes made the tool wait for
// an EOF that never comes. The call must end with the command's own exit,
// report the output it read, and say that a process still holds the streams.
Deno.test({
  name: "bash tool returns when a descendant holds the output streams",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { tool, root } = makeTool();
    try {
      const result = await bounded(
        tool.execute(
          "1",
          { cwd: root, command: "sleep 30 & echo pid=$!" },
          undefined,
        ),
        "a command whose descendant holds the pipes",
      );
      const text = toolText(result);
      assert(text.includes("pid="), `output: ${text}`);
      assert(
        text.includes(
          "[command left a process holding its output streams; later output is not reported]",
        ),
        `output: ${text}`,
      );
      assertEquals(text.includes("[exit code: 0]"), true, `output: ${text}`);
      // The call answers for the command only; the test must not leave the
      // process it reported behind either.
      const pid = Number(text.match(/pid=(\d+)/)?.[1]);
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    } finally {
      await removeDirRetry(root);
    }
  },
});

Deno.test("bash tool kills a command that outlives its timeout", async () => {
  const { tool, root } = makeTool();
  try {
    const command = Deno.build.os === "windows"
      ? "Write-Output before; Start-Sleep 30"
      : "echo before; sleep 30";
    const result = await bounded(
      tool.execute("1", { cwd: root, command, timeout: 1 }, undefined),
      "a command that outlives its timeout",
    );
    const text = toolText(result);
    assert(text.includes("before"), `output: ${text}`);
    const durationMs = result.details?.durationMs;
    assert(
      typeof durationMs === "number" && durationMs < CALL_BOUND_MS,
      `the timeout did not end the call: durationMs ${durationMs}`,
    );
    // The kill's exit code: a signal death on POSIX; Windows reports
    // whatever taskkill leaves and is not pinned here.
    if (Deno.build.os !== "windows") {
      assertEquals(result.details?.exitCode, 137, `output: ${text}`);
    }
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool returns when the run is aborted", async () => {
  const { tool, root } = makeTool();
  try {
    const command = Deno.build.os === "windows" ? "Start-Sleep 30" : "sleep 30";
    const controller = new AbortController();
    const call = tool.execute("1", { cwd: root, command }, controller.signal);
    setTimeout(() => controller.abort(), 300);
    const result = await bounded(call, "a command whose run was aborted");
    const durationMs = result.details?.durationMs;
    // The 120s default timeout never came: the abort ended the call.
    assert(
      typeof durationMs === "number" && durationMs < CALL_BOUND_MS,
      `the abort did not end the call: durationMs ${durationMs}`,
    );
    if (Deno.build.os !== "windows") {
      assertEquals(result.details?.exitCode, 137);
    }
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bash tool keeps only the newest spills and drops them on close", async () => {
  const { tool, root, spillDir } = makeTool();
  try {
    // Each run writes far more than the tool's cap, so every one spills.
    for (let i = 0; i < MAX_SPILL_FILES + 4; i++) {
      await runBigCommand(tool, root);
    }
    const kept = [...Deno.readDirSync(spillDir)];
    assertEquals(
      kept.length <= MAX_SPILL_FILES,
      true,
      `spills not pruned: ${kept.length}`,
    );
    // The tools are closed with the agent: nothing can reference the spills
    // any more, so they go. Removal is asynchronous (it goes through the
    // file backend, which may be a container), so poll rather than assume.
    tool.dispose?.();
    let remaining: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      remaining = [...Deno.readDirSync(spillDir)];
      if (remaining.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(remaining, [], "dispose must delete the session's spills");
  } finally {
    await removeDirRetry(root);
  }
});
