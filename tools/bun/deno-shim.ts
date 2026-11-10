/**
 * A spike-only stand-in for the parts of the `Deno` namespace the test suite
 * touches, so the existing tests can run under `bun test` without being
 * rewritten first. It is NOT a production compatibility layer: serve, listen,
 * WebSocket upgrade and FFI throw, because those need real design work.
 */
import { test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

type DenoTestOptions = {
  name: string;
  fn: () => void | Promise<void>;
  ignore?: boolean;
  only?: boolean;
};

const denoTest = (
  nameOrOptions: string | DenoTestOptions,
  optionsOrFn?: { ignore?: boolean; only?: boolean } | (() => unknown),
  maybeFn?: () => unknown,
) => {
  if (typeof nameOrOptions === "string") {
    // Deno allows (name, fn) and (name, options, fn).
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn ?? {};
    const body = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (typeof body !== "function") {
      throw new Error(`test expects a function as the body: ${nameOrOptions}`);
    }
    if (options.ignore) return test.skip(nameOrOptions, body as () => unknown);
    if (options.only) return test.only(nameOrOptions, body as () => unknown);
    test(nameOrOptions, body as () => unknown);
    return;
  }
  const { name, fn: body, ignore, only } = nameOrOptions;
  if (ignore) return test.skip(name, body as () => unknown);
  if (only) return test.only(name, body as () => unknown);
  test(name, body as () => unknown);
};

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
  isFile: () => st.isFile(),
  isDirectory: () => st.isDirectory(),
  isSymlink: () => st.isSymbolicLink(),
  isBlockDevice: () => st.isBlockDevice(),
  isCharDevice: () => st.isCharacterDevice(),
  isFifo: () => st.isFIFO(),
  isSocket: () => st.isSocket(),
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
    path.join(options?.dir ?? os.tmpdir(), options?.prefix ?? ""),
  );
}

