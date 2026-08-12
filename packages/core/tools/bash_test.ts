import { basename } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { createBashTool } from "./bash.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { decodeOutput, detectOemLabel } from "./decode.ts";

function makeTool() {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-bash-" });
  const sandbox = new Sandbox([root]);
  return { tool: createBashTool({ sandbox }), root, sandbox };
}

function toolText(
  result: { content: { type: "text" | "image"; text?: string }[] },
): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bash tool merges stdout and stderr", async () => {
  const { tool, root } = makeTool();
  try {
    const command = Deno.build.os === "windows"
      ? "echo hello & echo boom 1>&2"
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bash tool resolves cwd by workspace folder name", async () => {
  const { tool, root } = makeTool();
  try {
    const probe = Deno.build.os === "windows" ? "cd" : "pwd";
    const result = await tool.execute(
      "1",
      { cwd: basename(root), command: probe },
      undefined,
    );
    const text = toolText(result);
    assertEquals(text.includes(basename(root)), true, `cwd mismatch: ${text}`);
  } finally {
    await Deno.remove(root, { recursive: true });
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
    await Deno.remove(root, { recursive: true });
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
      // The code page number must be visible (932 on Japanese Windows).
      assert(
        /9\d\d/.test(text) || /8\d\d/.test(text),
        `code page missing: ${text}`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
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
      ? "echo %LUMISCA_TEST_VAR%"
      : "echo $LUMISCA_TEST_VAR";
    const result = await tool.execute(
      "1",
      { cwd: root, command: echo, env: { LUMISCA_TEST_VAR: "hello-env" } },
      undefined,
    );
    assertEquals(toolText(result).includes("hello-env"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
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
      ? "echo %LUMISCA_TEST_VAR%"
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
    await Deno.remove(root, { recursive: true });
  }
});
