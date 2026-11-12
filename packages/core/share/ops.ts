/**
 * What crosses the wire between the server and the computer that lent a
 * folder.
 *
 * The two sides are the same codebase but different machines, so the payloads
 * are JSON and the paths are GRANT-RELATIVE SEGMENTS, never absolute paths:
 * one machine's absolute path is not a path on the other (a Windows drive is
 * not a segment, and `/Users` means something else on Linux), and a join done
 * with the receiver's own rules is the only join that can be re-checked
 * against the grant's root there.
 *
 * The operation table is the {@link FileBackend} and {@link CommandRunner}
 * contracts written as data, so the host side can answer each call by calling
 * the very implementation code mode uses (`HostFileBackend`,
 * `HostCommandRunner`) and the server side translates without owning any
 * path rules of its own.
 */

import type { ShareHostInfo } from "../domain/share.ts";
import type { ShellRunResult } from "../tools/command-backend.ts";
import type {
  BackendDirEntry,
  BackendStat,
  LineRange,
  RangeReadResult,
} from "../tools/file-backend.ts";
import type { FolderGrant } from "./grant.ts";

/** Largest single read the wire carries. Bigger than any tool's own output
 * cap (so the tool's truncation note is what the model hits first) and small
 * enough that one frame of base64 stays well inside the transport's limit. */
export const MAX_SHARE_READ_BYTES = 4 * 1024 * 1024;

/** How long the server waits for one file operation before giving up on it.
 * The host is a local disk on the other end of a socket; a minute is a
 * wedged client, not a slow disk. */
export const SHARE_OP_TIMEOUT_MS = 60_000;

/** Extra time an `exec` gets beyond the command's own timeout, for the
 * process to die and its output to come back. */
export const SHARE_EXEC_GRACE_MS = 30_000;

/** One call's request and answer, per operation. The key is the operation
 * name, so a caller cannot ask for a shape the host does not answer. */
export interface ShareOpMap {
  stat: { req: { path: string[] }; res: BackendStat | null };
  readText: {
    req: { path: string[]; maxBytes: number };
    res: { text: string; size: number };
  };
  readHead: {
    req: { path: string[]; maxBytes: number };
    res: { base64: string; size: number };
  };
  readRanges: {
    req: { path: string[]; ranges: LineRange[] };
    res: RangeReadResult;
  };
  listDir: { req: { path: string[] }; res: BackendDirEntry[] };
  writeText: {
    req: { path: string[]; text: string; private: boolean };
    res: null;
  };
  removeFile: { req: { path: string[] }; res: null };
  exec: {
    req: {
      path: string[];
      command: string;
      timeoutSec: number;
      maxOutputChars: number;
      env?: Record<string, string>;
    };
    res: ShellRunResult;
  };
}

export type ShareOpName = keyof ShareOpMap;

/** A call: the operation name and that operation's request. */
export type ShareCall<K extends ShareOpName = ShareOpName> = {
  [P in K]: { op: P } & ShareOpMap[P]["req"];
}[K];

/** The answer to one call. Which member it is follows from the call's `op`;
 * the correlation happens at the transport (see {@link ShareTransport}), which
 * is the only place a decoded frame is trusted. */
export type ShareResult<K extends ShareOpName = ShareOpName> =
  ShareOpMap[K]["res"];

/** Runs one call on the computer that lent the folder. */
export interface ShareTransport {
  /**
   * Call `op` in the grant's folder. Rejects when the host answered with a
   * failure, the grant ended, or the call timed out; the rejection's message
   * is what the tool shows the model, so it must say what happened in words a
   * reader of the conversation understands.
   *
   * The operation name and its request are separate parameters so a caller
   * cannot pass one operation's shape under another's name: `ShareOpMap` ties
   * them together, and the transport joins them only where it builds the
   * frame.
   */
  call<K extends ShareOpName>(
    grantId: string,
    op: K,
    request: ShareOpMap[K]["req"],
    signal?: AbortSignal,
  ): Promise<ShareResult<K>>;
}

/** The first frame the lending app sends: who it is, and what it lends. */
export interface ShareHelloFrame {
  type: "hello";
  /** Identifies this app run, so a reconnect replaces the old connection
   * instead of appearing as a second computer. */
  clientId: string;
  host: ShareHostInfo;
  grants: FolderGrant[];
}

/** Everything the lending app sends. */
export type ShareHostFrame =
  | ShareHelloFrame
  | { type: "grants"; grants: FolderGrant[] }
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string };

/** Everything the server sends. */
export type ShareServerFrame =
  | { type: "op"; id: string; grant: string; call: ShareCall }
  | { type: "cancel"; id: string }
  | { type: "bye"; reason: string };

/** Decode one frame from the lending app, or undefined when it is not one of
 * ours. A socket is a boundary: a malformed frame must end as "this client
 * said something unusable", not as an exception in the server. */
export function parseHostFrame(text: string): ShareHostFrame | undefined {
  const value = decodeObject(text);
  if (value === undefined) return undefined;
  const type = value.type;
  if (type === "hello") {
    if (typeof value.clientId !== "string") return undefined;
    if (value.host === undefined || typeof value.host !== "object") {
      return undefined;
    }
    if (!Array.isArray(value.grants)) return undefined;
    return value as unknown as ShareHostFrame;
  }
  if (type === "grants") {
    return Array.isArray(value.grants)
      ? (value as unknown as ShareHostFrame)
      : undefined;
  }
  if (type === "result") {
    if (typeof value.id !== "string" || typeof value.ok !== "boolean") {
      return undefined;
    }
    return value as unknown as ShareHostFrame;
  }
  return undefined;
}

/** Decode one frame from the server, or undefined (the host's own view of the
 * same boundary). */
export function parseServerFrame(text: string): ShareServerFrame | undefined {
  const value = decodeObject(text);
  if (value === undefined) return undefined;
  if (value.type === "op") {
    if (
      typeof value.id !== "string" ||
      typeof value.grant !== "string" ||
      value.call === undefined ||
      typeof value.call !== "object"
    ) {
      return undefined;
    }
    return value as unknown as ShareServerFrame;
  }
  if (value.type === "cancel") {
    return typeof value.id === "string"
      ? (value as unknown as ShareServerFrame)
      : undefined;
  }
  if (value.type === "bye") {
    return typeof value.reason === "string"
      ? (value as unknown as ShareServerFrame)
      : undefined;
  }
  return undefined;
}

function decodeObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
