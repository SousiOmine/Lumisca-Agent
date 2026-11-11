/// <reference path="../../../types/bun.d.ts" />
/**
 * The runtime API this app is written against, implemented on Bun and Node:
 * file system, process, Command, serve (HTTP and WebSocket) and the small
 * pieces around them.
 *
 * The server was written for Deno, and the shape kept here is Deno's — the
 * names, the option objects and the quirks (`status` ends at process exit,
 * `env` merges, a missing program throws from `spawn`) — so the call sites
 * did not have to change when the runtime did. It is the migration seam:
 * nothing below calls into Deno, and the server imports it before anything
 * else, so the packaged binary carries it too. Product code uses the
 * `runtime` export; the `Deno` global stays for the test runner's
 * `Deno.test` and for the browser probe.
 *
 * FFI (`dlopen`) is not implemented yet; the Windows computer host is the
 * one caller and needs `bun:ffi` before that platform can move.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function sync<T>(body: () => T): T {
  try {
    return body();
  } catch (error) {
    mapError(error);
  }
}

class NotFoundError extends Error {
  override name = "NotFound";
}
class AlreadyExistsError extends Error {
  override name = "AlreadyExists";
}
class PermissionDeniedError extends Error {
  override name = "PermissionDenied";
}
class NotCapableError extends Error {
  override name = "NotCapable";
}
class AddrInUseError extends Error {
  override name = "AddrInUse";
}

/** Windows can report a real path with the `\\?\` extended-length prefix
 * (or `\\?\UNC\` for a share); Deno's paths do not carry it, and a
 * comparison against an ordinary path would fail on the prefix alone. */
function normalizeRealPath(resolved: string): string {
  if (resolved.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + resolved.slice(8);
  }
  if (resolved.startsWith("\\\\?\\")) return resolved.slice(4);
  return resolved;
}

function mapError(error: unknown): never {
  const err = error as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") throw new NotFoundError(err.message);
  if (err?.code === "EEXIST") throw new AlreadyExistsError(err.message);
  if (err?.code === "EACCES" || err?.code === "EPERM") {
    throw new PermissionDeniedError(err.message);
  }
  throw err;
}

const fileInfo = (st: fs.Stats) => ({
  isFile: st.isFile(),
  isDirectory: st.isDirectory(),
  isSymlink: st.isSymbolicLink(),
  isBlockDevice: st.isBlockDevice(),
  isCharDevice: st.isCharacterDevice(),
  isFifo: st.isFIFO(),
  isSocket: st.isSocket(),
  size: st.size,
  mtime: st.mtime,
  atime: st.atime,
  birthtime: st.birthtime,
  ctime: st.ctime,
  dev: st.dev,
  ino: st.ino,
  mode: st.mode,
  nlink: st.nlink,
  uid: st.uid,
  gid: st.gid,
  rdev: st.rdev,
  blksize: st.blksize,
  blocks: st.blocks,
});

function tempDir(options?: { dir?: string; prefix?: string }) {
  return fs.mkdtempSync(
    path.join(options?.dir ?? os.tmpdir(), options?.prefix ?? "tmp-"),
  );
}

function tempFile(options?: { dir?: string; prefix?: string }) {
  const name = (options?.prefix ?? "") + crypto.randomUUID();
  const pathname = path.join(options?.dir ?? os.tmpdir(), name);
  fs.writeFileSync(pathname, "");
  return pathname;
}

async function tempFileAsync(options?: { dir?: string; prefix?: string }) {
  return tempFile(options);
}

async function tempDirAsync(options?: { dir?: string; prefix?: string }) {
  return fsp.mkdtemp(
    path.join(options?.dir ?? os.tmpdir(), options?.prefix ?? "tmp-"),
  );
}

function makeDir(pathname: string, options?: { recursive?: boolean }) {
  fs.mkdirSync(pathname, { recursive: options?.recursive ?? false });
}

function* readDirSync(pathname: string) {
  for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) {
    yield {
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
    };
  }
}

async function* readDir(pathname: string) {
  yield* readDirSync(pathname);
}

