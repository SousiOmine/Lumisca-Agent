import { join } from "node:path";
import {
  isVisualExtension,
  maxVisualBytes,
  visualMimeType,
} from "../shared/mod.ts";

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
 */
export class SessionVisualStore {
  /** `root` is the directory the per-session directories are created under
   * (created on the first publish, so a session that never shows an image
   * leaves nothing behind). */
  constructor(private readonly root: string) {}

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
    const dir = this.sessionDir(sessionId);
    await Deno.mkdir(dir, { recursive: true });
    let held = 0;
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) held++;
    }
    if (held >= MAX_ASSETS_PER_SESSION) {
      throw new Error(
        `This session already holds ${MAX_ASSETS_PER_SESSION} visuals; reuse one of them instead of publishing another`,
      );
    }
    // A fresh name per publish: an asset is never overwritten, so a message
    // that references one keeps showing what it showed (and the asset route
    // can cache it forever). The retry only guards the impossible case of
    // two publishes drawing the same 48-bit name; it never falls back to a
    // shared name.
    for (let attempt = 0; attempt < 3; attempt++) {
      const name = `${randomNameBase()}${suffix}`;
      const path = join(dir, name);
      try {
        await Deno.writeFile(path, bytes, { createNew: true });
        return name;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
    }
    throw new Error("Could not allocate a visual asset name");
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
    const path = join(this.sessionDir(sessionId), name);
    try {
      const stat = await Deno.stat(path);
      if (!stat.isFile) return undefined;
    } catch {
      return undefined;
    }
    return { path, mimeType };
  }

  /** Drop every asset of a session (the session itself is gone). No-op when
   * the session never published one. */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await Deno.remove(this.sessionDir(sessionId), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  private sessionDir(sessionId: string): string {
    return join(this.root, sessionId);
  }
}

/** Directory (beside the database) that holds the sessions' visual assets,
 * named like the other dot-directories the app writes next to its state. */
export const VISUALS_DIR_NAME = ".lumisca-visuals";

/** Most assets one session may hold. A session publishes a handful in
 * normal use; the cap only stops a loop from filling the disk. */
const MAX_ASSETS_PER_SESSION = 200;

/** 12 hex characters of randomness per asset name. The name is visible in a
 * message, so it stays short; 48 bits is far beyond what a collision needs,
 * and `createNew` turns the theoretical one into a retry rather than an
 * overwrite. */
function randomNameBase(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
