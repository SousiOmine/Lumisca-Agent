/**
 * The file namespace of a session that has both its own folders and folders
 * lent from the user's computer.
 *
 * A tool asks ONE backend for everything, so the only place "which machine is
 * this path on" can be answered is here: the roots of the session's own
 * backend (the machine, or the workspace) and one root per lent folder, with
 * the longest match winning. The tools never learn that a path crossed a
 * machine — `read`, `write`, `edit`, `list_dir`, `send_chat` and the spill of
 * a truncated command all keep working unchanged.
 *
 * `roots` keeps the session's own roots FIRST. Two callers depend on it:
 * `OutputSpiller` writes under `roots[0]`, and a spilled file has to land
 * where the session can read it back — never inside a folder the user lent
 * read-only, and never on a computer that may already be gone.
 */
import { posix } from "node:path";
import type {
  BackendDirEntry,
  BackendStat,
  FileBackend,
  LineRange,
  RangeReadResult,
} from "../tools/file-backend.ts";
import type { ResolvedPath } from "../workspace/sandbox.ts";
import type { FolderGrant } from "./grant.ts";
import { grantOwning, isSharePath, SHARE_ROOT, shareRootOf } from "./grant.ts";
import type { ShareTransport } from "./ops.ts";
import { RemoteFolderBackend } from "./remote-folder.ts";

export class MountedFiles implements FileBackend {
  readonly #primary: FileBackend;
  readonly #transport: ShareTransport;
  readonly #grants: () => readonly FolderGrant[];
  /** One backend per grant, rebuilt when the grant's terms change: a grant is
   * replaced (new object) on every announcement, while its id stays. */
  readonly #backends = new Map<
    string,
    { signature: string; backend: RemoteFolderBackend }
  >();

  constructor(
    primary: FileBackend,
    transport: ShareTransport,
    grants: () => readonly FolderGrant[],
  ) {
    this.#primary = primary;
    this.#transport = transport;
    this.#grants = grants;
  }

  get roots(): readonly string[] {
    return [
      ...this.#primary.roots,
      ...this.#grants().map((grant) => shareRootOf(grant.name)),
    ];
  }

  async resolve(requested: string): Promise<ResolvedPath> {
    if (typeof requested !== "string" || requested.length === 0) {
      return { ok: false, reason: "Path must be a non-empty string" };
    }
    if (posix.isAbsolute(requested)) {
      const absolute = posix.normalize(requested);
      if (absolute === SHARE_ROOT) {
        const roots = this.#roots();
        if (roots.length === 0) {
          return {
            ok: false,
            reason: "No folder is lent to this conversation right now",
          };
        }
        return { ok: true, path: SHARE_ROOT };
      }
      if (isSharePath(absolute)) {
        const owner = this.#owner(absolute);
        if (owner !== undefined) return owner.resolve(absolute);
        return {
          ok: false,
          reason:
            `No lent folder is named that: ${requested}. ` +
            `Lent now: ${this.#names()}`,
        };
      }
    }
    const primary = await this.#primary.resolve(requested);
    if (primary.ok) return primary;
    const roots = this.#roots();
    if (roots.length === 0) return primary;
    // The model guessed a name ("proj/src"). The session's own backend says
    // why that failed; naming the absolute form here is what turns the
    // refusal into the next step.
    return {
      ok: false,
      reason: `${primary.reason}. Lent folders are addressed by absolute path: ${roots.join(", ")}`,
    };
  }

  async stat(path: string): Promise<BackendStat | undefined> {
    if (path === SHARE_ROOT) {
      return this.#roots().length === 0
        ? undefined
        : { isFile: false, size: 0 };
    }
    const owner = this.#owner(path);
    if (owner !== undefined) return owner.stat(path);
    return this.#primary.stat(path);
  }

  async readText(path: string): Promise<string> {
    return this.#route(path).readText(path);
  }

  async readHead(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }> {
    return await this.#route(path).readHead(path, maxBytes);
  }

  async readBytes(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    return await this.#route(path).readBytes(path, offset, length);
  }

  async readRanges(
    path: string,
    ranges: readonly LineRange[],
  ): Promise<RangeReadResult> {
    return await this.#route(path).readRanges(path, ranges);
  }

  async writeText(
    path: string,
    text: string,
    options: { private?: boolean } = {},
  ): Promise<void> {
    await this.#route(path).writeText(path, text, options);
  }

  async writeBytes(
    path: string,
    bytes: Uint8Array,
    options: { private?: boolean; append?: boolean } = {},
  ): Promise<void> {
    await this.#route(path).writeBytes(path, bytes, options);
  }

  async removeFile(path: string): Promise<void> {
    await this.#route(path).removeFile(path);
  }

  async listDir(path: string): Promise<BackendDirEntry[]> {
    if (path === SHARE_ROOT) {
      // The namespace is a folder in the model's eyes: a model that forgot
      // what was lent can ask for the names again (the context message is
      // condensed away in a long conversation).
      return this.#roots().map((root) => ({
        name: posix.basename(root),
        isDirectory: true,
        isSymlink: false,
      }));
    }
    return this.#route(path).listDir(path);
  }

  /** The backend that owns `path`. The namespace root is nobody's folder: an
   * operation on it directly is a mistake the model should be told about,
   * not quietly redirected to the session's own backend (which would write a
   * file called `/lend` on the server). */
  #route(path: string): FileBackend {
    if (path === SHARE_ROOT) {
      throw new Error(
        `${SHARE_ROOT} holds the lent folders, it is not one: use ` +
          `${this.#names()}`,
      );
    }
    return this.#owner(path) ?? this.#primary;
  }

  #owner(path: string): RemoteFolderBackend | undefined {
    const grant = grantOwning(this.#grants(), path);
    return grant === undefined ? undefined : this.#backendFor(grant);
  }

  #backendFor(grant: FolderGrant): RemoteFolderBackend {
    // A withdrawn loan's backend is dropped: a session that lends and withdraws
    // folders for days would otherwise keep one entry per loan it ever saw.
    if (this.#backends.size > this.#grants().length) {
      const live = new Set(this.#grants().map((candidate) => candidate.id));
      for (const id of [...this.#backends.keys()]) {
        if (!live.has(id)) this.#backends.delete(id);
      }
    }
    const signature = [
      grant.name,
      grant.write ? "w" : "r",
      grant.exec ? "x" : "-",
      grant.expiresAt,
      grant.sessionId,
    ].join("|");
    const cached = this.#backends.get(grant.id);
    if (cached !== undefined && cached.signature === signature) {
      return cached.backend;
    }
    const backend = new RemoteFolderBackend(grant, this.#transport);
    this.#backends.set(grant.id, { signature, backend });
    return backend;
  }

  #roots(): string[] {
    return this.#grants().map((grant) => shareRootOf(grant.name));
  }

  #names(): string {
    const roots = this.#roots();
    return roots.length === 0 ? "(none)" : roots.join(", ");
  }
}
