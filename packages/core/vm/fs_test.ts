import { assert, assertEquals } from "@std/assert";
import { grepCommand, shellQuote, VmFileBackend, walkCommand } from "./fs.ts";
import { VM_WORKDIR } from "./contract.ts";
import type { VmExec, VmExecOptions } from "./container.ts";
import type { VmCommandResult } from "./command.ts";

/**
 * The VM backends are tested against a scripted exec seam: each test states
 * what `podman exec` answers and asserts what crossed the boundary. That is
 * the only way to cover the paths that matter (path confinement, the shell
 * command shapes, base64 round trips) without a container.
 */

interface Scripted {
  run(
    command: readonly string[],
    options: VmExecOptions,
  ): Promise<VmCommandResult>;
  /** Every command issued, in order (flattened for easy assertions). */
  calls: string[][];
}

function script(
  answers: Array<{
    match: RegExp;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    truncated?: boolean;
  }>,
): Scripted {
  const calls: string[][] = [];
  return {
    calls,
    run: (command) => {
      const argv = [...command];
      calls.push(argv);
      const joined = argv.join(" ");
      const answer = answers.find((entry) => entry.match.test(joined));
      return Promise.resolve({
        exitCode: answer?.exitCode ?? 0,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? "",
        truncated: answer?.truncated ?? false,
        timedOut: false,
      });
    },
  };
}

function backend(run: VmExec): VmFileBackend {
  return new VmFileBackend(run);
}

// --- path resolution -------------------------------------------------------

Deno.test("vm fs: resolve confines every path to the machine's home", async () => {
  const { run } = script([]);
  const files = backend(run);

  const relative = await files.resolve("notes.txt");
  assertEquals(relative, { ok: true, path: `${VM_WORKDIR}/notes.txt` });

  const home = await files.resolve("~");
  assertEquals(home, { ok: true, path: VM_WORKDIR });

  const nested = await files.resolve("~/src/a.ts");
  assertEquals(nested, { ok: true, path: `${VM_WORKDIR}/src/a.ts` });

  const absolute = await files.resolve(`${VM_WORKDIR}/a/b`);
  assertEquals(absolute, { ok: true, path: `${VM_WORKDIR}/a/b` });

  // Escapes are normalized away and then refused.
  const escape = await files.resolve("../../etc/passwd");
  assertEquals(escape.ok, false);
  const absoluteEscape = await files.resolve("/etc/passwd");
  assertEquals(absoluteEscape.ok, false);
  if (!absoluteEscape.ok) {
    assert(
      absoluteEscape.reason.includes("outside the workspace"),
      absoluteEscape.reason,
    );
  }

  const empty = await files.resolve("");
  assertEquals(empty.ok, false);
});

// --- stat / read / write ---------------------------------------------------

