import { CoreError } from "../errors.ts";
import type { FileBackend } from "./file-backend.ts";

/** Resolve a path against the file backend, returning the resolved path or
 * throwing its rejection reason. Shared by every tool that takes a path
 * argument, so "unresolvable path → throw" stays consistent across tools. */
export async function requireResolved(
  files: FileBackend,
  requested: string,
): Promise<string> {
  const resolved = await files.resolve(requested);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.path;
}

/** Resolve `requested` and require an existing file — the pair of checks
 * every file-oriented tool needs (read, visual, pdf_read_pages): the path
 * must resolve inside the backend's roots and must not be a directory.
 * Keeping both here means the wording cannot drift between those tools. */
export async function requireExistingFile(
  files: FileBackend,
  requested: string,
): Promise<string> {
  const path = await requireResolved(files, requested);
  const stat = await files.stat(path);
  if (stat === undefined) {
    throw new CoreError(`Path does not exist: ${requested}`, "not_found");
  }
  if (!stat.isFile) {
    throw new CoreError(`Is a directory: ${requested}`, "invalid");
  }
  return path;
}
