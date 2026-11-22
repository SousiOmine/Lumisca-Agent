import { randomUUID } from "node:crypto";
import { errorMessage } from "../errors.ts";
import { transpileToJs } from "../tools/js-sandbox.ts";
import type { VmChannelOpener, VmExec } from "../vm/container.ts";
import { shellQuote } from "../vm/quote.ts";
import {
  CODE_STORE_MAX_KEY_CHARS,
  CODE_STORE_MAX_TOTAL_BYTES,
  CODE_STORE_MAX_VALUE_BYTES,
  type CodeStoreChanges,
} from "./store.ts";
import {
  type CodeRunContext,
  type CodeRunOutcome,
  type CodeRuntime,
  programOf,
} from "./types.ts";

/** Where the program file is written inside the machine. `/tmp` on purpose:
 * it is the machine's own scratch space, cleared on a container restart, and
 * outside the agent's home so a program never shows up among its files. */
const SCRIPT_DIR = "/tmp/lumisca-exec";

/** Writing the program and removing it are small, fixed operations; a
 * machine that cannot answer one of them in this long is not answering. */
const SCRIPT_IO_TIMEOUT_MS = 30_000;

/** Extra time the channel gets beyond the program's own limit, so the
 * program's `timeout` (reported by `timeout` inside the machine) is the one
 * that explains the failure. */
const CHANNEL_GRACE_MS = 10_000;

/**
 * The scripting tool call inside a stella machine.
 *
 * The program runs under the machine's own `node`, so it has exactly what
 * `bash` in the same conversation has — the machine, and nothing outside it.
 * That is also why this runtime exists instead of the host one: running the
 * program in the server process would be a way out of the machine, which is
 * the one thing stella's tools must not offer.
 *
 * Tool calls cannot happen in the machine: every tool dispatches on the
 * server (MCP clients, the browser lab, routines). So the program is started
 * as an interactive `podman exec` and the two sides speak a line protocol
 * over its standard streams — the program writes what it wants to run, the
 * server answers with the result. No port is opened in either direction (see
 * vm/channel.ts).
 */
export function createVmCodeRuntime(options: {
  /** One-shot exec, for writing and removing the program file. */
  exec: VmExec;
  /** Starts the program and keeps its streams. */
  channel: VmChannelOpener;
  /** The session's folder inside the machine: relative paths in the program
   * resolve here, exactly as `bash` does. */
  cwd: string;
}): CodeRuntime {
  return {
    async run(code: string, context: CodeRunContext): Promise<CodeRunOutcome> {
      context.signal?.throwIfAborted();
      const js = await transpileToJs(code);
      const path = `${SCRIPT_DIR}/${randomUUID()}.cjs`;
      const snapshot = JSON.stringify(context.store.snapshot());
      const literal = JSON.stringify(snapshot)
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
      const file =
        `${VM_PROGRAM_PRELUDE}\n` +
        `const __STORE__ = new Map(Object.entries(JSON.parse(${literal})));\n` +
        "for (const __value of __STORE__.values()) " +
        '__storeBytes += Buffer.byteLength(JSON.stringify(__value), "utf8");\n' +
        `${runnerOf(js)}`;
      await writeFile(options, path, file);
      try {
        return await runProgram(options, path, context);
      } finally {
        // Best effort: the program is done with it either way, and a failed
        // cleanup must not turn a finished run into an error.
        void options
          .exec(["rm", "-f", path], { timeoutMs: SCRIPT_IO_TIMEOUT_MS })
          .catch(() => undefined);
      }
    },
  };
}

