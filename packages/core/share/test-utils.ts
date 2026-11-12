/**
 * Test fixtures for the share module: a grant, a backend that records its
 * calls, and a transport that answers them from a switch.
 *
 * Test-only (like `packages/web/src/api-test-utils.ts`): no production module
 * imports this. It exists so the three tests below state their own case
 * instead of repeating twelve lines of plumbing, and so the fake transport
 * keeps the `ShareOpMap` tie between an operation and its request — a fixture
 * that answered the wrong shape would make the tests agree with a bug.
 */
import { bytesToBase64 } from "../base64.ts";
import type {
  BackendDirEntry,
  BackendStat,
  FileBackend,
  LineRange,
  RangeReadResult,
} from "../tools/file-backend.ts";
import type { ResolvedPath } from "../workspace/sandbox.ts";
import type { FolderGrant } from "./grant.ts";
import type {
  ShareCall,
  ShareOpMap,
  ShareOpName,
  ShareTransport,
} from "./ops.ts";

/** A grant with sane defaults; override what the test is about. */
export function grantOf(overrides: Partial<FolderGrant> = {}): FolderGrant {
  return {
    id: "g1",
    sessionId: "s1",
    name: "proj",
    path: "/Users/me/proj",
    host: { platform: "macos", name: "mac", shell: "zsh" },
    write: true,
    exec: false,
    expiresAt: Date.now() + 60 * 60_000,
    ...overrides,
  };
}

/** A transport that records every call and answers from `answer`. */
export class RecordingTransport implements ShareTransport {
  readonly calls: { grantId: string; call: ShareCall }[] = [];

  constructor(
    private readonly answer: (call: ShareCall) => unknown = () => null,
  ) {}

  async call<K extends ShareOpName>(
    grantId: string,
    op: K,
    request: ShareOpMap[K]["req"],
    _signal?: AbortSignal,
  ): Promise<ShareOpMap[K]["res"]> {
    const call = { op, ...request } as unknown as ShareCall;
    this.calls.push({ grantId, call });
    return this.answer(call) as ShareOpMap[K]["res"];
  }

  last(): ShareCall | undefined {
    return this.calls[this.calls.length - 1]?.call;
  }
}

/** The file backend of the session's own machine: records calls, and refuses
 * what a real one would refuse (a path outside its roots). */
export class FakeBackend implements FileBackend {
  readonly roots: readonly string[];
  readonly calls: { op: string; path: string }[] = [];
  /** Paths this backend claims to own, besides its roots. */
  readonly files = new Map<string, string>();

  constructor(roots: readonly string[] = ["/home/agent"]) {
    this.roots = roots;
  }

  add(path: string, text = "primary"): void {
    this.files.set(path, text);
  }

  resolve(requested: string): Promise<ResolvedPath> {
    const path = requested.startsWith("/")
      ? requested
      : `${this.roots[0]}/${requested}`;
    const inside = this.roots.some(
      (root) => path === root || path.startsWith(`${root}/`),
    );
    return Promise.resolve(
      inside
        ? { ok: true, path }
        : { ok: false, reason: `Path is outside the workspace: ${requested}` },
    );
  }

  stat(path: string): Promise<BackendStat | undefined> {
    this.calls.push({ op: "stat", path });
    return Promise.resolve(
      this.files.has(path) ? { isFile: true, size: 7 } : undefined,
    );
  }

  readText(path: string): Promise<string> {
    this.calls.push({ op: "readText", path });
    return Promise.resolve(this.files.get(path) ?? "");
  }

  readHead(
    path: string,
    _maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }> {
    this.calls.push({ op: "readHead", path });
    const text = this.files.get(path) ?? "";
    return Promise.resolve({
      bytes: new TextEncoder().encode(text),
      size: text.length,
    });
  }

  readRanges(
    path: string,
    _ranges: readonly LineRange[],
  ): Promise<RangeReadResult> {
    this.calls.push({ op: "readRanges", path });
    return Promise.resolve({
      lines: [],
      endOfFile: true,
      lastLine: 0,
      droppedLines: 0,
      truncatedTail: false,
    });
  }

  readBytes(path: string, offset: number, length: number): Promise<Uint8Array> {
    this.calls.push({ op: "readBytes", path });
    const bytes = new TextEncoder().encode(this.files.get(path) ?? "");
    return Promise.resolve(bytes.slice(offset, offset + length));
  }

  writeBytes(
    path: string,
    bytes: Uint8Array,
    options: { private?: boolean; append?: boolean } = {},
  ): Promise<void> {
    this.calls.push({ op: "writeBytes", path });
    const text = new TextDecoder().decode(bytes);
    const before = options.append === true ? (this.files.get(path) ?? "") : "";
    this.files.set(path, before + text);
    return Promise.resolve();
  }

  writeText(path: string, text: string): Promise<void> {
    this.calls.push({ op: "writeText", path });
    this.files.set(path, text);
    return Promise.resolve();
  }

  removeFile(path: string): Promise<void> {
    this.calls.push({ op: "removeFile", path });
    this.files.delete(path);
    return Promise.resolve();
  }

  listDir(path: string): Promise<BackendDirEntry[]> {
    this.calls.push({ op: "listDir", path });
    return Promise.resolve(
      [...this.files.keys()]
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => ({
          name: file.slice(path.length + 1),
          isDirectory: false,
          isSymlink: false,
        })),
    );
  }
}

/** The answers a lent computer gives: one small file, one directory. */
export function answerOf(call: ShareCall): unknown {
  switch (call.op) {
    case "stat":
      return { isFile: true, size: 3 };
    case "readText":
      return { text: "lent", size: 4 };
    case "readHead":
      return {
        base64: bytesToBase64(new TextEncoder().encode("lent")),
        size: 4,
      };
    case "readBytes":
      return { base64: bytesToBase64(new TextEncoder().encode("lent")) };
    case "readRanges":
      return {
        lines: ["one"],
        endOfFile: false,
        lastLine: 9,
        droppedLines: 0,
        truncatedTail: false,
      };
    case "listDir":
      return [{ name: "src", isDirectory: true, isSymlink: false }];
    case "writeText":
    case "writeBytes":
    case "removeFile":
      return null;
    case "exec":
      return {
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 3,
        timedOut: false,
        orphanedOutput: false,
      };
  }
}
