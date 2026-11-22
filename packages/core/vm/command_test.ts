import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { runVmCommand } from "./command.ts";

test("runVmCommand: an async iterable reaches the command in order", async () => {
  async function* chunks() {
    yield new TextEncoder().encode("one ");
    yield new TextEncoder().encode("two");
  }
  const result = await runVmCommand(["cat"], {
    timeoutMs: 5_000,
    stdin: chunks(),
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, "one two");
});

test("runVmCommand: a Uint8Array stdin keeps its old shape", async () => {
  const result = await runVmCommand(["cat"], {
    timeoutMs: 5_000,
    stdin: new TextEncoder().encode("hello"),
  });
  assertEquals(result.stdout, "hello");
});
