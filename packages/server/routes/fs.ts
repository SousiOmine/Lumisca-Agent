import { join, parse, relative, sep } from "node:path";
import { Hono } from "hono";
import { isDirectory } from "@lumisca/core";
import { AppError, requireNonEmptyString } from "./util.ts";

/** A place the folder picker's sidebar can start browsing from: an
 * OS-typical user folder, or a filesystem root (a drive on Windows).
 * `kind` is a token the UI translates — a root is labelled by its path. */
export type FsPlaceKind =
  | "home"
  | "desktop"
  | "documents"
  | "downloads"
  | "root";

export interface FsPlace {
  kind: FsPlaceKind;
  path: string;
}

/** A browse entry. Folders can be entered (and picked as a workspace
 * folder); files are listed for orientation only. */
export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** One step of the browser's address bar, from the filesystem root down to
 * the browsed folder. */
export interface FsBreadcrumb {
  name: string;
  path: string;
}

/** A place the picker offers before its existence is checked. */
export interface PlaceCandidate {
  kind: FsPlaceKind;
  path: string;
}

/** The filesystem roots of a platform: every drive letter on Windows, `/`
 * elsewhere. Whether each one exists is decided by {@link buildPlaces}. */
function rootPaths(os: string): string[] {
  return os === "windows"
    ? [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `${letter}:\\`)
    : ["/"];
}

/** Whether a declared path is the home folder itself. That is how the XDG
 * spec turns a user folder off, so the picker must not offer it — a
 * trailing separator (`"$HOME/"`) does not change which folder it is. */
function isHomeFolder(path: string, home: string): boolean {
  const strip = (value: string) => value.replace(/[\\/]+$/, "");
  return strip(path) === strip(home);
}

/** The user folders a Linux desktop session declares, read from
 * `$XDG_CONFIG_HOME/user-dirs.dirs` (`~/.config/user-dirs.dirs` by
 * default): the path of a declared folder, `null` for one the user turned
 * off, or nothing when the file does not name it.
 *
 * The environment alone cannot answer this: it carries the variables of the
 * session that started the process, while the server also runs as a systemd
 * unit or from a bare terminal — and the localized folder names
 * (`XDG_DOCUMENTS_DIR="$HOME/ドキュメント"`) live in this file, the same
 * source the desktop's file managers read. */
export async function readUserDirs(
  file: string,
  home: string,
): Promise<(key: string) => string | null | undefined> {
  const dirs = new Map<string, string | null>();
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    // No file (macOS, Windows, a machine without a desktop session):
    // nothing is declared here, and the English names take over.
    return (key) => dirs.get(key);
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(XDG_[A-Z_]+_DIR)\s*=\s*(?:"([^"]*)"|(\S+))\s*$/
      .exec(line);
    if (!match) continue;
    const [, key = "", quoted, bare] = match;
    // The file writes its values as `"$HOME/ドキュメント"`; the only
    // variable they may use is $HOME.
    const value = (quoted ?? bare ?? "").replace(/\$\{?HOME\}?/g, home);
    dirs.set(key, isHomeFolder(value, home) ? null : value);
  }
  return (key) => dirs.get(key);
}

/** Where a desktop session records its user folders. */
function userDirsFile(env: (key: string) => string | undefined): string {
  const configHome = env("XDG_CONFIG_HOME") ||
    join(env("HOME") ?? "", ".config");
  return join(configHome, "user-dirs.dirs");
}

/** The picker's starting points on a platform, in sidebar order, before the
 * existence check. The environment, the platform and the XDG declarations
 * are parameters (not the ambient ones) so the per-platform rules stay
 * testable. */
