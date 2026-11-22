import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertRejects } from "@std/assert";
import { CoreError } from "../errors.ts";
import type { VmExec, VmExecBytes } from "./container.ts";
import {
  isUploadRef,
  MAX_PROMPT_IMAGE_BYTES,
  readUpload,
  savePromptFiles,
  savePromptImages,
} from "./uploads.ts";

/** A machine that records what it was asked and answers from a map of
 * absolute paths. Only the two calls uploads.ts makes are modelled: writing
 * a file with `cat > path` on stdin, and `test -f`. */
function fakeMachine(files = new Map<string, Uint8Array>()) {
  const exec: VmExec = async (command, options) => {
    if (command[0] === "mkdir") return ok();
    if (command[0] === "mv") {
      const from = String(command[2]);
      const to = String(command[3]);
      const bytes = files.get(from);
      if (bytes === undefined) return { ...ok(), exitCode: 1 };
      files.set(to, bytes);
      files.delete(from);
      return ok();
    }
    if (command[0] === "df") {
      return {
        ...ok(),
        stdout:
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
          "overlay 100 1 99999999 1% /\n",
      };
    }
    if (command[0] === "sh" && command[2] === 'cat > "$1"') {
      const path = String(command[4]);
      const stdin = options.stdin;
      let bytes: Uint8Array;
      if (stdin === undefined) {
        bytes = new Uint8Array();
      } else if (stdin instanceof Uint8Array) {
        bytes = stdin;
      } else {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stdin) chunks.push(chunk);
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      }
      files.set(path, bytes);
      return ok();
    }
    if (command[0] === "sh" && command[2] === 'test -f "$1"') {
      const path = String(command[4]);
      return Promise.resolve(files.has(path) ? ok() : { ...ok(), exitCode: 1 });
    }
    if (command[0] === "sh" && command[2] === 'test "$(wc -c < "$1")" = "$2"') {
      const path = String(command[4]);
      const expected = Number(command[5]);
      return Promise.resolve(
        files.get(path)?.length === expected ? ok() : { ...ok(), exitCode: 1 },
      );
    }
    throw new Error(`unexpected command: ${command.join(" ")}`);
  };
  const execBytes: VmExecBytes = (command, options) => {
    if (command[0] === "cat") {
      const path = command[2] ?? "";
      const bytes = files.get(path);
      if (bytes === undefined) {
        return Promise.resolve({ ...okBytes(), exitCode: 1 });
      }
      if (bytes.length > (options.maxOutput ?? Number.POSITIVE_INFINITY)) {
        return Promise.resolve({
          ...okBytes(bytes.slice(0, options.maxOutput)),
          truncated: true,
        });
      }
      return Promise.resolve(okBytes(bytes));
    }
    throw new Error(`unexpected command: ${command.join(" ")}`);
  };
  return { exec, execBytes, files };
}

function ok() {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
  };
}

/** The same shape with byte output (the byte seam keeps `stderr` as text). */
function okBytes(stdout: Uint8Array = new Uint8Array()): {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
} {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
  };
}

test("uploads: a file is written under the agent's folder and usable as a ref", async () => {
  const machine = fakeMachine();
  const saved = await savePromptImages(
    [
      {
        name: "shot.png",
        bytes: new Uint8Array([1]),
      },
    ],
    {
      exec: machine.exec,
      agentId: "a1",
      now: () => 1000,
      randomId: () => "abcd1234",
    },
  );
  assertEquals(saved.length, 1);
  assertEquals(saved[0]!.ref, "uploads/1000-abcd1234/01-shot.png");
  assertEquals(
    saved[0]!.path,
    "/home/agent/agents/a1/uploads/1000-abcd1234/01-shot.png",
  );
  assertEquals(saved[0]!.image, true);
  assertEquals(machine.files.has(saved[0]!.path), true);
});

test("uploads: a document is not marked as a picture", async () => {
  const machine = fakeMachine();
  const saved = await savePromptImages(
    [
      {
        name: "notes.txt",
        bytes: new Uint8Array([1]),
      },
    ],
    {
      exec: machine.exec,
      agentId: "a1",
      now: () => 1,
      randomId: () => "aaaaaaaa",
    },
  );
  assertEquals(saved[0]!.image, false);
});