class ShimFsFile {
  #fd: number;
  #pos = 0;
  constructor(fd: number) {
    this.#fd = fd;
  }
  read(p: Uint8Array): Promise<number | null> {
    const n = fs.readSync(this.#fd, p, 0, p.length, this.#pos);
    if (n === 0) return Promise.resolve(null);
    this.#pos += n;
    return Promise.resolve(n);
  }
  write(p: Uint8Array): Promise<number> {
    const n = fs.writeSync(this.#fd, p, 0, p.length, this.#pos);
    this.#pos += n;
    return Promise.resolve(n);
  }
  seek(offset: number, whence: number): Promise<number> {
    if (whence === 0) this.#pos = offset;
    else if (whence === 1) this.#pos += offset;
    else this.#pos = fs.fstatSync(this.#fd).size + offset;
    return Promise.resolve(this.#pos);
  }
  stat(): Promise<ReturnType<typeof fileInfo>> {
    return Promise.resolve(fileInfo(fs.fstatSync(this.#fd)));
  }
  get readable(): ReadableStream<Uint8Array> {
    const file = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const buffer = new Uint8Array(64 * 1024);
        const read = await file.read(buffer);
        if (read === null) controller.close();
        else controller.enqueue(buffer.subarray(0, read));
      },
    });
  }
  close(): void {
    fs.closeSync(this.#fd);
  }
}

function openFile(
  pathname: string,
  options?: {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
    /** Permission bits for a file this call creates (Deno's `open` option;
     * the updater relies on it to keep a binary's exec bit). */
    mode?: number;
  },
): ShimFsFile {
  let flags = 0;
  const read = options?.read ?? true;
  const write = options?.write ?? false;
  if (read && write) flags = fs.constants.O_RDWR;
  else if (write) flags = fs.constants.O_WRONLY;
  else flags = fs.constants.O_RDONLY;
  if (options?.create) flags |= fs.constants.O_CREAT;
  if (options?.truncate) flags |= fs.constants.O_TRUNC;
  if (options?.append) flags |= fs.constants.O_APPEND;
  return new ShimFsFile(fs.openSync(pathname, flags, options?.mode));
}

type CommandOptions = {
  args?: string[];
  cwd?: string;
  /** Extra variables, merged over this process's environment — Deno's
   * default. `clearEnv: true` starts from nothing instead. */
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdin?: "null" | "inherit" | "piped";
  stdout?: "null" | "inherit" | "piped";
  stderr?: "null" | "inherit" | "piped";
  signal?: AbortSignal;
};

/** A child's stdout/stderr as a web stream. The "end" event can arrive
 * after the reader has cancelled (a killed command whose pipes a survivor
 * still holds), so both handlers are guarded: closing an already closed
 * controller throws out of an event listener, where nobody can catch it. */
function pipeToStream(
  stream: ReturnType<typeof spawn>["stdout"],
): ReadableStream<Uint8Array> {
  if (!stream) return new ReadableStream({ start: (c) => c.close() });
  let finished = false;
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => {
        if (finished) return;
        controller.enqueue(new Uint8Array(chunk));
      });
      stream.on("end", () => {
        if (finished) return;
        finished = true;
        controller.close();
      });
    },
    cancel() {
      finished = true;
      stream.destroy();
    },
  });
}

/** Resolve a command before spawning it, the way Deno does: a bare name is
 * looked up in PATH (with PATHEXT on Windows), a path is taken as given.
 * Deno's `spawn()` throws synchronously when the program is missing, and
 * callers rely on that (`runVmCommand` turns it into "podman is not
 * installed"); Node instead emits an `error` event on the child, which
 * becomes an uncaught exception when nobody listens. */
function findExecutable(command: string): string {
  const windows = process.platform === "win32";
  const isPath = command.includes("/") || (windows && command.includes("\\"));
  const extensions = windows
    ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((ext) => ext !== "")
    : [""];
  const withExtensions = (base: string): string[] => {
    if (!windows) return [base];
    const lower = base.toLowerCase();
    if (extensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
      return [base];
    }
    return extensions.map((ext) => base + ext);
  };
  const usable = (candidate: string): boolean => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isPath) {
    for (const candidate of withExtensions(command)) {
      if (usable(candidate)) return candidate;
    }
    throw new NotFoundError(`No such file or directory: ${command}`);
  }
  for (const dir of (process.env["PATH"] ?? "").split(windows ? ";" : ":")) {
    if (dir === "") continue;
    for (const candidate of withExtensions(path.join(dir, command))) {
      if (usable(candidate)) return candidate;
    }
  }
  throw new NotFoundError(`Executable not found in $PATH: "${command}"`);
}

