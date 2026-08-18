import type { Sandbox } from "../workspace/sandbox.ts";

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
