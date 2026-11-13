/**
 * A lent folder's place in the agent's namespace, and the rules that keep it
 * unambiguous.
 *
 * Lent folders hang under ONE root, `/lend/<name>`, because they are not on
 * the machine the session works on: a stella session's own files live under
 * `/home/agent` and its file backend refuses everything else, so a lent
 * folder must be a root of its own rather than a directory inside the
 * machine. The name is a path segment, so it is normalized to something a
 * path can carry — and the root is deliberately not reachable by a relative
 * path: `Sandbox` and `resolveVmPath` both resolve relative paths against
 * somebody's working folder, and a lent folder must never be found that way.
 */
import { posix } from "node:path";
import type { FolderShare } from "../domain/share.ts";

/** The single root every lent folder hangs under. */
export const SHARE_ROOT = "/lend";

/** What the server learned from a desktop app about one folder: the view the
 * client draws, plus the conversation it was lent to. */
export interface FolderGrant extends FolderShare {
  /** The session (in stella, the conversation) it may be used by. */
  sessionId: string;
}

/** The namespace path a name resolves to. */
export function shareRootOf(name: string): string {
  return `${SHARE_ROOT}/${name}`;
}

const SHARE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Whether `name` may be a path segment of the namespace. */
export function isShareName(name: string): boolean {
  return SHARE_NAME.test(name);
}

/**
 * A namespace name for the folder at `path`, unique among `taken`.
 *
 * The last path segment, lowercased, with everything a namespace cannot carry
 * folded to a dash. A path that ends in something unusable ("/" or a
 * non-ASCII-only name) falls back to `folder`, and a duplicate takes the
 * lowest free `-2`, `-3`, … — two lent folders must never answer to one name,
 * because the name is how the model addresses them.
 */
export function shareNameFrom(path: string, taken: readonly string[]): string {
  const base =
    path
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") ?? "";
  const wanted = SHARE_NAME.test(base) ? base : "folder";
  if (!taken.includes(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    // The suffix has to fit the 32-character limit, so a long name loses its
    // tail rather than being refused.
    const suffix = `-${n}`;
    const candidate = `${wanted.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** True for the namespace root itself or anything below it. */
export function isSharePath(path: string): boolean {
  return path === SHARE_ROOT || path.startsWith(`${SHARE_ROOT}/`);
}

/**
 * Whether `candidate` is `root` itself or inside it. POSIX comparison by
 * design: the namespace is `/lend/...` on every machine, whatever separators
 * the disk that holds the folder uses, so `workspace/path-util` (which folds
 * case on Windows) would be applying the server's rules to a stranger's path.
 */
export function isWithinShare(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The grant-relative path segments of `absolute`, or undefined when it is
 * outside `root`.
 *
 * These segments are what crosses the wire: the lent computer joins them with
 * its own separator and re-checks the result, so no absolute path from one
 * machine is ever handed to another (a Windows path is not a path on Linux,
 * and `C:` is not a path segment).
 */
export function relativeSegments(
  root: string,
  absolute: string,
): string[] | undefined {
  if (!isWithinShare(root, absolute)) return undefined;
  const rest = posix.relative(root, absolute);
  if (rest === "") return [];
  if (posix.isAbsolute(rest) || rest === ".." || rest.startsWith("../")) {
    return undefined;
  }
  return rest.split("/");
}

/** The absolute namespace path of `segments` under `root`, normalized so a
 * `..` inside the request cannot climb out. Undefined when it escapes. */
export function sharePathOf(
  root: string,
  segments: readonly string[],
): string | undefined {
  const joined = posix.normalize(posix.join(root, ...segments));
  return isWithinShare(root, joined) ? joined : undefined;
}

/**
 * A grant as an announcement carries it, or undefined when it is not one.
 *
 * The lending app is our own code, so this is a version check more than a
 * security one: an app built against a newer shape must be refused at the
 * boundary (and reported) rather than indexed here with fields the server
 * would then believe.
 */
export function parseGrant(value: unknown): FolderGrant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const host = v.host;
  if (typeof host !== "object" || host === null) return undefined;
  const h = host as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    v.id === "" ||
    typeof v.sessionId !== "string" ||
    v.sessionId === "" ||
    typeof v.path !== "string" ||
    typeof v.name !== "string" ||
    !isShareName(v.name) ||
    typeof v.write !== "boolean" ||
    typeof v.expiresAt !== "number" ||
    !Number.isFinite(v.expiresAt) ||
    (h.platform !== "macos" &&
      h.platform !== "windows" &&
      h.platform !== "linux") ||
    typeof h.name !== "string" ||
    typeof h.shell !== "string"
  ) {
    return undefined;
  }
  return {
    id: v.id,
    sessionId: v.sessionId,
    name: v.name,
    path: v.path,
    write: v.write,
    expiresAt: v.expiresAt,
    host: { platform: h.platform, name: h.name, shell: h.shell },
  };
}

/** The grant whose root contains `path` (the longest match wins), if any. */
export function grantOwning(
  grants: readonly FolderGrant[],
  path: string,
): FolderGrant | undefined {
  let owner: FolderGrant | undefined;
  for (const grant of grants) {
    if (!isWithinShare(shareRootOf(grant.name), path)) continue;
    if (owner === undefined || grant.name.length > owner.name.length) {
      owner = grant;
    }
  }
  return owner;
}

/** Whether a granted folder may be written to. One answer, used by the
 * backend that refuses and by the text that tells the model. */
export function grantAccess(grant: FolderGrant): "read-write" | "read-only" {
  return grant.write ? "read-write" : "read-only";
}