class ShimChildProcess {
  #child: ReturnType<typeof spawn>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  constructor(child: ReturnType<typeof spawn>) {
    this.#child = child;
    // Without a listener, Node (and Bun) turn a failed spawn into an
    // uncaught exception from the event loop.
    child.on("error", (error) => {
      this.#startError = error;
    });
    this.stdout = pipeToStream(child.stdout);
    this.stderr = pipeToStream(child.stderr);
  }
  get stdin(): WritableStream<Uint8Array> {
    const input = this.#child.stdin;
    return new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          if (!input) {
            resolve();
            return;
          }
          input.write(chunk, (error) => (error ? reject(error) : resolve()));
        });
      },
      close() {
        return new Promise<void>((resolve) => {
          input?.end(() => resolve());
        });
      },
    });
  }
  get pid(): number {
    return this.#child.pid ?? -1;
  }

  /** Collect both pipes and the exit status (`Deno.Command.output`). */
  async output(): Promise<{
    code: number;
    success: boolean;
    signal: string | null;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }> {
    const [stdout, stderr] = await Promise.all([
      new Response(this.stdout).arrayBuffer(),
      new Response(this.stderr).arrayBuffer(),
    ]);
    const status = await this.status;
    return {
      ...status,
      stdout: new Uint8Array(stdout),
      stderr: new Uint8Array(stderr),
    } as {
      code: number;
      success: boolean;
      signal: string | null;
      stdout: Uint8Array;
      stderr: Uint8Array;
    };
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.status.then(() => undefined);
  }
  /** Set when the child failed before it started (permission, too many
   * files, …). Its streams never open, so status answers like a shell does. */
  #startError: Error | undefined;

  get status(): Promise<{
    code: number;
    success: boolean;
    signal: string | null;
  }> {
    if (this.#startError !== undefined) {
      return Promise.resolve({ code: 127, success: false, signal: null });
    }
    // Deno's `status` settles when the process exits, not when its pipes
    // close: a descendant the command left behind inherits the pipes and can
    // outlive it (a `server &`), and waiting for "close" would hang the call
    // on a process that is already gone. Node keeps the exit state, so a
    // caller that asks after the fact still gets an answer.
    const settled = (): {
      code: number;
      success: boolean;
      signal: string | null;
    } => {
      const signal = this.#child.signalCode ?? null;
      // A signal-killed child exits with 128 + the signal number (137 for
      // SIGKILL), which is what Deno reports and what callers assert on.
      // Bun sets `exitCode` to that already on Linux but leaves it null on
      // macOS, so the code is derived here instead of trusted.
      const code =
        signal === null
          ? (this.#child.exitCode ?? 1)
          : 128 + (os.constants.signals[signal as NodeJS.Signals] ?? 0);
      return { code, success: code === 0, signal };
    };
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return Promise.resolve(settled());
    }
    return new Promise((resolve) => {
      this.#child.on("exit", () => resolve(settled()));
    });
  }
  kill(signal?: string): void {
    this.#child.kill(signal as NodeJS.Signals | undefined);
  }
  ref(): void {}
  unref(): void {}
}

/** Deno merges `env` over the parent environment unless `clearEnv` is set;
 * Node's spawn replaces it. The difference is invisible with a full map and
 * fatal with a partial one: on Windows a child without SystemRoot cannot run
 * at all. */
function commandEnv(options: CommandOptions): Record<string, string> {
  const inherited =
    options.clearEnv === true
      ? {}
      : (process.env as Record<string, string | undefined>);
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) merged[key] = value;
  }
  return { ...merged, ...options.env };
}

