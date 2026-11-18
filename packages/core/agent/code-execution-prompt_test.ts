import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { codeExecutionPrompt } from "./code-execution-prompt.ts";

const SDK =
  "declare const tools: {\n  read(args: { path: string }): Promise<string>;\n};";

test("scripting tool call prompt: carries the declarations verbatim", () => {
  const prompt = codeExecutionPrompt(SDK);
  assertEquals(prompt.includes(SDK), true, prompt);
  assertEquals(prompt.includes("## Scripting tool call"), true, prompt);
  assertEquals(prompt.includes("ONE tool, `execute`"), true, prompt);
  assertEquals(prompt.includes("tools.<name>(args)"), true, prompt);
  assertEquals(prompt.includes("tools.tool_search({ query })"), true, prompt);
});

test("scripting tool call prompt: says what survives and what commits", () => {
  const prompt = codeExecutionPrompt(SDK);
  assertEquals(prompt.includes("store(key, value)"), true, prompt);
  assertEquals(prompt.includes("load(key)"), true, prompt);
  assertEquals(
    prompt.includes("kept only when the program succeeds"),
    true,
    prompt,
  );
  assertEquals(prompt.includes("256 KiB"), true, prompt);
  assertEquals(prompt.includes("1 MiB"), true, prompt);
});
