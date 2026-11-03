import { VM_CONTAINER_DIR_NAME } from "@lumisca/core";

/**
 * The shape of a packaged install: what sits next to the server binary.
 *
 * Two places have to agree on it — `scripts/build-server.ts` (which puts the
 * files there) and `update/install.ts` (which replaces them in place on a
 * self-update). They disagreed by being two literals: the build wrote
 * `assets.json`, `icudtl.dat` and the container directory, and the installer
 * listed the same four names again. A name added on one side and not the
 * other means an update leaves a stale file behind (or replaces one the
 * build no longer produces), and the failure shows up as a server that
 * starts with the old assets.
 *
 * Both read this module now. It is a plain list of names — no paths, no
 * platform logic — so the loader in either direction can resolve each entry
 * against its own root the way it already does.
 */

/** The file the built client and stylesheet are served from. */
export const ASSETS_FILE_NAME = "assets.json";

/** Skia's ICU data, shipped next to the binary on Windows (see
 * scripts/build-server.ts: the canvas binding loads it from there). */
export const ICU_DATA_FILE_NAME = "icudtl.dat";

/** The name the running server reports as its own executable: used to pick
 * the binary out of an archive and to replace it in place. */
export function binaryFileName(execPath: string): string {
  const slash = Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"));
  return slash === -1 ? execPath : execPath.slice(slash + 1);
}

/**
 * Everything a package installs next to the binary, in one list.
 *
 * A directory is an entry of its own: the archive carries it as a tree and
 * the installer replaces it as a tree. `VM_CONTAINER_DIR_NAME` is imported
 * rather than repeated here because the server resolves that name at startup
 * (packages/server/paths.ts) — a third spelling would make the container
 * files live somewhere nothing looks.
 */
export function installedFileNames(execPath: string): string[] {
  return [
    binaryFileName(execPath),
    ASSETS_FILE_NAME,
    ICU_DATA_FILE_NAME,
    VM_CONTAINER_DIR_NAME,
  ];
}
