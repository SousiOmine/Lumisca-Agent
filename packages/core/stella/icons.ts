import {
  AGENT_ICON_FORMATS,
  agentIconMimeType,
  MAX_AGENT_ICON_BYTES,
} from "../shared/mod.ts";
import { CoreError } from "../errors.ts";
import { AssetDir } from "../session/asset-dir.ts";

/**
 * The pictures stella's agents show instead of their initial.
 *
 * One file per agent, plus the ones it replaced (a replaced file is removed
 * by its writer, but a crash between the two steps leaves it behind). The
 * directory is keyed by AGENT, not by session: an icon belongs to the agent,
 * and it outlives every conversation the agent ever has.
 *
 * Like the visual and attachment stores, this one is a thin policy over
 * {@link AssetDir}: the store generates every name, so a name is the only
 * address and a database row can never point the icon route at a file of its
 * own choosing.
 *
 * What this store adds is the policy of one kind of asset: which extensions
 * an icon may be, how much one may weigh, and that the bytes must actually BE
 * the format the extension names. That last check is why an upload is
 * rejected rather than stored-and-broken: a `.png` that is really a JPEG is
 * served as `image/png` and never paints, and the user sees an empty circle
 * with no explanation.
 */
export class AgentIconStore {
  readonly #dir: AssetDir;

  /** `root` is the directory the per-agent directories are created under
   * (created on the first upload, so an agent that never had a picture
   * leaves nothing behind). */
  constructor(root: string) {
    this.#dir = new AssetDir(root);
  }

  /** Store `bytes` as the new icon file of `agentId` and return its name.
   *
   * Throws — never truncates, never converts — when the extension is not one
   * icons support, when the bytes exceed {@link MAX_AGENT_ICON_BYTES}, when
   * they are not the format the extension names, or when the agent is at
   * {@link MAX_AGENT_ICONS_PER_AGENT} files. The caller records the returned
   * name on the agent row and removes the file it replaced. */
  async put(
    agentId: string,
    bytes: Uint8Array,
    extension: string,
  ): Promise<string> {
    const suffix = extension.toLowerCase();
    const mimeType = agentIconMimeType(suffix);
    if (mimeType === undefined) {
      throw new CoreError(
        `Icons must be ${AGENT_ICON_FORMATS}; got "${extension}".`,
        "invalid",
      );
    }
    if (bytes.byteLength > MAX_AGENT_ICON_BYTES) {
      throw new CoreError(
        `The icon is too large: ${bytes.byteLength} bytes (limit ` +
          `${MAX_AGENT_ICON_BYTES}). Choose a smaller image.`,
        "invalid",
      );
    }
    if (bytes.byteLength === 0) {
      throw new CoreError("The icon file is empty.", "invalid");
    }
    if (!matchesFormat(bytes, suffix)) {
      throw new CoreError(
        `The file is not a ${suffix.slice(1).toUpperCase()} image: its ` +
          "content does not match the type the browser reported.",
        "invalid",
      );
    }
    try {
      return await this.#dir.write(
        agentId,
        bytes,
        suffix,
        MAX_AGENT_ICONS_PER_AGENT,
      );
    } catch (error) {
      // The cap's wording is AssetDir's (shared with the two other stores);
      // translate it into this one's, which names what the user was doing.
      if (
        error instanceof Error &&
        error.message.includes(`holds ${MAX_AGENT_ICONS_PER_AGENT} assets`)
      ) {
        throw new CoreError(
          `This agent already holds ${MAX_AGENT_ICONS_PER_AGENT} icon files; ` +
            "choose an existing one instead of uploading another",
          "conflict",
        );
      }
      throw error;
    }
  }

  /** The file `name` names for `agentId`, with the content type to serve it
   * as — or undefined for a name the store did not generate, a file that is
   * gone, or an agent that never uploaded one. The shape is validated here,
   * so no caller has to. */
  async resolve(
    agentId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    if (!ICON_NAME.test(name)) return undefined;
    const path = await this.#dir.resolve(agentId, name);
    if (path === undefined) return undefined;
    return { path, mimeType: agentIconMimeType(extensionOf(name))! };
  }

  /** Remove one icon file of an agent (the one it replaced). A file that is
   * already gone is not an error: the replacement is what the row shows. */
  remove(agentId: string, name: string): Promise<void> {
    if (!ICON_NAME.test(name)) return Promise.resolve();
    return this.#dir.removeFile(agentId, name);
  }

  /** Drop every icon file of an agent (the agent itself is gone). No-op when
   * it never had one. */
  deleteAgent(agentId: string): Promise<void> {
    return this.#dir.deleteOwner(agentId);
  }
}

/** Icon name: 12 hex characters and one icon extension. The store generates
 * it, so anything else is not an address this store hands out. */
const ICON_NAME = /^[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp|bmp)$/;

/** Most icon files one agent may hold before the oldest cannot be cleaned up
 * automatically. An agent needs one; the slack covers a replacement that was
 * interrupted between writing the new file and removing the old one, so the
 * next upload still has room instead of failing forever. */
export const MAX_AGENT_ICONS_PER_AGENT = 8;

/** Directory (beside the database) that holds the agents' icons. */
export const AGENT_ICONS_DIR_NAME = ".lumisca-agent-icons";

/** The extension a stored name ends in (with its dot, lowercased). */
function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf(".")).toLowerCase();
}

/**
 * Whether `bytes` begin with the signature of the format `extension` names.
 *
 * Only the leading signature is checked: the point is to catch a file whose
 * content type came from its name alone (a renamed JPEG, an HTML page saved
 * as `.png`), not to validate an image. A full decode would cost more than it
 * can catch — the store is never the parser — and a truncated-but-real PNG is
 * the browser's to report.
 */
function matchesFormat(bytes: Uint8Array, extension: string): boolean {
  switch (extension) {
    case ".png":
      return startsWith(bytes, [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);
    case ".jpg":
    case ".jpeg":
      // SOI marker; the third byte distinguishes the JPEG family (JFIF/Exif)
      // from the other markers that also begin FF D8.
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case ".gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case ".webp":
      // RIFF container with the "WEBP" form: 12 bytes carry both halves.
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes.length >= 12 &&
        String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
    case ".bmp":
      return startsWith(bytes, [0x42, 0x4d]);
    default:
      return false;
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}