test("uploads: only names this module generates are refs", () => {
  assertEquals(isUploadRef("uploads/1000-abcd1234/01-shot.png"), true);
  // Escapes are refused before an answer becomes a path.
  assertEquals(isUploadRef("uploads/../../etc/passwd"), false);
  assertEquals(isUploadRef("../secrets.png"), false);
  assertEquals(isUploadRef("/etc/passwd"), false);
  assertEquals(isUploadRef("uploads/1000-abcd1234/01-a/b.png"), false);
});

test("uploads: a file that exists is read back as bytes", async () => {
  const machine = fakeMachine();
  const saved = await savePromptImages(
    [
      {
        name: "p.png",
        bytes: new Uint8Array([7, 8]),
      },
    ],
    {
      exec: machine.exec,
      agentId: "a1",
      now: () => 1,
      randomId: () => "aaaaaaaa",
    },
  );
  const read = await readUpload(machine.exec, machine.execBytes, {
    agentId: "a1",
    ref: saved[0]!.ref,
    maxBytes: MAX_PROMPT_IMAGE_BYTES,
  });
  assertEquals(read?.bytes, new Uint8Array([7, 8]));
  assertEquals(read?.name, "01-p.png");
});

test("uploads: a file the machine no longer has answers undefined", async () => {
  const machine = fakeMachine();
  // The agent deleted it: that is an answer, not an error (see the route).
  assertEquals(
    await readUpload(machine.exec, machine.execBytes, {
      agentId: "a1",
      ref: "uploads/1-aaaaaaaa/01-gone.png",
      maxBytes: MAX_PROMPT_IMAGE_BYTES,
    }),
    undefined,
  );
});

test("uploads: a malformed ref never reaches the machine", async () => {
  const machine = fakeMachine();
  let touched = false;
  const exec: VmExec = (command, options) => {
    touched = true;
    return machine.exec(command, options);
  };
  assertEquals(
    await readUpload(exec, machine.execBytes, {
      agentId: "a1",
      ref: "../../etc/passwd",
      maxBytes: MAX_PROMPT_IMAGE_BYTES,
    }),
    undefined,
  );
  assertEquals(touched, false);
});

test("uploads: a prompt file is copied from the host by its size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumisca-prompt-file-"));
  const host = join(dir, "run.log");
  await writeFile(host, "hello from the host");
  const machine = fakeMachine();
  try {
    const saved = await savePromptFiles(
      [{ name: "run.log", path: host, size: 19 }],
      {
        exec: machine.exec,
        agentId: "a1",
        now: () => 1,
        randomId: () => "aaaaaaaa",
      },
    );
    assertEquals(saved[0]!.ref, "uploads/1-aaaaaaaa/01-run.log");
    assertEquals(
      new TextDecoder().decode(machine.files.get(saved[0]!.path)),
      "hello from the host",
    );
    assertEquals(
      [...machine.files.keys()].some((path) =>
        path.includes(".lumisca-upload-staging"),
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uploads: a host file that changed after the upload started is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumisca-prompt-file-"));
  const host = join(dir, "run.log");
  await writeFile(host, "short");
  const machine = fakeMachine();
  try {
    await assertRejects(
      () =>
        savePromptFiles([{ name: "run.log", path: host, size: 99 }], {
          exec: machine.exec,
          agentId: "a1",
        }),
      CoreError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uploads: a file over the limit is an error, not 'gone'", async () => {
  const machine = fakeMachine();
  const saved = await savePromptImages(
    [
      {
        name: "big.png",
        bytes: new Uint8Array(64),
      },
    ],
    {
      exec: machine.exec,
      agentId: "a1",
      now: () => 1,
      randomId: () => "aaaaaaaa",
    },
  );
  await assertRejects(
    () =>
      readUpload(machine.exec, machine.execBytes, {
        agentId: "a1",
        ref: saved[0]!.ref,
        maxBytes: 8,
      }),
    CoreError,
  );
});
