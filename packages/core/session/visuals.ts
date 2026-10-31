import {
  isVisualExtension,
  maxVisualBytes,
  visualMimeType,
} from "../shared/mod.ts";
import { AssetDir } from "./asset-dir.ts";

/**
 * The published visuals of a session: the image files a reply may embed with
 * a `visual:` reference (see shared/visual.ts).
 *
 * The store is the only writer, and the names it generates are the only
 * addresses: a message can never point at a path on the machine, and the
 * asset route (server/routes/visuals.ts) serves nothing but a name that
 * resolved here. Assets sit beside the database rather than inside a
 * workspace: they belong to the conversation, not to the project, and
 * publishing must not touch the files the user version-controls.
 *
 * What this class adds to {@link AssetDir} is the policy of one kind of
 * asset: which extensions are images, what each may weigh, and the content
 * type of a name. The naming, the directory and the cache-forever property
 * are shared with the attachments store (session/attachments.ts), because
 * getting them wrong once is enough.
 */
export class SessionVisualStore {
  readonly #dir: AssetDir;

  /** `root` is the directory the per-session directories are created under
   * (created on the first publish, so a session that never shows an image
   * leaves nothing behind). */
  constructor(root: string) {
    this.#dir = new AssetDir(root);
  }

  /** Store `bytes` as a new asset of `sessionId` and return its name (what
   * `visualRef` links). Throws — never truncates or renames — when the
   * extension is not one visuals support, when the bytes exceed the limit
   * for it, or when the session is at MAX_ASSETS_PER_SESSION. */
  async put(
    sessionId: string,
    bytes: Uint8Array,
    extension: string,
  ): Promise<string> {
    const suffix = extension.toLowerCase();
    if (!isVisualExtension(suffix)) {
      throw new Error(`Unsupported visual extension: ${extension}`);
    }
    const limit = maxVisualBytes(suffix);
    if (bytes.byteLength > limit) {
      throw new Error(
        `Visual is too large: ${bytes.byteLength} bytes (limit ${limit})`,
      );
    }
    try {
      return await this.#dir.write(
        sessionId,
        bytes,
        suffix,
        MAX_ASSETS_PER_SESSION,
      );
    } catch (error) {
      // The cap's wording is this store's (a visual, not an attachment):
      // translate it rather than leak the shared one, which names no kind.
      if (
        error instanceof Error &&
        error.message.includes(`holds ${MAX_ASSETS_PER_SESSION} assets`)
      ) {
        throw new Error(
          `This session already holds ${MAX_ASSETS_PER_SESSION} visuals; ` +
            "reuse one of them instead of publishing another",
        );
      }
      throw error;
    }
  }

  /** The file an asset name names, or undefined when this session has no
   * such asset: an unknown or malformed name (validated here, so no caller
   * has to), a name whose file was removed, or a session that never
   * published. */
  async resolve(
    sessionId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    const mimeType = visualMimeType(name);
    if (mimeType === undefined) return undefined;
    const path = await this.#dir.resolve(sessionId, name);
    return path === undefined ? undefined : { path, mimeType };
  }

  /** Drop every asset of a session (the session itself is gone). No-op when
   * the session never published one. */
  deleteSession(sessionId: string): Promise<void> {
    return this.#dir.deleteOwner(sessionId);
  }
}

/** Directory (beside the database) that holds the sessions' visual assets,
 * named like the other dot-directories the app writes next to its state. */
export const VISUALS_DIR_NAME = ".lumisca-visuals";

/** Most assets one session may hold. A session publishes a handful in
 * normal use; the cap only stops a loop from filling the disk. */
const MAX_ASSETS_PER_SESSION = 200;