class ShimCommand {
  #cmd: string;
  #options: CommandOptions;
  constructor(cmd: string, options: CommandOptions = {}) {
    this.#cmd = cmd;
    this.#options = options;
  }
  /** The suite spawns helper scripts through `Deno.execPath()` + `run`, and
   * those children need the shim too: whatever their cwd, the preload is
   * named here instead of being found in a bunfig.toml. */
  #args(): string[] {
    const args = this.#options.args ?? [];
    if (this.#cmd === process.execPath && args[0] === "run") {
      return [
        "--preload",
        path.join(path.dirname(fileURLToPath(import.meta.url)), "deno-shim.ts"),
        ...args,
      ];
    }
    return args;
  }
  spawn(): ShimChildProcess {
    const child = spawn(findExecutable(this.#cmd), this.#args(), {
      cwd: this.#options.cwd,
      env: commandEnv(this.#options),
      stdio: [
        this.#options.stdin === "piped"
          ? "pipe"
          : this.#options.stdin === "inherit"
            ? "inherit"
            : "ignore",
        this.#options.stdout === "inherit"
          ? "inherit"
          : this.#options.stdout === "null"
            ? "ignore"
            : "pipe",
        this.#options.stderr === "inherit"
          ? "inherit"
          : this.#options.stderr === "null"
            ? "ignore"
            : "pipe",
      ],
    });
    const signal = this.#options.signal;
    if (signal !== undefined) {
      if (signal.aborted) child.kill("SIGTERM");
      else
        signal.addEventListener("abort", () => child.kill("SIGTERM"), {
          once: true,
        });
    }
    return new ShimChildProcess(child);
  }
  outputSync() {
    const result = spawnSync(findExecutable(this.#cmd), this.#args(), {
      cwd: this.#options.cwd,
      env: commandEnv(this.#options),
      stdio: "pipe",
    });
    return {
      code: result.status ?? 1,
      success: result.status === 0,
      signal: null,
      stdout: new Uint8Array(result.stdout ?? []),
      stderr: new Uint8Array(result.stderr ?? []),
    };
  }
  async output() {
    const result = spawnSync(this.#cmd, this.#args(), {
      cwd: this.#options.cwd,
      env: this.#options.env ?? process.env,
      stdio: "pipe",
    });
    return {
      code: result.status ?? 1,
      success: result.status === 0,
      signal: null,
      stdout: new Uint8Array(result.stdout ?? []),
      stderr: new Uint8Array(result.stderr ?? []),
    };
  }
}

/** The Deno-shaped WebSocket that hono/deno's adapter drives through its
 * onopen/onmessage/onclose fields. Bun delivers the same events to the
 * server's `websocket` handler, so this object is the bridge between them. */
class DenoSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  readonly protocol: string;
  readonly url: string;
  #ws: {
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
  } | null = null;
  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
  }
  _attach(ws: {
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
  }) {
    this.#ws = ws;
    this.readyState = 1;
    // Deno's open event is asynchronous: a handler assigned right after
    // `upgradeWebSocket` returns must still see it. Bun can call the
    // websocket's open hook inside `upgrade`, before the caller has the
    // socket, so the event is deferred to a microtask.
    queueMicrotask(() => {
      if (this.readyState === 1) this.onopen?.(new Event("open"));
    });
  }
  _message(data: string | Uint8Array) {
    this.onmessage?.({ data: typeof data === "string" ? data : data.buffer });
  }
  _close(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  send(data: unknown): void {
    this.#ws?.send(data);
  }
  close(code = 1000, reason = ""): void {
    this.#ws?.close(code, reason);
  }
}

/** Deno.listen for plain TCP: enough to claim a port and to prove it is free.
 * Bun binds synchronously, so EADDRINUSE arrives as a throw like Deno's. */
