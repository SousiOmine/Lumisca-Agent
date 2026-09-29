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

/** The picker's starting points on a platform, in sidebar order, before the
 * existence check. The environment and the platform are parameters (not the
 * ambient ones) so the per-platform rules stay testable. */
export function placeCandidates(
  env: (key: string) => string | undefined,
  os: string = Deno.build.os,
): PlaceCandidate[] {
  const home = env("USERPROFILE") || env("HOME") || "";
  const candidates: PlaceCandidate[] = [];
  if (home !== "") {
    candidates.push({ kind: "home", path: home });
    // Linux names its user folders through XDG (a desktop session exports
    // the variables); macOS and Windows use the English names.
    const xdg = os === "linux" ? env : () => undefined;
    candidates.push(
      {
        kind: "desktop",
        path: xdg("XDG_DESKTOP_DIR") || join(home, "Desktop"),
      },
      {
        kind: "documents",
        path: xdg("XDG_DOCUMENTS_DIR") || join(home, "Documents"),
      },
      {
        kind: "downloads",
        path: xdg("XDG_DOWNLOAD_DIR") || join(home, "Downloads"),
      },
    );
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
    const candidates = placeCandidates((key) => Deno.env.get(key));
    return c.json(await buildPlaces(candidates));
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
