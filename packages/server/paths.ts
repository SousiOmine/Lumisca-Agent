import { dirname, join } from "node:path";
import { VM_CONTAINER_DIR_NAME } from "@lumisca/core";

/**
 * Repository layout the server depends on (frontend sources, esbuild alias
 * target). Centralized so a rename inside packages/web or packages/core
 * breaks in exactly one place instead of being hardcoded twice.
 */

export function webSrcDir(repoRoot: string): string {
  return join(repoRoot, "packages", "web", "src");
}

export function webClientEntry(repoRoot: string): string {
  return join(webSrcDir(repoRoot), "client.tsx");
}

export function webStylesPath(repoRoot: string): string {
  return join(webSrcDir(repoRoot), "styles.css");
}

export function webFaviconPath(repoRoot: string): string {
  return join(repoRoot, "packages", "web", "public", "favicon.png");
}

/** The PWA icons' source directory (`/pwa/<name>` URLs). They are committed
 * PNGs beside the favicon; a packaged build carries them inside
 * `assets.json` like every other asset. */
export function webPwaIconDir(repoRoot: string): string {
  return join(repoRoot, "packages", "web", "public", "pwa");
}

/** The service worker script served at `/sw.js`. It has to be a file of the
 * site's own root scope (a worker's default scope is its URL's directory),
 * and it is a plain script, not a module: Safari refuses module workers. */
export function webServiceWorkerPath(repoRoot: string): string {
  return join(repoRoot, "packages", "web", "public", "sw.js");
}

/**
 * Where the stella machine's container files live (the `stella-container`
 * directory holding the Containerfile and entry.sh).
 *
 * Two layouts exist and the packaged one cannot find the files any other
 * way: in a repository checkout they sit in the core's sources, while a
 * compiled server ships them BESIDE THE BINARY (scripts/build-server.ts
 * stages them there, next to assets.json) — a compiled binary contains no
 * file system of its own. The repository path is tried first so
 * `bun run dev` and the desktop's development launch keep working from a
 * checkout; the install directory is the packaged layout.
 *
 * `existsInInstall` is injected so the choice is testable without creating
 * either layout.
 */
export function stellaContainerDir(
  repoRoot: string,
  execPath: string,
  existsInInstall: (path: string) => boolean,
): string {
  const fromRepo = join(repoRoot, "packages", "core", "vm", "container");
  const fromInstall = join(dirname(execPath), VM_CONTAINER_DIR_NAME);
  return existsInInstall(fromInstall) ? fromInstall : fromRepo;
}
