/**
 * Files the user attaches to a prompt, written into the machine.
 *
 * The property that matters: the agent is told a path it can open, and the
 * bytes that arrive there are the bytes the user sent (an upload that
 * silently differs is worse than one that fails).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { CoreError } from "../errors.ts";
import type { VmExec } from "./container.ts";
import { saveUploads, VM_UPLOADS_DIR } from "./uploads.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/mod.ts";

/** A fake machine that keeps the files it was told to write. */
function machine(): {
  exec: VmExec;
  writes: { path: string; bytes: Uint8Array }[];
  commands: string[][];
} {
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const commands: string[][] = [];
  const exec: VmExec = (command: readonly string[], options) => {
    commands.push([...command]);
    if (command[0] === "mkdir") {
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    }
    // `sh -c 'cat > "$1"' sh <path>`, fed the bytes on stdin: the path is
    // the last argument (the `$0` slot is "sh").
    writes.push({
      path: command[command.length - 1]!,
      bytes: options.stdin ?? new Uint8Array(),
    });
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  };
  return { exec, writes, commands };
}

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("uploads: the files land in the agent's own folder", async () => {
  const { exec, writes } = machine();
  const saved = await saveUploads(
    [
      { name: "run.log", bytes: bytes("hello") },
      { name: "notes.txt", bytes: bytes("two") },
    ],
    { exec, agentId: "a1", now: () => 1000, randomId: () => "abcd1234" },
  );
  assertEquals(saved.map((file) => file.name), ["run.log", "notes.txt"]);
  const folder = `/home/agent/agents/a1/${VM_UPLOADS_DIR}/1000-abcd1234`;
  assertEquals(saved.map((file) => file.path), [
    `${folder}/01-run.log`,
    `${folder}/02-notes.txt`,
  ]);
  assertEquals(saved.map((file) => file.size), [5, 3]);
  // The bytes arrive as they were sent: the path is useless if the file at
  // the end of it is not the one the user attached.
  assertEquals(new TextDecoder().decode(writes[0]!.bytes), "hello");
  assertEquals(writes.map((write) => write.path), saved.map((f) => f.path));
});

Deno.test("uploads: a name cannot address another directory", async () => {
  const { exec, writes } = machine();
  const saved = await saveUploads(
    [{ name: "../../etc/passwd", bytes: bytes("x") }],
    { exec, agentId: "a1", now: () => 1, randomId: () => "r" },
  );
  assertEquals(saved[0]!.name, "passwd");
  assert(
    saved[0]!.path.startsWith(`/home/agent/agents/a1/${VM_UPLOADS_DIR}/`),
    saved[0]!.path,
  );
  assertEquals(writes.length, 1);
});

Deno.test("uploads: an oversized file is refused before it is written", async () => {
  const { exec, writes } = machine();
  const failure = await saveUploads(
    [{ name: "big.bin", bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) }],
    { exec, agentId: "a1" },
  ).catch((error) => error);
  assert(failure instanceof CoreError, String(failure));
  assertEquals(writes.length, 0);
});

Deno.test("uploads: a machine that cannot write says so", async () => {
  const exec: VmExec = (command: readonly string[]) => {
    if (command[0] === "mkdir") {
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    }
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "no space left on device\n",
      truncated: false,
      timedOut: false,
    });
  };
  await assertRejects(
    () =>
      saveUploads([{ name: "a.txt", bytes: bytes("x") }], {
        exec,
        agentId: "a1",
      }),
    CoreError,
    "no space left on device",
  );
});
