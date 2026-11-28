/**
 * MCP servers that run inside a stella agent's machine.
 *
 * The MCP client is part of the server process, which runs on the host; an
 * agent's files, programs and network are inside its container. This module
 * closes that gap without publishing a port and without a second copy of the
 * MCP SDK inside the image:
 *
 * - a stdio server is started by 'podman exec', so its stdin/stdout are the
 *   pipe the client already speaks over;
 * - an HTTP server listening inside the machine is reached through a relay:
 *   a loopback listener here, one 'podman exec' per connection, and a tiny
 *   node program in the machine that copies bytes between its own stdin and
 *   a TCP connection to the target. The SDK then talks to the listener as if
 *   the server were local, which keeps TLS, SSE and keep-alive intact.
 *
 * Nothing here knows how to build the podman command line: that is the
 * caller's MachineRunner, because the VM module owns the container's name,
 * user and working directory (see vm/podman.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";

/** One process to spawn on the host that runs the command inside the
 * machine. */
export interface MachineProcessSpec {
  file: string;
  args: string[];
}

/** How to run a command inside the machine. Implemented beside the VM
 * module, which knows the container. */
export interface MachineRunner {
  process(
    command: readonly string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): MachineProcessSpec;
  /** Make the machine ready to run processes: a sleeping machine is woken
   * here, before the first spawn, because podman exec does not start a
   * stopped container. */
  ready?(): Promise<void>;
}

/** The program the relay runs inside the machine.
 *
 * It is passed with 'node -e', so the feature needs no new file in the
 * image and no image rebuild: every machine already carries Node (see the
 * Containerfile). Arguments are '<port> <host>'; stdin/stdout are the pipe
 * 'podman exec' gives us. A TLS server needs nothing special: the bytes are
 * copied as-is, so the client's TLS session ends at the server itself.
 */
export const MACHINE_RELAY_SCRIPT = [
  "const net=require('net');",
  "const port=Number(process.argv[1]);",
  "const host=process.argv[2]||'127.0.0.1';",
  "const sock=net.connect(port,host);",
  "sock.on('connect',()=>{process.stdin.pipe(sock);sock.pipe(process.stdout);});",
  "sock.on('error',()=>process.exit(1));",
  "sock.on('close',()=>process.exit(0));",
  "process.stdin.on('end',()=>sock.end());",
].join("");

/** The command line that runs one MCP server's stdio process inside the
 * machine. The config's cwd is a path in the machine, so it travels to
 * 'podman exec' rather than to the host's spawn. */
export function machineStdioCommand(
  runner: MachineRunner,
  config: {
    command: string;
    args: readonly string[];
    cwd?: string;
    env: Record<string, string>;
  },
): MachineProcessSpec {
  return runner.process([config.command, ...config.args], {
    env: config.env,
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  });
}

/** A loopback endpoint that stands in for 'target', which is reachable only
 * from inside the machine. */
export interface MachineRelay {
  /** The address the client should use: same scheme, path, query and
   * headers; this host and port. */
  url: URL;
  /** Stop listening and end every connection and relay process. */
  close(): Promise<void>;
}

/** Open the relay for one HTTP server. Throws when the port cannot be
 * parsed, which is a configuration error rather than a server failure. */
export async function startMachineRelay(
  runner: MachineRunner,
  target: URL,
): Promise<MachineRelay> {
  const port = target.port !== "" ? Number(target.port) : defaultPort(target);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Cannot relay " + target.href + ": no port to connect to");
  }
  const children = new Set<ChildProcess>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const spec = runner.process([
      "node",
      "-e",
      MACHINE_RELAY_SCRIPT,
      String(port),
      target.hostname,
    ]);
    const child = spawn(spec.file, spec.args, {
      // The relay process speaks only over its pipes; its own environment
      // and working directory are the container's, not this process's.
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.add(child);
    const drop = () => {
      // Killing the relay ends the podman exec client; the socket is then
      // useless, so it is destroyed rather than left half-open.
      if (!child.killed) child.kill("SIGTERM");
      socket.destroy();
    };
    socket.on("close", drop);
    socket.on("error", drop);
    child.on("error", drop);
    child.on("exit", () => {
      children.delete(child);
      if (!socket.destroyed) socket.end();
    });
    // A write after the child died raises EPIPE on the pipe, which must not
    // reach the process as an uncaught exception.
    child.stdin?.on("error", () => {});
    socket.pipe(child.stdin!);
    child.stdout!.pipe(socket);
    child.stdout!.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The MCP relay did not get a loopback port");
  }
  const url = new URL(target.href);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  let closed = false;
  return {
    url,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
      for (const child of children) {
        if (!child.killed) child.kill("SIGTERM");
      }
      children.clear();
    },
  };
}

function defaultPort(url: URL): number {
  return url.protocol === "https:" ? 443 : 80;
}
