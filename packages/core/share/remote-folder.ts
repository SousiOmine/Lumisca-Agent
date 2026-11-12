/**
 * The {@link FileBackend} of a folder that lives on the user's computer.
 *
 * Every method is one call on the wire (see share/ops.ts). This side owns the
 * namespace rules — what `/lend/<name>/x` means, which paths are inside the
 * grant, and whether the grant allows a write — and nothing about the disk:
 * the lent computer joins the segments with its own rules and re-checks them
 * inside its own sandbox before touching a file, so both ends hold the
 * boundary and neither trusts the other's path arithmetic.
 */
import { posix } from "node:path";
import { base64ToBytes } from "../base64.ts";
import type {
  BackendDirEntry,
  BackendStat,
  FileBackend,
  LineRange,
  RangeReadResult,
} from "../tools/file-backend.ts";
import type { ResolvedPath } from "../workspace/sandbox.ts";
import type { FolderGrant } from "./grant.ts";
import {
  isWithinShare,
  relativeSegments,
  SHARE_ROOT,
  shareRootOf,
} from "./grant.ts";
import {
  MAX_SHARE_READ_BYTES,
  type ShareOpMap,
  type ShareOpName,
  type ShareTransport,
} from "./ops.ts";

export class RemoteFolderBackend implements FileBackend {
  readonly roots: readonly string[];
  readonly #root: string;
  readonly #transport: ShareTransport;
  readonly #grant: FolderGrant;

  constructor(grant: FolderGrant, transport: ShareTransport) {
    this.#grant = grant;
    this.#transport = transport;
    this.#root = shareRootOf(grant.name);
    this.roots = [this.#root];
  }

  /** The path as the model sees it (`/lend/<name>`). */
  get root(): string {
    return this.#root;
  }

  get grant(): FolderGrant {
    return this.#grant;
  }

  /**
   * Absolute paths only: a relative path is resolved against somebody's
   * working folder by `Sandbox` and by `resolveVmPath`, and a lent folder
   * must never be reachable that way (the model would be guessing which
   * machine `proj/src` means).
   */
  resolve(requested: string): Promise<ResolvedPath> {
    if (typeof requested !== "string" || requested.length === 0) {
      return Promise.resolve({
        ok: false,
        reason: "Path must be a non-empty string",
      });
    }
    if (!posix.isAbsolute(requested)) {
      return Promise.resolve({
        ok: false,
        reason:
          `Paths in a lent folder must be absolute: ${this.#root}/... ` +
          `(got "${requested}")`,
      });
    }
    const absolute = posix.normalize(requested);
    if (!isWithinShare(this.#root, absolute)) {
      return Promise.resolve({
        ok: false,
        reason: `Path is outside ${this.#root}: ${requested}`,
      });
    }
    if (Date.now() >= this.#grant.expiresAt) {
      return Promise.resolve({
        ok: false,
        reason: `${this.#root} is no longer lent: the user's loan ended`,
      });
    }
    return Promise.resolve({ ok: true, path: absolute });
  }

  stat(path: string): Promise<BackendStat | undefined> {
    return this.#call("stat", { path: this.#segments(path) }).then(
      (value) => value ?? undefined,
    );
  }

  readText(path: string): Promise<string> {
    return this.#call("readText", {
      path: this.#segments(path),
      maxBytes: MAX_SHARE_READ_BYTES,
    }).then((value) => value.text);
  }

  async readHead(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }> {
    const value = await this.#call("readHead", {
      path: this.#segments(path),
      // The tool decides how much it wants; the wire has its own ceiling so a
      // single frame stays bounded (the tool's note then says it was cut).
      maxBytes: Math.min(maxBytes, MAX_SHARE_READ_BYTES),
    });
    return { bytes: base64ToBytes(value.base64), size: value.size };
  }

  readRanges(
    path: string,
    ranges: readonly LineRange[],
  ): Promise<RangeReadResult> {
    return this.#call("readRanges", {
      path: this.#segments(path),
      ranges: [...ranges],
    });
  }

  async writeText(
    path: string,
    text: string,
    options: { private?: boolean } = {},
  ): Promise<void> {
    this.#requireWrite();
    await this.#call("writeText", {
      path: this.#segments(path),
      text,
      private: options.private === true,
    });
  }

  async removeFile(path: string): Promise<void> {
    this.#requireWrite();
    await this.#call("removeFile", { path: this.#segments(path) });
  }

  listDir(path: string): Promise<BackendDirEntry[]> {
    return this.#call("listDir", { path: this.#segments(path) });
  }

  /** The refusal a read-only loan gives. It names the folder and what the
   * model can do instead, because a failure with no next step reads as a
   * broken tool. */
  #requireWrite(): void {
    if (this.#grant.write) return;
    throw new Error(
      `${this.#root} is lent read-only: the user allowed reading it, not ` +
        "changing it. Ask them to lend it with writing enabled if the change " +
        "is what they want.",
    );
  }

  #segments(path: string): string[] {
    if (path === SHARE_ROOT) {
      throw new Error(
        `${SHARE_ROOT} is the namespace of the lent folders, not a folder: ` +
          `name one of them (${SHARE_ROOT}/<name>)`,
      );
    }
    const segments = relativeSegments(this.#root, path);
    if (segments === undefined) {
      throw new Error(`Path is outside ${this.#root}: ${path}`);
    }
    return segments;
  }

  #call<K extends ShareOpName>(
    op: K,
    request: ShareOpMap[K]["req"],
    signal?: AbortSignal,
  ): Promise<ShareOpMap[K]["res"]> {
    return this.#transport.call(this.#grant.id, op, request, signal);
  }
}