async function writeFile(
  options: { exec: VmExec },
  path: string,
  file: string,
): Promise<void> {
  const result = await options.exec(
    [
      "sh",
      "-c",
      `mkdir -p ${shellQuote(SCRIPT_DIR)} && cat > ${shellQuote(path)}`,
    ],
    {
      timeoutMs: SCRIPT_IO_TIMEOUT_MS,
      stdin: new TextEncoder().encode(file),
      maxOutput: 4096,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not write the program into the machine: ${
        result.stderr.trim() || result.exitCode
      }`,
    );
  }
}

async function runProgram(
  options: { channel: VmChannelOpener; cwd: string },
  path: string,
  context: CodeRunContext,
): Promise<CodeRunOutcome> {
  const seconds = Math.ceil(context.timeoutMs / 1000);
  const channel = await options.channel(
    [
      "sh",
      "-c",
      // `timeout` is the wall clock the program is allowed: a program that
      // ignores a dead pipe still ends here. `exec` keeps the pid the one
      // podman exec started, so killing the channel reaches node itself.
      `exec timeout -k 5 ${seconds} node ${shellQuote(path)}`,
    ],
    {
      timeoutMs: context.timeoutMs + CHANNEL_GRACE_MS,
      workdir: options.cwd,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    },
  );

  const printed: string[] = [];
  const running = new Set<Promise<void>>();
  let value: unknown;
  let done = false;
  let failure: Error | undefined;

  const answer = async (message: WireCall): Promise<void> => {
    try {
      const result = await context.call(message.name, message.args ?? {});
      await channel.write(
        JSON.stringify({
          type: "result",
          id: message.id,
          ok: true,
          text: result.text,
        }),
      );
    } catch (error) {
      await channel.write(
        JSON.stringify({
          type: "result",
          id: message.id,
          ok: false,
          error: errorMessage(error),
        }),
      );
    }
  };

  try {
    for (;;) {
      const line = await channel.read();
      if (line === undefined) break;
      const message = parseWire(line);
      if (message === undefined) {
        // A program that wrote to stdout itself: not protocol, so it is
        // output the model should see rather than a line to drop.
        printed.push(line);
        continue;
      }
      switch (message.type) {
        case "call": {
          // Not awaited: a program that starts several calls before it
          // waits for any of them (`Promise.all`) must get all of them
          // started, or the parallelism the tool promises would be a lie.
          const task = answer(message);
          running.add(task);
          void task.finally(() => running.delete(task));
          break;
        }
        case "done":
          value = message.value;
          if (message.store !== undefined) context.store.apply(message.store);
          done = true;
          break;
        case "error":
          failure = new Error(message.message);
          break;
      }
      if (done || failure !== undefined) break;
    }
  } finally {
    await Promise.allSettled([...running]);
    channel.kill();
  }

  const output = [printed.join("\n"), channel.stderr().replace(/\n$/, "")]
    .filter((part) => part.length > 0)
    .join("\n");

  if (context.signal?.aborted === true) {
    throw new Error("The program was stopped.");
  }
  if (failure !== undefined) throw failure;
  const exitCode = channel.exitCode();
  if (!done && exitCode === 124) {
    throw new Error(
      `The program exceeded its ${Math.round(context.timeoutMs / 1000)}s limit.`,
    );
  }
  if (!done && exitCode !== 0) {
    throw new Error(
      `The program exited with code ${exitCode}${
        output.length > 0 ? `: ${output.split("\n").slice(-3).join("\n")}` : ""
      }`,
    );
  }
  return { value, output };
}

/** One line the program writes: a tool call, the result, or a failure. */
type WireMessage = WireCall | WireDone | WireError;

interface WireCall {
  type: "call";
  id: number;
  name: string;
  args?: unknown;
}

interface WireDone {
  type: "done";
  value: unknown;
  store?: CodeStoreChanges;
}

interface WireError {
  type: "error";
  message: string;
}

/** Read one protocol line, or undefined for anything else: output a program
 * wrote itself shares the stream, and a malformed line must not end the run
 * with a parse error nobody can act on. */
function parseWire(line: string): WireMessage | undefined {
  if (!line.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case "call":
      return typeof message.id === "number" && typeof message.name === "string"
        ? {
            type: "call",
            id: message.id,
            name: message.name,
            args: message.args,
          }
        : undefined;
    case "done": {
      const store = message.store;
      if (store !== undefined && !isStoreChanges(store)) {
        return {
          type: "error",
          message: "The program sent a malformed store update.",
        };
      }
      return {
        type: "done",
        value: message.value,
        ...(store !== undefined ? { store } : {}),
      };
    }
    case "error":
      return {
        type: "error",
        message:
          typeof message.message === "string"
            ? message.message
            : "The program failed.",
      };
    default:
      return undefined;
  }
}

/** True when a done message carries the store diff the server can apply. */
function isStoreChanges(value: unknown): value is CodeStoreChanges {
  if (typeof value !== "object" || value === null) return false;
  const changes = value as Record<string, unknown>;
  if (
    typeof changes.set !== "object" ||
    changes.set === null ||
    Array.isArray(changes.set)
  ) {
    return false;
  }
  if (!Array.isArray(changes.delete)) return false;
  return changes.delete.every((key) => typeof key === "string");
}

/**
 * The machine-side half of the protocol, written once per program.
 *
 * Plain CommonJS (`.cjs`) so `require("node:readline")` and the program's
 * own top-level declarations share one file without a module loader
 * involved. stdout carries protocol lines only; the console is redirected to
 * stderr, which the channel keeps as the program's output.
 */
const VM_PROGRAM_PRELUDE = `"use strict";
const STORE_MAX_KEY_CHARS = ${CODE_STORE_MAX_KEY_CHARS};
const STORE_MAX_VALUE_BYTES = ${CODE_STORE_MAX_VALUE_BYTES};
const STORE_MAX_TOTAL_BYTES = ${CODE_STORE_MAX_TOTAL_BYTES};
const readline = require("node:readline");
const incoming = readline.createInterface({ input: process.stdin, terminal: false });
const pending = new Map();
let nextId = 1;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function callTool(name, args) {
  const id = nextId++;
  return new Promise(function (resolve, reject) {
    pending.set(id, { resolve: resolve, reject: reject });
    send({ type: "call", id: id, name: name, args: args === undefined ? {} : args });
  });
}
incoming.on("line", function (line) {
  if (line.length === 0) return;
  let message;
  try { message = JSON.parse(line); } catch (error) { return; }
  if (message.type === "abort") process.exit(1);
  const waiter = pending.get(message.id);
  if (waiter === undefined) return;
  pending.delete(message.id);
  if (message.ok === true) waiter.resolve(String(message.text === undefined ? "" : message.text));
  else waiter.reject(new Error(String(message.error === undefined ? "The tool failed." : message.error)));
});
incoming.on("close", function () { process.exit(1); });
const tools = new Proxy(Object.create(null), {
  get: function (target, name) {
    if (typeof name !== "string" || name === "then") return undefined;
    return function (args) { return callTool(name, args); };
  },
  has: function () { return true; },
});
function show(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch (error) { return String(value); }
}
console.log = console.info = console.warn = console.error = console.debug = function () {
  process.stderr.write(Array.prototype.map.call(arguments, show).join(" ") + "\\n");
};
function jsonValue(value) {
  if (value === undefined) return null;
  try { JSON.stringify(value); return value; } catch (error) { return String(value); }
}
const __storeChanged = new Set();
let __storeBytes = 0;
// The bounds are the server-side store's (store.ts), interpolated above.
function storeKey(key) {
  if (typeof key !== "string" || key.length === 0) throw new Error("The store key must be a non-empty string.");
  if (key.length > STORE_MAX_KEY_CHARS) throw new Error("The store key is longer than " + STORE_MAX_KEY_CHARS + " characters.");
  return key;
}
function store(key, value) {
  const name = storeKey(key);
  if (value === undefined) {
    const old = __store.get(name);
    if (old !== undefined) {
      __storeBytes -= Buffer.byteLength(JSON.stringify(old), "utf8");
      __store.delete(name);
    }
    __storeChanged.add(name);
    return;
  }
  let text;
  try { text = JSON.stringify(value); } catch (error) {
    throw new Error("The store can hold only JSON values: " + String((error && error.message) || error));
  }
  if (text === undefined) throw new Error("The store can hold only JSON values: functions and symbols are not JSON.");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > STORE_MAX_VALUE_BYTES) throw new Error("The store value is larger than " + STORE_MAX_VALUE_BYTES + " bytes.");
  const old = __store.get(name);
  const oldBytes = old === undefined ? 0 : Buffer.byteLength(JSON.stringify(old), "utf8");
  if (__storeBytes - oldBytes + bytes > STORE_MAX_TOTAL_BYTES) throw new Error("The store would be larger than " + STORE_MAX_TOTAL_BYTES + " bytes.");
  __store.set(name, JSON.parse(text));
  __storeBytes += bytes - oldBytes;
  __storeChanged.add(name);
}
function load(key) {
  const name = storeKey(key);
  const value = __store.get(name);
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function storeChanges() {
  const set = Object.create(null);
  const remove = [];
  for (const key of __storeChanged) {
    if (__store.has(key)) set[key] = __store.get(key);
    else remove.push(key);
  }
  return { set: set, delete: remove };
}`;

/** The program itself, wrapped so its `return` becomes the reported value
 * (see programOf) and a throw becomes `{type: "error"}`. */
function runnerOf(js: string): string {
  return `(async function () {
  try {
    const value = await (${programOf(js)});
    send({ type: "done", value: jsonValue(value), store: storeChanges() });
  } catch (error) {
    send({ type: "error", message: String((error && error.message) || error) });
  }
})();`;
}
