/**
 * The skill folders a session's catalog is discovered from.
 *
 * Four call sites built the same options object: the tool set, the
 * sub-agent hub, the catalog provider and the palette. Each repeated the two
 * conditional spreads by hand, so a folder the discovery gained had to be
 * threaded through all of them. This is the one place that knows the shape.
 */

import type { SkillDef } from "../skills/discover.ts";
import { sessionSkills } from "../tools/tool-pieces.ts";

/** The folders this mode discovers skills from, beyond the workspace's own.
 * Both are optional: an absent `appSkillDirs` leaves the discovery's own
 * default in place, and an absent `globalSkillDirs` adds no global folder. */
export interface SkillCatalogSpec {
  /** The mode's shared skills folder (see `appSkillDirs`). */
  appSkillDirs?: string[];
  /** The global skills folder (default ~/.agents/skills). */
  globalSkillDirs?: string[];
}

/** The spec as the tool builders' own option shape (`appSkillDirs` plus
 * `globalSkillDirs`, which they pass to the discovery as `globalDirs`). */
export function skillCatalogDirs(spec: SkillCatalogSpec): {
  appSkillDirs?: string[];
  globalSkillDirs?: string[];
} {
  return {
    ...(spec.appSkillDirs !== undefined
      ? { appSkillDirs: spec.appSkillDirs }
      : {}),
    ...(spec.globalSkillDirs !== undefined
      ? { globalSkillDirs: spec.globalSkillDirs }
      : {}),
  };
}

/** One session's skill catalog, discovered from `folders` plus the mode's
 * own folders. */
export function catalogSkills(
  spec: SkillCatalogSpec,
  folders: string[],
  options: {
    browserAvailable?: boolean;
    computerAvailable?: boolean;
    subagents?: boolean;
    mcpAdmin?: boolean;
    skillAuthoring?: boolean;
  } = {},
): SkillDef[] {
  return sessionSkills(folders, {
    ...options,
    ...(spec.appSkillDirs !== undefined
      ? { appSkillDirs: spec.appSkillDirs }
      : {}),
    ...(spec.globalSkillDirs !== undefined
      ? { globalDirs: spec.globalSkillDirs }
      : {}),
  });
}
