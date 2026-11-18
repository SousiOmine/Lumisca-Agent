import { assertEquals } from "@std/assert";
import {
  CODE_EXECUTION_NOTE,
  CODE_EXECUTION_PROVIDER,
  createCodeExecutionProvider,
} from "./code-execution-context.ts";

Deno.test("code execution context: publishes the note once", () => {
  const provider = createCodeExecutionProvider();
  assertEquals(provider.name, CODE_EXECUTION_PROVIDER);
  const published = provider.next();
  assertEquals(published.length, 1);
  assertEquals(published[0]!.body, CODE_EXECUTION_NOTE);
  assertEquals(published[0]!.state, { execution: true });
  assertEquals(provider.next(), []);
});

Deno.test("code execution context: rebase re-anchors to the publication", () => {
  const provider = createCodeExecutionProvider();
  // A conversation reopened while the mode stayed on already carries the
  // note: a second copy would say the same thing twice.
  provider.rebase({ execution: true });
  assertEquals(provider.next(), []);

  // A rewind that removed the note (or a conversation that never had it)
  // publishes it again.
  provider.rebase(undefined);
  assertEquals(provider.next().length, 1);
});

Deno.test("the note says what the program may do and what comes back", () => {
  const note = CODE_EXECUTION_NOTE;
  assertEquals(note.includes("tools.<name>(args)"), true);
  assertEquals(note.includes("tools.tool_search"), true);
  assertEquals(note.includes("return"), true);
});
