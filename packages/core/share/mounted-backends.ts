/**
 * The session's file and command surfaces, with the folders lent to it from
 * the user's own computers folded in.
 *
 * One function for both, because they answer together: a tool that can read a
 * lent folder but not run anything in it is exactly a MountedRunner refusal,
 * and a folder lent WITH commands is exactly a MountedRunner route. Callers
 * (the agent factory) get the pair the union of {@link ToolBackends} declares,
 * so a session cannot end up with one half mounted.
 */

import type { ToolBackends } from "../tools/tool-pieces.ts";
import type { ShareHub } from "./hub.ts";
import { MountedFiles } from "./mounted-files.ts";
import { MountedRunner } from "./mounted-runner.ts";

/**
 * `primary` extended with every folder lent to `sessionId`.
 *
 * The grants are read through a getter on every call rather than captured: a
 * loan can be made, narrowed or withdrawn while a run is going, and the tools
 * must follow without the agent being rebuilt (the rebuild exists for changes
 * that alter the tool SET, and a loan alters what one tool can reach). With
 * `hub` omitted the session's own backends are returned unchanged — a pool
 * built by hand has no share channel, and wrapping nothing would only add a
 * lookup per call.
 */
export function mountedBackends(
  primary: ToolBackends,
  hub: ShareHub | undefined,
  sessionId: string,
): ToolBackends {
  if (hub === undefined) return primary;
  const grants = () => hub.grantsFor(sessionId);
  return {
    files: new MountedFiles(primary.files, hub, grants),
    runner: new MountedRunner(primary.runner, hub, grants),
  };
}
