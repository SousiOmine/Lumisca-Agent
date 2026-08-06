import { assert, assertEquals } from "@std/assert";
import { createBashTool } from "./bash.ts";
import { decodeOutput, detectOemLabel } from "./decode.ts";

function makeTool() {
  return createBashTool({ cwd: Deno.cwd() });
}

function toolText(
  result: { content: { type: "text" | "image"; text?: string }[] },
): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

Deno.test("bash tool reports exit code", async () => {
  const tool = makeTool();
  const result = await tool.execute("1", { command: "exit 3" }, undefined);
  assertEquals(result.details?.exitCode, 3);
  assertEquals(toolText(result).includes("[exit code: 3]"), true);
});

Deno.test("bash tool merges stdout and stderr", async () => {
  const tool = makeTool();
  const command = Deno.build.os === "windows"
    ? "echo hello & echo boom 1>&2"
    : "echo hello; echo boom 1>&2";
  const result = await tool.execute("1", { command }, undefined);
  const text = toolText(result);
  assertEquals(text.includes("hello"), true);
  assertEquals(text.includes("boom"), true);
});

// Regression test for Windows mojibake: cmd.exe internal commands emit the
// OEM code page (Shift_JIS on Japanese Windows), which must be decoded
// correctly instead of producing U+FFFD replacement characters.
Deno.test({
  name: "bash tool decodes cmd.exe output without mojibake (Windows)",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const tool = makeTool();
    const result = await tool.execute("1", { command: "chcp" }, undefined);
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
