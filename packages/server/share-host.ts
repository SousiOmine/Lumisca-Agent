/**
 * The lending side: `lumisca-server share`.
 *
 * This is the process that actually touches the user's disk. The desktop shell
 * starts it, tells it which folders may be lent over its stdin, and it holds
 * one WebSocket to the server the window is showing. Every file read, write
 * and command the agent asks for arrives on that socket and is answered with
 * `HostFileBackend` and `HostCommandRunner` — the same implementations code
 * mode's own workspace uses, so the lent folder behaves like a workspace
 * folder on this machine and no OS-specific code is written twice.
 *
 * It is a separate process rather than part of the shell for two reasons: the
 * shell is Rust (the implementations above are not), and its life is the
 * loan's — quitting the app closes the stdin, the process exits, and every
 * grant is gone from the server with it (see core/share/hub.ts).
 *
 * Nothing here decides whether a folder may be lent. The shell does that (the
 * OS folder picker is the consent), and this process only lends what it is
 * told. A read-only loan is enforced here too, in the code that writes, so a
 * server bug cannot turn a read into a write.
 */
import { basename, join } from "node:path";
import {
  bytesToBase64,
  type FolderGrant,
  getShell,
  HostCommandRunner,
  HostFileBackend,
  parseServerFrame,
  Sandbox,
  type ShareCall,
  type ShareHostInfo,
  type ShareServerFrame,
  shareNameFrom,
} from "@lumisca/core";
import { runtime } from "../core/runtime/runtime.ts";

/** Largest file one read may return. Mirrors the server's ceiling (the two
 * are checked independently: the notebook is the one that would spend memory).
 * A file past it is refused with a note pointing at a line range. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** One folder the shell allows this process to lend. */
export interface LocalGrant {
  id: string;
  /** The conversation it was lent to (the server keys the loan by it). */
  sessionId: string;
  /** The folder on this machine, absolute. */
  path: string;
  write: boolean;
  exec: boolean;
  /** Epoch ms; the shell withdraws it by announcing a list without it, but the
   * value travels so the server can stop trusting a stale announcement. */
  expiresAt: number;
}

/** What the shell writes on this process's stdin, one JSON object per line. */
type LenderCommand =
  | { type: "hello"; url: string; token: string }
  | { type: "grants"; grants: LocalGrant[] };

export interface ShareHostOptions {
  /** Where connection trouble is reported (stderr in production). */
  log?: (line: string) => void;
  /** First reconnect delay; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

/** The lending process, as the shell (or a test) drives it. */
export interface ShareHostHandle {
  /** Apply one line the shell wrote. Unknown or malformed lines are ignored:
   * the shell's own version is this file's neighbour, and a bad line is a bug
   * worth surviving. */
  command(line: string): void;
  /** Stop lending: close the socket, stop reconnecting, kill running
   * commands. */
  close(): void;
}

/**
 * Start lending, following the shell's commands.
 *
 * The connection is opened lazily: a shell that starts this process before the
 * user lends anything pays nothing. The first `hello` and every later one
 * reconnects; a `grants` line is both the first word (it waits for the hello)
 * and every later change.
 */
export function createShareHost(
  options: ShareHostOptions = {},
): ShareHostHandle {
  const log = options.log ?? (() => {});
  const retryMs = options.retryMs ?? 500;
  const maxRetryMs = options.maxRetryMs ?? 30_000;
  const clientId = crypto.randomUUID();
  const host = describeHost();
  let endpoint: { url: string; token: string } | undefined;
  let grants: LocalGrant[] = [];
  let socket: WebSocket | undefined;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** The commands this process is running, so a `cancel` can kill one. */
  const running = new Map<string, AbortController>();
  /** One mount per grant id: the sandbox that holds the disk boundary. */
  const mounts = new Map<string, Mount>();
  let stopped = false;

  const send = (frame: unknown): void => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  };

  const announce = (): void => {
    send({ type: "grants", grants: announcement() });
  };

  const announcement = (): FolderGrant[] => {
    // Names are unique within this app's list; the server resolves collisions
    // with another computer's folders for the same conversation.
    const taken: string[] = [];
    return grants.map((grant) => {
      const name = shareNameFrom(grant.path, taken);
      taken.push(name);
      return { ...describeGrant(grant, host), name };
    });
  };

  const mountFor = (grantId: string): Mount => {
    const grant = grants.find((candidate) => candidate.id === grantId);
    if (grant === undefined) {
      throw new Error(
        "That folder is no longer lent: the user withdrew it from this computer",
      );
    }
    const cached = mounts.get(grant.id);
    if (cached !== undefined) return cached;
    const mount = new Mount(grant);
    mounts.set(grant.id, mount);
    return mount;
  };

