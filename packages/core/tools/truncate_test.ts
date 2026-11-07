import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { HostFileBackend } from "./host/files.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { removeDirRetry } from "../test-utils.ts";
import {
  MAX_SPILL_FILES,
  MAX_TOOL_OUTPUT,
  OutputSpiller,
  spilledNote,
  truncate,
  truncatedHeadNote,
  truncatedNote,
} from "./truncate.ts";

/**
 * The output spiller on its own.
 *
 * It was only covered through the bash tool, where every case had to run a
 * command to produce something worth spilling — and the pruning case ran
 * twenty of them, which on Windows (where each one starts PowerShell) made
 * it the slowest test in the suite by a wide margin (52s) for a property
 * that involves no process at all. The tool's side of the contract (a cut
 * stream points at a readable file) stays in bash_test.ts.
 */

interface Workspace {
  spiller: OutputSpiller;
  dir: string;
  root: string;
  files: HostFileBackend;
}

function workspace(): Workspace {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-spill-" });
  const files = new HostFileBackend(new Sandbox([root]));
  const dir = join(root, ".lumisca-tool-output");
  return { spiller: new OutputSpiller(files, dir), dir, root, files };
}

Deno.test("a spill is written where the session's own tools can read it", async () => {
  const { spiller, dir, root, files } = workspace();
  try {
    const text = `START\n${"filler line\n".repeat(1000)}END\n`;
    const path = await spiller.save("stdout", text);
    assert(path !== undefined, "the spill must be written");
    assertEquals(path.startsWith(dir), true, path);
    assertEquals(path.endsWith("-stdout.txt"), true, path);
    // Read back through the same backend, which is the point: the path in
    // the note is one the file tools resolve.
    assertEquals(await files.readText(path), text);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("older spills are dropped once the bound is reached", async () => {
  const { spiller, dir, root } = workspace();
  try {
    const names: string[] = [];
    for (let i = 0; i < MAX_SPILL_FILES + 4; i++) {
      const path = await spiller.save("stdout", `run ${i}\n`);
      assert(path !== undefined, `spill ${i} was not written`);
      names.push(path.slice(path.lastIndexOf("/") + 1));
    }
    const kept = new Set(Deno.readDirSync(dir).map((entry) => entry.name));
    assertEquals(kept.size, MAX_SPILL_FILES);
    // The newest survive and the oldest are gone: a spill is only useful
    // while it is the most recent output.
    for (const name of names.slice(-MAX_SPILL_FILES)) {
      assertEquals(kept.has(name), true, `kept: ${name}`);
    }
    for (const name of names.slice(0, 4)) {
      assertEquals(kept.has(name), false, `dropped: ${name}`);
    }
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("clear deletes every spill this instance wrote", async () => {
  const mine = workspace();
  const theirs = workspace();
  try {
    await mine.spiller.save("stdout", "one\n");
    await mine.spiller.save("stderr", "two\n");
    // Another session's spiller shares nothing but the directory name: it
    // must not lose its files to this one's cleanup.
    const theirPath = await theirs.spiller.save("stdout", "theirs\n");
    assert(theirPath !== undefined);

    await mine.spiller.clear();
    assertEquals([...Deno.readDirSync(mine.dir)].length, 0);
    assertEquals(await theirs.files.readText(theirPath), "theirs\n");
  } finally {
    await removeDirRetry(mine.root);
    await removeDirRetry(theirs.root);
  }
});

Deno.test("an existing file at the target name is not overwritten", async () => {
  const { spiller, dir, root, files } = workspace();
  try {
    const first = await spiller.save("stdout", "first\n");
    assert(first !== undefined);
    // The next name this spiller will pick: same tag, sequence 2. A file
    // already there — a leftover from a killed process that drew the same
    // tag — is a collision, and the caller gets the plain note instead of
    // another session's spill being clobbered.
    const tag = first.slice(first.lastIndexOf("/") + 1).split("-")[0]!;
    const next = join(dir, `${tag}-2-stdout.txt`);
    await Deno.writeTextFile(next, "someone else\n");
    assertEquals(await spiller.save("stdout", "second\n"), undefined);
    assertEquals(await files.readText(next), "someone else\n");
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("an unwritable spill directory is undefined, not an exception", async () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-spill-" });
  try {
    const blocked = join(root, "blocked.txt");
    await Deno.writeTextFile(blocked, "x");
    const files = new HostFileBackend(new Sandbox([root]));
    const spiller = new OutputSpiller(files, join(blocked, "spill"));
    // The tool's result must survive a failed spill, so the failure is a
    // return value.
    assertEquals(await spiller.save("stdout", "text\n"), undefined);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("truncate keeps the tail and truncateHead the head", () => {
  assertEquals(truncate("abcdef", 10), { text: "abcdef", truncated: false });
  assertEquals(truncate("abcdef", 3), { text: "def", truncated: true });
  assertEquals(
    truncatedNote("stderr", 16),
    "\n[stderr truncated to the last 16 bytes]",
  );
  assertEquals(
    truncatedHeadNote("description", 16),
    "\n[description truncated to the first 16 bytes]",
  );
  assertEquals(
    spilledNote("stdout", "/tmp/x.txt", "read it"),
    `\n[stdout truncated to the last ${MAX_TOOL_OUTPUT} bytes; full output: /tmp/x.txt — read it]`,
  );
});
