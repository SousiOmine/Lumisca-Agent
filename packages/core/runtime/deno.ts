/// <reference path="../../../types/bun.d.ts" />
/**
 * The `Deno` surface this app actually uses, implemented on Bun and Node.
 *
 * The server was written for Deno. Bun has no `Deno` namespace, so this
 * module installs one: file system, process, Command, serve (HTTP and
 * WebSocket) and the small pieces around them. It is the migration seam —
 * nothing below calls into the Deno runtime — and the server imports it
 * before anything else, so the packaged binary carries it too.
 *
 * FFI (`dlopen`) is still Deno-only and throws here; the Windows computer
 * host is the one caller and needs `bun:ffi` before that platform can move.
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

class FsFile {
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
  },
): FsFile {
  let flags = 0;
  const read = options?.read ?? true;
  const write = options?.write ?? false;
  if (read && write) flags = fs.constants.O_RDWR;
  else if (write) flags = fs.constants.O_WRONLY;
  else flags = fs.constants.O_RDONLY;
  if (options?.create) flags |= fs.constants.O_CREAT;
  if (options?.truncate) flags |= fs.constants.O_TRUNC;
  if (options?.append) flags |= fs.constants.O_APPEND;
  return new FsFile(fs.openSync(pathname, flags));
}

type CommandOptions = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "null" | "inherit" | "piped";
  stdout?: "null" | "inherit" | "piped";
  stderr?: "null" | "inherit" | "piped";
  signal?: AbortSignal;
};

class ChildProcess {
  #child: ReturnType<typeof spawn>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  constructor(child: ReturnType<typeof spawn>) {
    this.#child = child;
    this.stdout = child.stdout
      ? new ReadableStream({
          start(controller) {
            child.stdout!.on("data", (chunk) =>
              controller.enqueue(new Uint8Array(chunk)),
            );
            child.stdout!.on("end", () => controller.close());
          },
        })
      : new ReadableStream({ start: (c) => c.close() });
    this.stderr = child.stderr
      ? new ReadableStream({
          start(controller) {
            child.stderr!.on("data", (chunk) =>
              controller.enqueue(new Uint8Array(chunk)),
            );
            child.stderr!.on("end", () => controller.close());
          },
        })
      : new ReadableStream({ start: (c) => c.close() });
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
  get status(): Promise<{
    code: number;
    success: boolean;
    signal: string | null;
  }> {
    return new Promise((resolve) => {
      this.#child.on("close", (code) =>
        resolve({ code: code ?? 1, success: code === 0, signal: null }),
      );
    });
  }
  kill(signal?: string): void {
    this.#child.kill(signal as NodeJS.Signals | undefined);
  }
  ref(): void {}
  unref(): void {}
}

class Command {
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
  spawn(): ChildProcess {
    const child = spawn(this.#cmd, this.#args(), {
      cwd: this.#options.cwd,
      env: this.#options.env ?? process.env,
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
    return new ChildProcess(child);
  }
  outputSync() {
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
    this.onopen?.(new Event("open"));
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

const platformOs = process.platform;
const arch =
  process.arch === "x64"
    ? "x86_64"
    : process.arch === "arm64"
      ? "aarch64"
      : process.arch;
const target =
  platformOs === "win32"
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
  realPath: (p: string) => fsp.realpath(p).catch(mapError),
  realPathSync: (p: string) => sync(() => fs.realpathSync(p)),
  chmod: (p: string, mode: number) => fsp.chmod(p, mode).catch(mapError),
  symlink: (a: string, b: string) => fsp.symlink(a, b).catch(mapError),
  open: (p: string, o?: Parameters<typeof openFile>[1]) =>
    Promise.resolve(openFile(p, o)),
  openSync: openFile,
  SeekMode: { Start: 0, Current: 1, End: 2, START: 0, CURRENT: 1, END: 2 },
  Command,
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
  unrefTimer: (_id: number) => {},
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
  UnsafePointer: undefined,
  UnsafeCallback: undefined,
  dlopen: () => {
    throw new Error("Deno.dlopen is not shimmed in this spike");
  },
};

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno = DenoShim;