  const handleOp = (id: string, grantId: string, call: ShareCall): void => {
    const controller = new AbortController();
    running.set(id, controller);
    const started = Date.now();
    // One line per call, in the shell's captured output: it is what explains a
    // loan after the fact (which folder, which operation, how it ended) to
    // someone who was not watching the conversation.
    const target = call.path.length === 0 ? "." : call.path.join("/");
    void (async () => {
      try {
        const mount = mountFor(grantId);
        const value = await runCall(mount, call, controller.signal);
        send({ type: "result", id, ok: true, value });
        log(`${call.op} ${target} ok (${Date.now() - started}ms)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "result", id, ok: false, error: message });
        log(`${call.op} ${target} failed: ${message}`);
      } finally {
        running.delete(id);
      }
    })();
  };

  const onFrame = (frame: ShareServerFrame): void => {
    switch (frame.type) {
      case "op":
        handleOp(frame.id, frame.grant, frame.call);
        return;
      case "cancel": {
        running.get(frame.id)?.abort();
        running.delete(frame.id);
        return;
      }
      case "bye":
        // The server is going away; keep the loans and try again (a restart
        // keeps nothing, so the next hello is what makes them exist again).
        log(`server said goodbye: ${frame.reason}`);
        socket?.close();
        return;
    }
  };

  const connect = (): void => {
    const target = endpoint;
    if (target === undefined || stopped) return;
    const url = new URL("/api/share/host", target.url);
    if (target.token !== "") url.searchParams.set("token", target.token);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let opened = false;
    const next = new WebSocket(url.toString());
    socket = next;
    next.onopen = () => {
      opened = true;
      attempt = 0;
      send({ type: "hello", clientId, host, grants: announcement() });
    };
    next.onmessage = (event) => {
      const frame = parseServerFrame(
        typeof event.data === "string" ? event.data : "",
      );
      if (frame === undefined) {
        log("ignoring an unusable frame from the server");
        return;
      }
      onFrame(frame);
    };
    next.onclose = () => {
      if (socket === next) socket = undefined;
      if (stopped) return;
      // A server that answered and then dropped (a restart, a sleeping
      // laptop) is worth retrying; one that never opened may be a wrong
      // address, and the backoff keeps that from becoming a loop of dials.
      scheduleReconnect(opened ? 0.2 : 1);
    };
    next.onerror = () => {
      // `onclose` follows, and the retry is decided there.
    };
  };

  const scheduleReconnect = (scale: number): void => {
    if (stopped || endpoint === undefined) return;
    if (retryTimer !== undefined) return;
    const delay = Math.min(maxRetryMs, retryMs * 2 ** attempt * scale);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  };

  /** Close a socket without letting its `onclose` decide anything: a
   * replaced socket's close is not the connection dropping, and scheduling a
   * retry from it would dial a SECOND connection beside the new one (the
   * server then sees the same app run twice and replaces itself). */
  const detach = (previous: WebSocket | undefined): void => {
    if (previous === undefined) return;
    previous.onopen = null;
    previous.onmessage = null;
    previous.onclose = null;
    previous.onerror = null;
    previous.close();
  };

  const restart = (): void => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const previous = socket;
    socket = undefined;
    detach(previous);
    attempt = 0;
    connect();
  };

  const applyGrants = (next: readonly LocalGrant[]): void => {
    grants = [...next];
    // The mounts are rebuilt rather than kept: a grant can come back with
    // different terms (writing taken away, the shell closed), and serving the
    // old terms would honour a loan the user already narrowed. An operation
    // already running keeps the mount it started with — it was allowed when
    // it began.
    mounts.clear();
    announce();
  };

  return {
    command(line: string): void {
      const parsed = parseCommand(line);
      if (parsed === undefined) return;
      if (parsed.type === "hello") {
        const same =
          endpoint?.url === parsed.url && endpoint?.token === parsed.token;
        endpoint = { url: parsed.url, token: parsed.token };
        if (!same) restart();
        return;
      }
      applyGrants(parsed.grants);
    },
    close(): void {
      stopped = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      for (const controller of running.values()) controller.abort();
      running.clear();
      const previous = socket;
      socket = undefined;
      detach(previous);
    },
  };
}

/**
 * Run the lending process for real: the shell's lines arrive on stdin, and the
 * process leaves when they stop (the shell exited, or closed the pipe).
 *
 * The exit is the contract the whole feature rests on: nothing on the server
 * keeps a loan, so a lender that outlived its shell would be the one thing
 * still holding the user's disk open after they quit the app.
 */
export async function runShareHost(): Promise<number> {
  const lender = createShareHost({
    log: (line) => console.error(`[share] ${line}`),
  });
  const decoder = new TextDecoder();
  let carry = "";
  try {
    for await (const chunk of process.stdin) {
      carry += decoder.decode(chunk as Uint8Array, { stream: true });
      let index = carry.indexOf("\n");
      while (index !== -1) {
        const line = carry.slice(0, index).trim();
        carry = carry.slice(index + 1);
        if (line !== "") lender.command(line);
        index = carry.indexOf("\n");
      }
    }
  } finally {
    lender.close();
  }
  return 0;
}

/** One lent folder, ready to serve: the backend whose sandbox is the folder
 * itself, and the platform shell commands run in. */
export class Mount {
  readonly files: HostFileBackend;
  readonly runner = new HostCommandRunner();

  constructor(readonly grant: LocalGrant) {
    this.files = new HostFileBackend(new Sandbox([grant.path]));
  }

  /** The absolute path of a grant-relative request, or a refusal when it
   * escapes the folder. Both ends check this: the server's path arithmetic
   * is not trusted with this machine's disk. */
  async absolute(segments: readonly string[]): Promise<string> {
    const joined = join(this.grant.path, ...segments);
    const resolved = await this.files.resolve(joined);
    if (!resolved.ok) throw new Error(resolved.reason);
    return resolved.path;
  }

  requireWrite(): void {
    if (this.grant.write) return;
    throw new Error(
      `${this.grant.path} was lent read-only: the agent may read it, not ` +
        "change it",
    );
  }
}

/** Answer one call in the folder. Throws with the sentence the model reads. */
export async function runCall(
  mount: Mount,
  call: ShareCall,
  signal?: AbortSignal,
): Promise<unknown> {
  const path = await mount.absolute(call.path);
  const name = basenameAllowingRoot(path);
  switch (call.op) {
    case "stat":
      return (await mount.files.stat(path)) ?? null;
    case "readText": {
      const stat = await mount.files.stat(path);
      if (stat === undefined) throw new Error(`Path does not exist: ${name}`);
      if (!stat.isFile) throw new Error(`Is a directory: ${name}`);
      if (stat.size > call.maxBytes) {
        throw new Error(
          `${name} is ${Math.ceil(stat.size / 1024)}KB, more than one read ` +
            "may return: read it with a line range instead",
        );
      }
      return { text: await mount.files.readText(path), size: stat.size };
    }
    case "readHead": {
      const head = await mount.files.readHead(
        path,
        Math.min(call.maxBytes, MAX_READ_BYTES),
      );
      return { base64: bytesToBase64(head.bytes), size: head.size };
    }
    case "readRanges":
      return await mount.files.readRanges(path, call.ranges);
    case "listDir":
      return await mount.files.listDir(path);
    case "writeText":
      mount.requireWrite();
      await mount.files.writeText(path, call.text, { private: call.private });
      return null;
    case "removeFile":
      mount.requireWrite();
      await mount.files.removeFile(path);
      return null;
    case "exec": {
      if (!mount.grant.exec) {
        throw new Error(
          `${mount.grant.path} was lent without command access: the file ` +
            "tools can read and change it, but commands cannot run there",
        );
      }
      return await mount.runner.run(call.command, {
        cwd: path,
        timeoutSec: call.timeoutSec,
        maxOutputChars: call.maxOutputChars,
        ...(call.env === undefined ? {} : { env: call.env }),
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }
}

/** How this computer names itself to the model and the UI. */
export function describeHost(): ShareHostInfo {
  const os = runtime.build.os;
  const platform =
    os === "darwin" ? "macos" : os === "windows" ? "windows" : "linux";
  const name =
    runtime.env.get("COMPUTERNAME") ?? runtime.env.get("HOSTNAME") ?? platform;
  // The shell a command actually reaches, named for the model: PowerShell 7
  // and `sh` are not interchangeable command languages.
  const shell = basename(getShell().file).replace(/\.exe$/i, "");
  return { platform, name, shell };
}

/** The grant announcement of one local folder, without its name (the caller
 * numbers duplicates). */
function describeGrant(
  grant: LocalGrant,
  host: ShareHostInfo,
): Omit<FolderGrant, "name"> {
  return {
    id: grant.id,
    sessionId: grant.sessionId,
    path: grant.path,
    host,
    write: grant.write,
    exec: grant.exec,
    expiresAt: grant.expiresAt,
  };
}

/** One line from the shell, or undefined when it is not one of ours. */
function parseCommand(line: string): LenderCommand | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "hello") {
    if (typeof record.url !== "string" || record.url === "") return undefined;
    return {
      type: "hello",
      url: record.url,
      token: typeof record.token === "string" ? record.token : "",
    };
  }
  if (record.type === "grants") {
    const grants = Array.isArray(record.grants)
      ? record.grants
          .map((entry) => parseLocalGrant(entry))
          .filter((grant): grant is LocalGrant => grant !== undefined)
      : [];
    return { type: "grants", grants };
  }
  return undefined;
}

function parseLocalGrant(value: unknown): LocalGrant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id === "" ||
    typeof record.sessionId !== "string" ||
    record.sessionId === "" ||
    typeof record.path !== "string" ||
    record.path === "" ||
    typeof record.write !== "boolean" ||
    typeof record.exec !== "boolean" ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    path: record.path,
    write: record.write,
    exec: record.exec,
    expiresAt: record.expiresAt,
  };
}

/** The last segment of a path for a message, or the path itself at a root. */
function basenameAllowingRoot(path: string): string {
  const name = basename(path);
  return name === "" || name === path ? path : name;
}