function denoListen(options: {
  hostname?: string;
  port?: number;
  transport?: string;
}) {
  try {
    const server = Bun.listen({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 0,
      socket: {
        data() {},
        open(socket) {
          socket.end();
        },
      },
    });
    return {
      addr: {
        transport: "tcp",
        hostname: options.hostname ?? "127.0.0.1",
        port: server.port,
      },
      close: () => server.stop(true),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE")
      throw new AddrInUseError((error as Error).message);
    throw error;
  }
}

/** Deno.connect, used only to pre-flight a unix socket before handing the
 * address to dbus. */
function denoConnect(options: {
  path?: string;
  hostname?: string;
  port?: number;
}) {
  return new Promise<{ close: () => void }>((resolve, reject) => {
    const socket =
      options.path !== undefined
        ? net.connect(options.path)
        : net.connect(options.port ?? 0, options.hostname ?? "127.0.0.1");
    socket.once("connect", () => resolve({ close: () => socket.destroy() }));
    socket.once("error", (error) => reject(error));
  });
}

let activeServer: ReturnType<typeof Bun.serve> | null = null;

function upgradeWebSocket(req: Request, options?: { protocol?: string }) {
  const server = activeServer;
  if (server === null) {
    throw new Error(
      "Deno.upgradeWebSocket was called outside a Deno.serve handler",
    );
  }
  const socket = new DenoSocket(req.url, options?.protocol ?? "");
  const upgraded = server.upgrade(req, {
    data: { __denoSocket: socket },
    ...(options?.protocol
      ? { headers: { "Sec-WebSocket-Protocol": options.protocol } }
      : {}),
  } as Parameters<typeof server.upgrade>[1]);
  if (!upgraded) {
    return {
      response: new Response("WebSocket upgrade failed", { status: 400 }),
      socket,
    };
  }
  return { response: new Response(null, { status: 101 }), socket };
}

/** Deno.serve on Bun.serve: enough for the HTTP paths the suite exercises.
 * WebSocket upgrades still throw (see upgradeWebSocket). */
function denoServe(
  arg1:
    | { hostname?: string; port?: number; onListen?: (addr: unknown) => void }
    | ((req: Request) => Response | Promise<Response>),
  arg2?: (req: Request) => Response | Promise<Response>,
) {
  const options = typeof arg1 === "function" ? {} : arg1;
  const handler = typeof arg1 === "function" ? arg1 : arg2!;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const holder: { server: ReturnType<typeof Bun.serve> | null } = {
    server: null,
  };
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(req) {
      const previous = activeServer;
      activeServer = holder.server;
      try {
        return await handler(req);
      } catch (error) {
        console.error("deno-shim: handler threw", error);
        return new Response("Internal Server Error", { status: 500 });
      } finally {
        activeServer = previous;
      }
    },
    websocket: {
      open(ws) {
        (ws.data as { __denoSocket?: DenoSocket }).__denoSocket?._attach(ws);
      },
      message(ws, message) {
        (ws.data as { __denoSocket?: DenoSocket }).__denoSocket?._message(
          message,
        );
      },
      close(ws, code, reason) {
        (ws.data as { __denoSocket?: DenoSocket }).__denoSocket?._close(
          code,
          reason,
        );
      },
    },
  });
  holder.server = server;
  const addr = {
    transport: "tcp",
    hostname: server.hostname,
    port: server.port,
  };
  options.onListen?.(addr);
  return {
    addr,
    shutdown: async () => {
      server.stop(true);
      finish();
    },
    finished,
    ref: () => {},
    unref: () => {},
  };
}

/** Deno's `build.os` names: "windows", "darwin", "linux" — not Node's
 * "win32". Several callers compare against "windows" (the binary suffix, the
 * ICU file, the Windows host), so the mapping belongs here, once. */
const platformOs = process.platform === "win32" ? "windows" : process.platform;
const arch =
  process.arch === "x64"
    ? "x86_64"
    : process.arch === "arm64"
      ? "aarch64"
      : process.arch;
const target =
  platformOs === "windows"
    ? `${arch}-pc-windows-msvc`
    : platformOs === "darwin"
      ? `${arch}-apple-darwin`
      : `${arch}-unknown-linux-gnu`;

