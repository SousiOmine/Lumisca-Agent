import type { Sandbox } from "../workspace/sandbox.ts";
import { CoreError } from "../errors.ts";

/** Resolve a path against the workspace sandbox, returning the resolved path
 * or throwing its rejection reason. Shared by every tool that takes a path
 * argument, so "unresolvable path → throw" stays consistent across tools. */
export async function requireResolved(
  sandbox: Sandbox,
  requested: string,
): Promise<string> {
  const resolved = await sandbox.resolve(requested);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.path;
}

/** Resolve `requested` and require an existing file — the pair of checks
 * every file-oriented tool needs (read, grep, pdf_read_pages, visual,
 * present): the path must resolve inside the sandbox and must not be a
 * directory. Keeping both here means the wording and the error kind
 * (`not_found` / `invalid`) cannot drift between those tools. */
export async function requireExistingFile(
  sandbox: Sandbox,
  requested: string,
): Promise<string> {
  const path = await requireResolved(sandbox, requested);
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new CoreError(`Path does not exist: ${requested}`, "not_found");
    }
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new CoreError(`Permission denied: ${requested}`, "forbidden");
    }
    // Anything else is not an argument problem: let the real error through
    // instead of reporting an existing path as missing.
    throw error;
  }
  if (stat.isDirectory) {
    throw new CoreError(`Is a directory: ${requested}`, "invalid");
  }
  return path;
}
