/**
 * The Bun globals the runtime shim uses. Deliberately hand-written and small:
 * pulling `@types/bun` in would also pull Node's global types, which disagree
 * with Deno's (a timer is a `Timeout`, `fetch` carries `preconnect`) and turn
 * every call site into a type error. This file declares only what is called.
 */
interface BunSocket {
  data: unknown;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  end(): void;
}

interface BunServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): void;
  upgrade(
    req: Request,
    options?: { data?: unknown; headers?: Record<string, string> },
  ): boolean;
}

interface BunListenServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

declare const Bun: {
  argv: string[];
  main: string;
  isStandaloneExecutable: boolean;
  gc(force: boolean): void;
  serve(options: {
    hostname?: string;
    port?: number;
    fetch(req: Request): Response | Promise<Response>;
    websocket?: {
      open(ws: BunSocket): void;
      message(ws: BunSocket, message: string | Uint8Array): void;
      close(ws: BunSocket, code: number, reason: string): void;
    };
  }): BunServer;
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
    /** `null` when the statement returned no row (Deno's `node:sqlite`
     * answered `undefined`; callers here use a truthiness check). */
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
