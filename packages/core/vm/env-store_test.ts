import { assertEquals, assertRejects } from "@std/assert";
import type { VmCommandResult } from "./command.ts";
import type { VmExec, VmExecOptions } from "./container.ts";
import { VM_ENV_DIR, VM_ENV_JSON, VM_ENV_SH } from "./contract.ts";
import {
  envScript,
  parseEnvJson,
  requireEnvName,
  requireEnvValue,
  VmEnvStore,
} from "./env-store.ts";

/**
 * The store: one JSON object that may be merged, one shell script a command
 * can source, and the rules that keep a value from breaking either.
 *
 * The exec seam is faked with a tiny file system, so the tests exercise the
 * commands the store sends (which path, stdin rather than argv) without a
 * container.
 */

function fakeMachine(initial: { json?: string } = {}): {
  exec: VmExec;
  files: Map<string, string>;
  commands: string[][];
  writes: { path: string; text: string }[];
} {
  const files = new Map<string, string>();
  if (initial.json !== undefined) files.set(VM_ENV_JSON, initial.json);
  const commands: string[][] = [];
  const writes: { path: string; text: string }[] = [];
  const exec: VmExec = (command, options: VmExecOptions) => {
    const argv = [...command];
    commands.push(argv);
    const result: VmCommandResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    };
    const script = argv[2] ?? "";
    if (script.startsWith("cat ")) {
      result.stdout = files.get(argv[4] ?? "") ?? "";
      return Promise.resolve(result);
    }
    if (script.includes("cat >")) {
      const path = argv[5] ?? "";
      const text = new TextDecoder().decode(options.stdin ?? new Uint8Array());
      files.set(path, text);
      writes.push({ path, text });
      return Promise.resolve(result);
    }
    return Promise.resolve(result);
  };
  return { exec, files, commands, writes };
}

Deno.test("env store: set keeps the other entries and replaces the named one", async () => {
  const machine = fakeMachine();
  const store = new VmEnvStore(machine.exec);
  await store.set("FIRST", "one");
  await store.set("SECOND", "two");
  await store.set("FIRST", "one-again");

  assertEquals(await store.names(), ["FIRST", "SECOND"]);
  const json = JSON.parse(machine.files.get(VM_ENV_JSON)!);
  assertEquals(json, { FIRST: "one-again", SECOND: "two" });
  assertEquals(machine.files.get(VM_ENV_SH), envScript(json));
});

Deno.test("env store: the command sources entries the shell can read", () => {
  // Anything can be a value: quotes, `$`, backslashes, newlines. One line
  // per entry, single-quoted, so the shell takes it verbatim.
  assertEquals(
    envScript({ KEY: 'it\'s $HOME \\ "x"\nsecond' }),
    `export KEY='it'\\''s $HOME \\ "x"\nsecond'\n`,
  );
  // A blank store is a valid file (the first write before any value).
  assertEquals(envScript({}), "\n");
});

Deno.test("env store: a broken file reads as empty instead of failing", async () => {
  const machine = fakeMachine({ json: "{ not json" });
  const store = new VmEnvStore(machine.exec);
  assertEquals(await store.names(), []);
  // Storing into it recovers: the new entry is the only one written.
  await store.set("KEY", "value");
  assertEquals(
    machine.files.get(VM_ENV_JSON)!.includes('"KEY": "value"'),
    true,
  );
});

Deno.test("env store: the value never appears in a command's arguments", async () => {
  const machine = fakeMachine();
  const store = new VmEnvStore(machine.exec);
  await store.set("TOKEN", "super-secret-value");
  // Every podman exec argv is visible on the host (`ps`); the value travels
  // through stdin, so it is in the file and nowhere else.
  for (const argv of machine.commands) {
    assertEquals(argv.join(" ").includes("super-secret-value"), false);
  }
});

Deno.test("env store: a failed write rejects instead of reporting success", async () => {
  const exec: VmExec = () =>
    Promise.resolve<VmCommandResult>({
      exitCode: 1,
      stdout: "",
      stderr: "read-only file system\n",
      truncated: false,
      timedOut: false,
    });
  const store = new VmEnvStore(exec);
  await assertRejects(
    () => store.set("KEY", "value"),
    Error,
    "read-only file system",
  );
});

Deno.test("env store: has() tells the dialog whether it replaces a value", async () => {
  const machine = fakeMachine({ json: JSON.stringify({ SET: "v" }) });
  const store = new VmEnvStore(machine.exec);
  assertEquals(await store.has("SET"), true);
  assertEquals(await store.has("UNSET"), false);
});

Deno.test("env store: JSON entries that are not values are dropped", () => {
  assertEquals(
    parseEnvJson(
      JSON.stringify({
        GOOD: "v",
        NUMBER: 3,
        "not-a-name": "v",
        "1BAD": "v",
        NESTED: { a: 1 },
      }),
    ),
    { GOOD: "v" },
  );
  assertEquals(parseEnvJson("[]"), {});
  assertEquals(parseEnvJson(""), {});
});

Deno.test("env store: names must be shell identifiers", () => {
  assertEquals(requireEnvName("  OPENAI_API_KEY  "), "OPENAI_API_KEY");
  assertEquals(requireEnvName("_private"), "_private");
  for (const bad of ["", "   ", "1KEY", "MY-KEY", "MY KEY", "a.b"]) {
    assertThrowsInvalid(() => requireEnvName(bad));
  }
  assertThrowsInvalid(() => requireEnvName("K".repeat(65)));
});

Deno.test("env store: values are trimmed and bounded", () => {
  assertEquals(requireEnvValue("  sk-abc\n"), "sk-abc");
  assertThrowsInvalid(() => requireEnvValue(""));
  assertThrowsInvalid(() => requireEnvValue("   "));
  assertThrowsInvalid(() => requireEnvValue(42));
  assertThrowsInvalid(() => requireEnvValue("a\0b"));
  assertThrowsInvalid(() => requireEnvValue("x".repeat(16 * 1024 + 1)));
});

/** The error is a CoreError, and the message says what is wrong (the dialog
 * and the tool show it as-is). */
function assertThrowsInvalid(fn: () => unknown): void {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.length > 0, true);
}

Deno.test("env store: the files live outside any agent's folder", () => {
  // Machine-wide, as the tool says: two agents share one machine, so one
  // entry serves both. Next to the background log directory, away from the
  // files an agent keeps for one conversation.
  assertEquals(VM_ENV_DIR.startsWith("/home/agent/"), true);
  assertEquals(VM_ENV_JSON.startsWith(`${VM_ENV_DIR}/`), true);
  assertEquals(VM_ENV_SH.startsWith(`${VM_ENV_DIR}/`), true);
});