const DenoShim = {
  build: {
    os: platformOs,
    arch,
    target,
    standalone:
      (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun
        ?.isStandaloneExecutable ?? false,
  },
  args: process.argv.slice(2),
  cwd: () => process.cwd(),
  execPath: () => process.execPath,
  exit: (code?: number) => process.exit(code),
  homedir: () => os.homedir(),
  env: {
    get: (key: string) => process.env[key],
    set: (key: string, value: string) => {
      process.env[key] = value;
    },
    delete: (key: string) => {
      delete process.env[key];
    },
    has: (key: string) => process.env[key] !== undefined,
    toObject: () => ({ ...process.env }) as Record<string, string>,
  },
  readTextFile: (p: string) => fsp.readFile(p, "utf8").catch(mapError),
  readTextFileSync: (p: string) => sync(() => fs.readFileSync(p, "utf8")),
  readFile: (p: string) => fsp.readFile(p).catch(mapError),
  readFileSync: (p: string) => sync(() => fs.readFileSync(p)),
  writeTextFile: (
    p: string,
    data: string,
    opts?: { append?: boolean; create?: boolean; mode?: number },
  ) =>
    fsp
      .writeFile(p, data, {
        flag: opts?.append ? "a" : "w",
        mode: opts?.mode,
      })
      .catch(mapError),
  writeTextFileSync: (p: string, data: string, opts?: { append?: boolean }) =>
    sync(() => fs.writeFileSync(p, data, { flag: opts?.append ? "a" : "w" })),
  writeFile: (p: string, data: Uint8Array) =>
    fsp.writeFile(p, data).catch(mapError),
  writeFileSync: (p: string, data: Uint8Array) =>
    sync(() => fs.writeFileSync(p, data)),
  mkdir: async (p: string, o?: { recursive?: boolean }) => {
    try {
      makeDir(p, o);
    } catch (error) {
      mapError(error);
    }
  },
  mkdirSync: (p: string, o?: { recursive?: boolean }) => {
    try {
      makeDir(p, o);
    } catch (error) {
      mapError(error);
    }
  },
  remove: (p: string, o?: { recursive?: boolean }) =>
    fsp
      .rm(p, { recursive: o?.recursive ?? false, force: false })
      .catch(mapError),
  removeSync: (p: string, o?: { recursive?: boolean }) =>
    fs.rmSync(p, { recursive: o?.recursive ?? false, force: false }),
  stat: (p: string) => fsp.stat(p).then(fileInfo).catch(mapError),
  statSync: (p: string) => {
    try {
      return fileInfo(fs.statSync(p));
    } catch (e) {
      mapError(e);
    }
  },
  lstat: (p: string) => fsp.lstat(p).then(fileInfo).catch(mapError),
  lstatSync: (p: string) => fileInfo(fs.lstatSync(p)),
  readDir: (p: string) => readDir(p),
  readDirSync,
  makeTempDir: tempDirAsync,
  makeTempDirSync: tempDir,
  makeTempFile: tempFileAsync,
  makeTempFileSync: tempFile,
  copyFile: (a: string, b: string) => fsp.copyFile(a, b).catch(mapError),
  rename: (a: string, b: string) => fsp.rename(a, b).catch(mapError),
  renameSync: (a: string, b: string) => sync(() => fs.renameSync(a, b)),
  realPath: (p: string) =>
    fsp.realpath(p).then(normalizeRealPath).catch(mapError),
  // `native` on Windows returns the long, canonical spelling of every
  // component. The JS implementation keeps the spelling it was given (an
  // 8.3 name such as RUNNER~1 stays short), which then fails a containment
  // check against a path the async call canonicalized.
  realPathSync: (p: string) =>
    sync(() => {
      const native = fs.realpathSync.native ?? fs.realpathSync;
      return normalizeRealPath(native(p));
    }),
  chmod: (p: string, mode: number) => fsp.chmod(p, mode).catch(mapError),
  symlink: (a: string, b: string) => fsp.symlink(a, b).catch(mapError),
  open: (p: string, o?: Parameters<typeof openFile>[1]) =>
    Promise.resolve(openFile(p, o)),
  openSync: openFile,
  SeekMode: { Start: 0, Current: 1, End: 2, START: 0, CURRENT: 1, END: 2 },
  Command: ShimCommand,
  errors: {
    NotFound: NotFoundError,
    AlreadyExists: AlreadyExistsError,
    PermissionDenied: PermissionDeniedError,
    NotCapable: NotCapableError,
    AddrInUse: AddrInUseError,
  },
  networkInterfaces: () => {
    const out = [];
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        out.push({
          name,
          address: info.address,
          netmask: info.netmask,
          family: info.family === "IPv4" ? "IPv4" : "IPv6",
          mac: info.mac,
          scopeid: (info as { scopeid?: number }).scopeid,
        });
      }
    }
    return out;
  },
  addSignalListener: (signal: string, handler: () => void) => {
    process.on(signal as NodeJS.Signals, handler);
  },
  kill: (pid: number, signal?: string) => {
    process.kill(pid, signal as NodeJS.Signals | undefined);
  },
  // Deno's signature is `(id: number)`; Bun's setTimeout hands back a timer
  // object with `unref()`, so the caller casts and this unrefs the object.
  unrefTimer: (id: number) => {
    const timer = id as unknown as { unref?: () => void };
    if (typeof timer === "object" && timer !== null) timer.unref?.();
  },
  stdin: {
    read: (_p: Uint8Array) => Promise.resolve(null),
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        Bun.stdin
          .stream()
          .pipeTo(
            new WritableStream({
              write(chunk) {
                controller.enqueue(chunk);
              },
              close() {
                controller.close();
              },
            }),
          )
          .catch(() => controller.close());
      },
    }),
  },
  stdout: {
    writeSync: (p: Uint8Array) => fs.writeSync(1, p),
    write: (p: Uint8Array) => Promise.resolve(process.stdout.write(p)),
  },
  stderr: {
    writeSync: (p: Uint8Array) => fs.writeSync(2, p),
    write: (p: Uint8Array) => Promise.resolve(process.stderr.write(p)),
  },
  serve: denoServe,
  listen: denoListen,
  connect: denoConnect,
  upgradeWebSocket,
  PointerValue: undefined,
  // A pointer value the shim can carry but not dereference: `dlopen` below
  // throws, so nothing reaches a call that would hand it to native code. The
  // Windows host uses these to parse and format window handles, which is all
  // that runs before `bun:ffi` replaces this (see the module header).
  UnsafePointer: {
    create: (value: bigint) => ({ value }),
    value: (pointer: { value: bigint }) => pointer.value,
    equals: (a: unknown, b: unknown) => a === b,
    of: () => null,
  },
  UnsafeCallback: undefined,
  dlopen: () => {
    throw new Error("Deno.dlopen is not available on Bun yet");
  },
};

