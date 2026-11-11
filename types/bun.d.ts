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