Deno.test("vm fs: stat answers undefined for a missing path", async () => {
  const missing = script([{ match: /^sh -c if \[ -e/, stdout: "" }]);
  assertEquals(await backend(missing.run).stat("/home/agent/x"), undefined);

  const file = script([
    { match: /^sh -c if \[ -e/, stdout: "regular file|42\n" },
  ]);
  assertEquals(await backend(file.run).stat("/home/agent/x"), {
    isFile: true,
    size: 42,
  });

  // A directory is not a file (the read tool relies on this distinction).
  const dir = script([
    { match: /^sh -c if \[ -e/, stdout: "directory|4096\n" },
  ]);
  assertEquals(await backend(dir.run).stat("/home/agent/x"), {
    isFile: false,
    size: 4096,
  });
});

Deno.test("vm fs: readHead decodes base64 and reports the size", async () => {
  // "hello" in base64.
  const { run } = script([
    { match: /^base64 --wrap=0/, stdout: "aGVsbG8=\n" },
  ]);
  const result = await backend(run).readHead("/home/agent/x.txt", 1024);
  assertEquals(new TextDecoder().decode(result.bytes), "hello");
  assertEquals(result.size, 5);
});

Deno.test("vm fs: an oversized read fails with the range hint", async () => {
  const { run } = script([
    { match: /^base64 --wrap=0/, stdout: "aGVsbG8=", truncated: true },
  ]);
  let message = "";
  try {
    await backend(run).readHead("/home/agent/big.bin", 1024 * 1024);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("line range"), message);
});

Deno.test("vm fs: writeText sends the payload over stdin, never inline", async () => {
  const { run, calls } = script([
    { match: /^sh -c mkdir -p/, stdout: "" },
  ]);
  await backend(run).writeText("/home/agent/a.txt", "content");
  const [argv] = calls;
  assert(argv !== undefined);
  // The command carries the path and a base64 decode, never the content:
  // quoting a whole source file into a shell string is what this avoids.
  assert(argv.join(" ").includes('base64 --decode > "$1"'), argv.join(" "));
});

Deno.test("vm fs: a private write is owner-only inside the machine", async () => {
  const { run, calls } = script([
    { match: /^sh -c umask 077/, stdout: "" },
  ]);
  await backend(run).writeText("/home/agent/spill.txt", "secret", {
    private: true,
  });
  const [argv] = calls;
  assert(argv !== undefined);
  const command = argv.join(" ");
  assert(command.includes("umask 077"), command);
  assert(command.includes('base64 --decode > "$1"'), command);
});

Deno.test("vm fs: readRanges returns the lines and the file length", async () => {
  const { run } = script([
    {
      match: /^sh -c wc -l/,
      // `wc -l` first, then the requested range's lines.
      stdout: "12\nfirst\nsecond\n",
    },
  ]);
  const result = await backend(run).readRanges("/home/agent/log.txt", [
    { from: 3, to: 4 },
  ]);
  assertEquals(result.lines, ["first", "second"]);
  assertEquals(result.lastLine, 12);
  assertEquals(result.endOfFile, false);
});

Deno.test("vm fs: readRanges reports a range past the end", async () => {
  const { run } = script([
    { match: /^sh -c wc -l/, stdout: "2\nonly\n" },
  ]);
  const result = await backend(run).readRanges("/home/agent/log.txt", [
    { from: 10, to: 20 },
  ]);
  assertEquals(result.lastLine, 2);
  assertEquals(result.endOfFile, true);
});

// --- listing ---------------------------------------------------------------

Deno.test("vm fs: listDir reports kind and name", async () => {
  const { run } = script([
    {
      match: /^sh -c cd/,
      stdout: "d|src\nf|a.ts\nl|link\n",
    },
  ]);
  const entries = await backend(run).listDir("/home/agent");
  assertEquals(entries, [
    { name: "src", isDirectory: true, isSymlink: false },
    { name: "a.ts", isDirectory: false, isSymlink: false },
    { name: "link", isDirectory: false, isSymlink: true },
  ]);
});

Deno.test("vm fs: listDir reports a missing directory", async () => {
  const { run } = script([{ match: /^sh -c cd/, exitCode: 3 }]);
  let message = "";
  try {
    await backend(run).listDir("/home/agent/nope");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("does not exist"), message);
});

// --- searching -------------------------------------------------------------

Deno.test("vm fs: grep parses path:line: text and counts files", async () => {
  const searches: string[] = [];
  const run: VmExec = (command) => {
    const joined = command.join(" ");
    if (joined.includes("grep ")) {
      return Promise.resolve({
        exitCode: 0,
        stdout: "/home/agent/a.ts:3: const foo = 1;\n" +
          "/home/agent/a.ts:9: const bar = 2;\n" +
          "/home/agent/b.ts:1: const foo = 3;\n",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    }
    if (joined.includes("if [ -e")) {
      return Promise.resolve({
        exitCode: 0,
        stdout: "directory|4096\n",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    }
    searches.push(joined);
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  };
  const result = await backend(run).grep({
    pattern: "const",
    caseSensitive: true,
    gitignore: false,
    hidden: true,
    maxResults: 100,
    maxFileSize: 8 * 1024 * 1024,
  });
  assertEquals(result.lines.length, 3);
  assertEquals(result.files, 2);
  assertEquals(result.lines[0], "/home/agent/a.ts:3: const foo = 1;");
});

Deno.test("vm fs: grep treats exit 1 (no match) as an empty result", async () => {
  const run: VmExec = (command) => {
    const joined = command.join(" ");
    if (joined.includes("grep ")) {
      return Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: "directory|4096\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  };
  const result = await backend(run).grep({
    pattern: "nothing",
    caseSensitive: false,
    gitignore: false,
    hidden: true,
    maxResults: 10,
    maxFileSize: 1024,
  });
  assertEquals(result, { lines: [], files: 0 });
});

Deno.test("vm fs: glob matches relative paths through the shared matcher", async () => {
  const run: VmExec = (command) => {
    const joined = command.join(" ");
    if (joined.includes("find ")) {
      return Promise.resolve({
        exitCode: 0,
        stdout: [
          "/home/agent/src/a.ts",
          "/home/agent/src/b.js",
          "/home/agent/src/nested/c.ts",
          "/home/agent/dist/d.ts",
        ].join("\n"),
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: "directory|4096\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  };
  const found = await backend(run).glob({
    pattern: "**/*.ts",
    gitignore: false,
    hidden: true,
    maxResults: 100,
  });
  // `**` crosses directories (the host's glob does too), and the walk is the
  // container's — the artifact list is applied by `find`, not here.
  assertEquals(found, [
    "/home/agent/src/a.ts",
    "/home/agent/src/nested/c.ts",
    "/home/agent/dist/d.ts",
  ]);
});

// --- the shell commands ----------------------------------------------------

Deno.test("vm fs: shellQuote survives quotes and spaces", () => {
  assertEquals(shellQuote("plain"), "'plain'");
  assertEquals(shellQuote("a b"), "'a b'");
  assertEquals(shellQuote("it's"), "'it'\\''s'");
});

Deno.test("vm fs: grepCommand carries the flags the host tool documents", () => {
  const command = grepCommand(["/home/agent"], {
    pattern: "foo|bar",
    caseSensitive: true,
    gitignore: true,
    hidden: true,
    maxResults: 50,
    maxFileSize: 1024,
  });
  // Recursive, line numbers, binary skipped, no case flag when sensitive.
  assert(command.includes("-r"), command);
  assert(command.includes("-n"), command);
  assert(command.includes("-I"), command);
  assert(!/(^| )-i( |$)/.test(command), command);
  // The artifact list is pruned, and the pattern is quoted.
  assert(command.includes("--exclude-dir='.git'"), command);
  assert(command.includes("--regexp='foo|bar'"), command);
  assert(command.includes("head -n 50"), command);
});

Deno.test("vm fs: grepCommand adds -i for a case-insensitive search", () => {
  const command = grepCommand(["/home/agent"], {
    pattern: "foo",
    caseSensitive: false,
    gitignore: true,
    hidden: true,
    maxResults: 10,
    maxFileSize: 1024,
  });
  assert(/(^| )-i( |$)/.test(command), command);
});

Deno.test("vm fs: walkCommand prunes artifacts and honors the hidden flag", () => {
  const visible = walkCommand(["/home/agent"], false);
  assert(visible.includes("-name '.git'"), visible);
  assert(visible.includes("! -name '.*'"), visible);
  // Symlinks are never followed.
  assert(visible.includes("! -type l"), visible);

  const hidden = walkCommand(["/home/agent"], true);
  assert(!hidden.includes("! -name '.*'"), hidden);
});