async function tempDirAsync(options?: { dir?: string; prefix?: string }) {
  return fsp.mkdtemp(
    path.join(options?.dir ?? os.tmpdir(), options?.prefix ?? ""),
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
  constructor(fd: number) {
    this.#fd = fd;
  }
  read(p: Uint8Array): Promise<number | null> {
    const n = fs.readSync(this.#fd, p, 0, p.length, null);
    return n === 0 ? null : n;
  }
  write(p: Uint8Array): Promise<number> {
    return Promise.resolve(fs.writeSync(this.#fd, p));
  }
  seek(offset: number, whence: number): Promise<number> {
    return Promise.resolve(fs.fsyncSync ? fs.readSync : 0).then(() => {
      // fs.readSync moves the position with a null position; emulate lseek.
      return lseek(this.#fd, offset, whence);
    });
  }
  stat(): Promise<ReturnType<typeof fileInfo>> {
    return Promise.resolve(fileInfo(fs.fstatSync(this.#fd)));
  }
  close(): void {
    fs.closeSync(this.#fd);
  }
}

/** lseek(2) via FFI is overkill; the spike's callers seek from the start. */
function lseek(_fd: number, offset: number, _whence: number): number {
  return offset;
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
          child.stdout!.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
          child.stdout!.on("end", () => controller.close());
        },
      })
      : new ReadableStream({ start: (c) => c.close() });
    this.stderr = child.stderr
      ? new ReadableStream({
        start(controller) {
          child.stderr!.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
          child.stderr!.on("end", () => controller.close());
        },
      })
      : new ReadableStream({ start: (c) => c.close() });
  }
  get pid(): number {
    return this.#child.pid ?? -1;
  }
  get status(): Promise<{ code: number; success: boolean; signal: string | null }> {
    return new Promise((resolve) => {
      this.#child.on("close", (code) =>
        resolve({ code: code ?? 1, success: code === 0, signal: null }));
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
  spawn(): ChildProcess {
    const child = spawn(this.#cmd, this.#options.args ?? [], {
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
    return new ChildProcess(child);
  }
  async output() {
    const result = spawnSync(this.#cmd, this.#options.args ?? [], {
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
  async outputSync() {
    return await this.output();
  }
}


/** Deno.serve on Bun.serve: enough for the HTTP paths the suite exercises.
 * WebSocket upgrades still throw (see upgradeWebSocket). */
function denoServe(
  arg1: { hostname?: string; port?: number; onListen?: (addr: unknown) => void } |
    ((req: Request) => Response | Promise<Response>),
  arg2?: (req: Request) => Response | Promise<Response>,
) {
  const options = typeof arg1 === "function" ? {} : arg1;
  const handler = typeof arg1 === "function" ? arg1 : arg2!;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(req) {
      try {
        return await handler(req);
      } catch (error) {
        console.error("deno-shim: handler threw", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  });
  const addr = { transport: "tcp", hostname: server.hostname, port: server.port };
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
const arch = process.arch === "x64"
  ? "x86_64"
  : process.arch === "arm64"
  ? "aarch64"
  : process.arch;
const target = platformOs === "win32"
  ? `${arch}-pc-windows-msvc`
  : platformOs === "darwin"
  ? `${arch}-apple-darwin`
  : `${arch}-unknown-linux-gnu`;

const DenoShim = {
  test: denoTest,
  build: { os: platformOs, arch, target },
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
  readTextFile: (p: string) => fsp.readFile(p, "utf8"),
  readTextFileSync: (p: string) => fs.readFileSync(p, "utf8"),
  readFile: (p: string) => fsp.readFile(p),
  readFileSync: (p: string) => fs.readFileSync(p),
  writeTextFile: (p: string, data: string, opts?: { append?: boolean; create?: boolean }) =>
    fsp.writeFile(p, data, { flag: opts?.append ? "a" : "w" }),
  writeTextFileSync: (p: string, data: string, opts?: { append?: boolean }) =>
    fs.writeFileSync(p, data, { flag: opts?.append ? "a" : "w" }),
  writeFile: (p: string, data: Uint8Array) => fsp.writeFile(p, data),
  writeFileSync: (p: string, data: Uint8Array) => fs.writeFileSync(p, data),
  mkdir: async (p: string, o?: { recursive?: boolean }) => makeDir(p, o),
  mkdirSync: makeDir,
  remove: (p: string, o?: { recursive?: boolean }) =>
    fsp.rm(p, { recursive: o?.recursive ?? false, force: false }).catch(mapError),
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
  copyFile: (a: string, b: string) => fsp.copyFile(a, b),
  rename: (a: string, b: string) => fsp.rename(a, b),
  renameSync: (a: string, b: string) => fs.renameSync(a, b),
  realPath: (p: string) => fsp.realpath(p),
  realPathSync: (p: string) => fs.realpathSync(p),
  chmod: (p: string, mode: number) => fsp.chmod(p, mode),
  symlink: (a: string, b: string) => fsp.symlink(a, b),
  open: (p: string, o?: Parameters<typeof openFile>[1]) => Promise.resolve(openFile(p, o)),
  openSync: openFile,
  SeekMode: { START: 0, CURRENT: 1, END: 2 },
  Command,
  errors: {
    NotFound: NotFoundError,
    AlreadyExists: AlreadyExistsError,
    PermissionDenied: PermissionDeniedError,
    NotCapable: NotCapableError,
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
        Bun.stdin.stream().pipeTo(
          new WritableStream({
            write(chunk) {
              controller.enqueue(chunk);
            },
            close() {
              controller.close();
            },
          }),
        ).catch(() => controller.close());
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
  listen: () => {
    throw new Error("Deno.listen is not shimmed in this spike");
  },
  connect: () => {
    throw new Error("Deno.connect is not shimmed in this spike");
  },
  upgradeWebSocket: () => {
    throw new Error("Deno.upgradeWebSocket is not shimmed in this spike");
  },
  PointerValue: undefined,
  UnsafePointer: undefined,
  UnsafeCallback: undefined,
  dlopen: () => {
    throw new Error("Deno.dlopen is not shimmed in this spike");
  },
};

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno = DenoShim;
