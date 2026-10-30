import { join } from "node:path";

/**
 * One session's directory of generated assets, and the name allocation both
 * asset stores share.
 *
 * Two stores put files here — the visuals a code-mode reply embeds
 * (`visual:<name>` links, see session/visuals.ts) and the files an agent
 * attaches to a chat (see session/attachments.ts). They keep different
 * things and answer to different routes, but the safety property is the
 * same and has to be implemented once: **the store generates every name, and
 * only a name it generated can be read back**. A name is therefore random
 * (never derived from a path the model supplied), and a name that arrives
 * from outside is validated before it becomes a file path.
 *
 * Assets sit beside the database rather than inside a workspace: they belong
 * to the conversation, not to the project, and publishing must not touch the
 * files the user version-controls. A session that never publishes leaves
 * nothing behind (the directory is created on the first write).
 */
export class AssetDir {
  /** `root` is the directory the per-session directories are created under. */
  constructor(private readonly root: string) {}

  /** The directory of one session (not created by asking). */
  dirOf(sessionId: string): string {
    return join(this.root, sessionId);
  }

  /** Store `bytes` under a fresh name with `extension` and return that name.
   * Throws when the session already holds `maxFiles` assets; the name is
   * never overwritten (a fresh one is drawn for each write), so a message
   * that references an asset keeps showing the asset it showed. */
  async write(
    sessionId: string,
    bytes: Uint8Array,
    extension: string,
    maxFiles: number,
  ): Promise<string> {
    const dir = this.dirOf(sessionId);
    await Deno.mkdir(dir, { recursive: true });
    if (await this.count(dir) >= maxFiles) {
      throw new Error(
        `This session already holds ${maxFiles} assets; reuse one of them ` +
          "instead of writing another",
      );
    }
    // A fresh name per write: an asset is never overwritten, so a message
    // that references one keeps showing what it showed (and the asset route
    // can cache it forever). The retry only guards the impossible case of
    // two writes drawing the same 48-bit name; it never falls back to a
    // shared name.
    for (let attempt = 0; attempt < 3; attempt++) {
      const name = `${randomNameBase()}${extension.toLowerCase()}`;
      try {
        await Deno.writeFile(join(dir, name), bytes, { createNew: true });
        return name;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
    }
    throw new Error("Could not allocate an asset name");
  }

  /** Store `text` beside an asset of the same base name (the sidecar a
   * store keeps for facts about the bytes — an attachment's original file
   * name). The file is replaced rather than appended. */
  async writeSidecar(
    sessionId: string,
    name: string,
    text: string,
  ): Promise<void> {
    await Deno.writeTextFile(
      join(this.dirOf(sessionId), `${name}.json`),
      text,
    );
  }

  /** The sidecar text of an asset, or undefined when it has none. */
  async readSidecar(
    sessionId: string,
    name: string,
  ): Promise<string | undefined> {
    try {
      return await Deno.readTextFile(
        join(this.dirOf(sessionId), `${name}.json`),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  /** The file an asset name names, or undefined when this session has no
   * such file (an unknown name, a name whose file was removed, or a session
   * that never wrote one). The caller validates the name's shape first —
   * this only answers whether the file is there. */
  async resolve(sessionId: string, name: string): Promise<string | undefined> {
    const path = join(this.dirOf(sessionId), name);
    try {
      const stat = await Deno.stat(path);
      if (!stat.isFile) return undefined;
    } catch {
      return undefined;
    }
    return path;
  }

  /** Drop every asset of a session (the session itself is gone). No-op when
   * the session never wrote one. */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await Deno.remove(this.dirOf(sessionId), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  private async count(dir: string): Promise<number> {
    let held = 0;
    for await (const entry of Deno.readDir(dir)) {
      // Sidecars belong to their asset, so they are not assets themselves.
      if (entry.isFile && !entry.name.endsWith(".json")) held++;
    }
    return held;
  }
}

/** 12 hex characters of randomness per asset name. The name is visible in a
 * message, so it stays short; 48 bits is far beyond what a collision needs,
 * and `createNew` turns the theoretical one into a retry rather than an
 * overwrite. */
function randomNameBase(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
