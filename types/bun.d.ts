/**
 * The Bun globals the app uses. Deliberately hand-written and small: pulling
 * `@types/bun` in would also pull a second copy of Node's global types and
 * turn every call site into a type error. This file declares only what is
 * called.
 */
interface BunSocket<Data = unknown> {
  data: Data;
  readyState: 0 | 1 | 2 | 3;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  end(): void;
}

interface BunServer<Data = unknown> {
  hostname: string;
  port: number;
  url: URL;
  stop(closeActiveConnections?: boolean): void;
  upgrade(
    req: Request,
    options?: { data?: Data; headers?: Record<string, string> },
  ): boolean;
}

interface BunListenServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

interface BunFileSink {
  write(data: string | Uint8Array): number | Promise<number>;
  flush(): Promise<number>;
  end(error?: Error): Promise<number>;
  close(): Promise<number>;
}

interface BunSubprocess {
  readonly pid: number;
  readonly stdin: BunFileSink;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: string | number): void;
  ref(): void;
  unref(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

interface BunSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "pipe" | "ignore" | "inherit";
  stdout?: "pipe" | "ignore" | "inherit";
  stderr?: "pipe" | "ignore" | "inherit";
  signal?: AbortSignal;
}

interface BunSpawnSyncResult {
  exitCode: number;
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface BunFile {
  size: number;
  type: string;
  exists(): Promise<boolean>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
}

declare namespace Bun {
  type Subprocess = BunSubprocess;
  type Server<Data = unknown> = BunServer<Data>;
  type Socket<Data = unknown> = BunSocket<Data>;
  type FileSink = BunFileSink;
}

declare const Bun: {
  argv: string[];
  main: string;
  version: string;
  isStandaloneExecutable: boolean;
  gc(force: boolean): void;
  file(path: string): BunFile;
  write(
    destination: string | BunFile,
    data: string | Uint8Array | ArrayBuffer | Blob | Response,
  ): Promise<number>;
  spawn(command: string[], options?: BunSpawnOptions): BunSubprocess;
  spawnSync(command: string[], options?: BunSpawnOptions): BunSpawnSyncResult;
  serve<Data = unknown>(options: {
    hostname?: string;
    port?: number;
    fetch(req: Request, server: BunServer<Data>): Response | Promise<Response>;
    websocket?: {
      open?(ws: BunSocket<Data>): void;
      message?(ws: BunSocket<Data>, message: string | Uint8Array): void;
      close?(ws: BunSocket<Data>, code: number, reason: string): void;
    };
    error?(error: Error): Response | Promise<Response>;
  }): BunServer<Data>;
  listen(options: {
    hostname?: string;
    port?: number;
    socket: {
      data(socket: BunSocket): void;
      open(socket: BunSocket): void;
    };
  }): BunListenServer;
  stdin: { stream(): ReadableStream<Uint8Array> };
};

/** The pieces of `bun:ffi` the Windows computer host uses. Bun ships its own
 * types in `bun-types`, which this project does not install (see the top of
 * this file), so only the calls that are made are declared. */
declare module "bun:ffi" {
  export const FFIType: {
    void: number;
    bool: number;
    u8: number;
    i8: number;
    u16: number;
    i16: number;
    u32: number;
    i32: number;
    u64: number;
    i64: number;
    usize: number;
    isize: number;
    f32: number;
    f64: number;
    ptr: number;
    buffer: number;
    cstring: number;
  };
  export interface ForeignSymbol {
    args: number[];
    returns: number;
  }
  export interface Library {
    symbols: Record<string, (...args: never[]) => unknown>;
    close(): void;
  }
  export function dlopen(
    path: string,
    symbols: Record<string, ForeignSymbol>,
  ): Library;
  export function toArrayBuffer(
    pointer: number,
    byteOffset?: number,
    byteLength?: number,
  ): ArrayBuffer;
  export class JSCallback {
    constructor(
      fn: (...args: never[]) => unknown,
      options?: { args?: number[]; returns?: number },
    );
    readonly ptr: number;
    close(): void;
  }
}

/** The pieces of `bun:sqlite` the database layer uses. Like `bun:ffi`, Bun's
 * own types (`bun-types`) are not installed, so only the calls that are made
 * are declared. */
declare module "bun:sqlite" {
  export type SQLQueryBindings =
    | string
    | number
    | bigint
    | boolean
    | null
    | Uint8Array;

  export type SQLOutputValue = string | number | bigint | Uint8Array | null;

  export interface Changes {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export class Statement<
    Row extends Record<string, SQLOutputValue> = Record<string, SQLOutputValue>,
  > {
    run(...params: SQLQueryBindings[]): Changes;
    /** `null` when the statement returned no row; callers use a
     * truthiness check. */
    get(...params: SQLQueryBindings[]): Row | null;
    all(...params: SQLQueryBindings[]): Row[];
    iterate(...params: SQLQueryBindings[]): IterableIterator<Row>;
    finalize(): void;
    readonly columnNames: string[];
    readonly paramsCount: number;
  }

  export class Database {
    constructor(
      filename?: string,
      options?: {
        readonly?: boolean;
        create?: boolean;
        readwrite?: boolean;
        strict?: boolean;
      },
    );
    prepare<
      Row extends Record<string, SQLOutputValue> = Record<
        string,
        SQLOutputValue
      >,
    >(sql: string): Statement<Row>;
    exec(sql: string): void;
    close(throwOnError?: boolean): void;
  }
}

declare module "bun:test" {
  type TestFn = (done?: (error?: unknown) => void) => void | Promise<void>;
  type TestOptions = { timeout?: number; retry?: number; skip?: boolean };

  interface TestApi {
    (name: string, fn: TestFn, options?: TestOptions): void;
    (name: string, options: TestOptions, fn: TestFn): void;
    skip(name: string, fn: TestFn): void;
    skip(name: string, options: TestOptions, fn: TestFn): void;
    only(name: string, fn: TestFn, options?: TestOptions): void;
    skipIf(
      condition: unknown,
    ): (name: string, fn: TestFn, options?: TestOptions) => void;
  }

  export const test: TestApi;
  export const describe: TestApi;
  export function beforeAll(fn: TestFn, options?: TestOptions): void;
  export function afterAll(fn: TestFn, options?: TestOptions): void;
  export function beforeEach(fn: TestFn, options?: TestOptions): void;
  export function afterEach(fn: TestFn, options?: TestOptions): void;
}