export function placeCandidates(
  env: (key: string) => string | undefined,
  os: string = Deno.build.os,
  userDirs: (key: string) => string | null | undefined = () => undefined,
): PlaceCandidate[] {
  const home = env("USERPROFILE") || env("HOME") || "";
  const candidates: PlaceCandidate[] = [];
  if (home !== "") {
    candidates.push({ kind: "home", path: home });
    // Linux names its user folders through XDG: the variables a desktop
    // session exports, or the config file for a process without one.
    // macOS and Windows use the English names.
    const xdg = os === "linux"
      ? (key: string) => env(key) || userDirs(key)
      : () => undefined;
    /** One user folder: the declared path, the English name while nothing
     * declares it, or nothing at all when the user turned it off. */
    const userFolder = (key: string, englishName: string): string | null => {
      const declared = xdg(key);
      // A folder the user turned off stays off: it must not come back as
      // the English name.
      if (declared === null) return null;
      const path = declared || join(home, englishName);
      return isHomeFolder(path, home) ? null : path;
    };
    const folders: Array<{ kind: FsPlaceKind; key: string; name: string }> = [
      { kind: "desktop", key: "XDG_DESKTOP_DIR", name: "Desktop" },
      { kind: "documents", key: "XDG_DOCUMENTS_DIR", name: "Documents" },
      { kind: "downloads", key: "XDG_DOWNLOAD_DIR", name: "Downloads" },
    ];
    for (const folder of folders) {
      const path = userFolder(folder.key, folder.name);
      if (path !== null) candidates.push({ kind: folder.kind, path });
    }
  }
  for (const path of rootPaths(os)) candidates.push({ kind: "root", path });
  return candidates;
}

/** Keep the candidates that are existing directories, in order: a machine
 * without, say, a Documents folder simply does not offer it. */
export async function buildPlaces(
  candidates: PlaceCandidate[],
  isDir: (path: string) => Promise<boolean> = isDirectory,
): Promise<FsPlace[]> {
  const exists = await Promise.all(
    candidates.map((place) => isDir(place.path)),
  );
  return candidates.filter((_, index) => exists[index]);
}

/** The address bar's chain from the filesystem root down to `path`. The
 * server computes it because only it knows the platform's separators (a
 * client-side split breaks on Windows drives and UNC paths); the root step
 * is labelled by its own path, every deeper step by its segment name. */
export function breadcrumbs(path: string): FsBreadcrumb[] {
  const root = parse(path).root;
  const crumbs: FsBreadcrumb[] = [{ name: root, path: root }];
  let current = root;
  for (const segment of relative(root, path).split(sep)) {
    if (segment === "" || segment === ".") continue;
    current = join(current, segment);
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/** Folders before files, each group sorted by name: the default order of a
 * file manager's list view. */
function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Filesystem browser endpoints (workspace folder picker). */
export function fsRoutes(): Hono {
  const app = new Hono();

  /** The places the sidebar lists: the user folders that exist on the
   * machine serving this request, then its filesystem roots. */
  app.get("/fs/places", async (c) => {
    const env = (key: string) => Deno.env.get(key);
    const os = Deno.build.os;
    // Only Linux keeps its user folders in the XDG config file.
    const userDirs = os === "linux"
      ? await readUserDirs(userDirsFile(env), env("HOME") ?? "")
      : () => undefined;
    return c.json(await buildPlaces(placeCandidates(env, os, userDirs)));
  });

  app.get("/fs/browse", async (c) => {
    const path = requireNonEmptyString(c.req.query("path") ?? "", "path");
    if (!await isDirectory(path)) {
      throw new AppError(`not a directory: ${path}`, 400);
    }
    const entries: FsEntry[] = [];
    for await (const entry of Deno.readDir(path)) {
      const entryPath = join(path, entry.name);
      // A dirent describes the link itself, so a symlinked folder would read
      // as a file (and could never be picked as a workspace folder): resolve
      // the links only, one stat each.
      const dir = entry.isDirectory ||
        (entry.isSymlink && await isDirectory(entryPath));
      entries.push({
        name: entry.name,
        path: entryPath,
        kind: dir ? "dir" : "file",
      });
    }
    entries.sort(compareEntries);
    const crumbs = breadcrumbs(path);
    return c.json({
      path,
      parent: crumbs.length > 1 ? crumbs.at(-2)!.path : null,
      breadcrumbs: crumbs,
      entries,
    });
  });

  return app;
}
