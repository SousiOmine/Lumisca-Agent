import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { assert, assertEquals } from "@std/assert";
import { createBashTool } from "./bash.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { decodeOutput, detectOemLabel } from "./decode.ts";
import { formatDuration } from "./duration.ts";
import { defaultSpillDir, MAX_TOOL_OUTPUT } from "./truncate.ts";
import { removeDirRetry, toolText } from "../test-utils.ts";

function makeTool() {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  const sandbox = new Sandbox([root]);
  // Truncated output spills into a per-test directory instead of the shared
  // OS temp dir. It sits inside the workspace here, which is also the case
  // the note's read hint is written for.
  const spillDir = join(root, "spill");
  return {
    tool: createBashTool({ sandbox, spillDir }),
    root,
    sandbox,
    spillDir,
  };
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

Deno.test("decodeOutput is stable against the real cmd.exe output", async () => {
  if (Deno.build.os !== "windows") return;
  const { stdout } = await new Deno.Command("cmd.exe", {
    args: ["/d", "/s", "/c", "chcp"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const oemLabel = await detectOemLabel();
  const text = decodeOutput(stdout, oemLabel);
  assertEquals(text.includes("\uFFFD"), false);
  assert(/\d{3}/.test(text), `code page missing: ${text}`);
});

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

Deno.test("bash tool per-call env overrides the tool-level env", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  const sandbox = new Sandbox([root]);
  const tool = createBashTool({
    sandbox,
    env: { LUMISCA_TEST_VAR: "tool-level" },
  });
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
  const sandbox = new Sandbox([root]);
  const safety = {
    check: () => ({ ok: false, reason: "rm -rf / destroys the host" }),
  } as unknown as Parameters<typeof createBashTool>[0]["safety"];
  const tool = createBashTool({ sandbox, safety });
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
  const sandbox = new Sandbox([root]);
  const safety = {
    check: () => ({ ok: true }),
  } as unknown as Parameters<typeof createBashTool>[0]["safety"];
  const tool = createBashTool({ sandbox, safety });
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
  const tool = createBashTool({
    sandbox: new Sandbox([root]),
    spillDir: join(blocked, "spill"),
  });
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

Deno.test("bash tool points at bash when the spill is outside the workspace", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  // The production shape: the spill dir is the OS temp dir, which the
  // sandboxed read/grep tools cannot reach — bash is the way in, and the
  // note must say so instead of sending the model to a rejected path.
  const spillDir = Deno.makeTempDirSync({ prefix: "lumisca-bash-spill-" });
  const tool = createBashTool({ sandbox: new Sandbox([root]), spillDir });
  try {
    const text = toolText(await runBigCommand(tool, root));
    const path = spillPathFrom(text);
    assertEquals(path.startsWith(spillDir), true, `path: ${path}`);
    assert(
      text.includes("outside the workspace: read it with bash"),
      `bash hint missing: ${text.slice(-200)}`,
    );
    assert((await Deno.readTextFile(path)).includes(BIG_HEAD));
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(spillDir);
  }
});

Deno.test("spill files default to the OS temp dir", () => {
  assertEquals(defaultSpillDir(), join(tmpdir(), "lumisca-tool-output"));
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