// The `Deno` global stays: the test runner's `Deno.test` and the browser
// probe's expectations are written against it, and a window object that has
// it is part of the surface the app is developed against. Product code uses
// the named `runtime` export below instead of the global name.
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno = DenoShim;

/** Terminate the process. A declaration rather than `runtime.exit`: the
 * control-flow analysis ends a function after a call to a declaration that
 * returns `never`, but not after a property access (`runtime.exit()`), which
 * leaves the code after it "reachable" and every narrowing broken. */
export function exit(code?: number): never {
  return DenoShim.exit(code);
}

/** The runtime this app runs on: Deno's API shape, implemented on Bun.
 *
 * Typed as `typeof Deno` so call sites keep the signatures they were written
 * against: the object below is the implementation, and the parts of Deno's
 * surface it does not implement (FFI, mostly) are exactly the ones no caller
 * here reaches. */
export const runtime = DenoShim as unknown as typeof Deno;

// The types call sites name (`runtime.NetAddr` would need a type namespace;
// a named import per type keeps them ordinary). They are Deno's, because the
// shape is.
export type ChildProcess = Deno.ChildProcess;
export type Command = Deno.Command;
export type FsFile = Deno.FsFile;
export type NetAddr = Deno.NetAddr;
export type HttpServer<Addr extends Deno.Addr = Deno.NetAddr> =
  Deno.HttpServer<Addr>;
export type DirEntry = Deno.DirEntry;
export type NetworkInterfaceInfo = Deno.NetworkInterfaceInfo;
export type Listener = Deno.Listener;
export type ForeignLibraryInterface = Deno.ForeignLibraryInterface;
export type ForeignFunction = Deno.ForeignFunction;
export type DynamicLibrary<
  Symbols extends Record<string, Deno.ForeignFunction>,
> = Deno.DynamicLibrary<Symbols>;
export type UnsafeCallback = Deno.UnsafeCallback;
export type UnsafePointer = typeof Deno.UnsafePointer;
export type UnsafePointerView = Deno.UnsafePointerView;
export type PointerValue<T = unknown> = Deno.PointerValue<T>;
