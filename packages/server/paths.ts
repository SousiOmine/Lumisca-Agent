import { join } from "node:path";

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

/** esbuild alias target for `@lumisca/core/shared` (the browser-safe
 * helper module; esbuild does not read deno.json workspace exports). */
export function coreSharedPath(repoRoot: string): string {
  return join(repoRoot, "packages", "core", "shared.ts");
}
