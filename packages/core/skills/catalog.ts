import type {
  ContextProvider,
  ContextUpdate,
} from "../agent/context-providers.ts";
import { sessionSkills } from "../tools/toolsets.ts";
import { formatAvailableSkills } from "./discover.ts";

/**
 * The skill-catalog context provider: publishes the session's
 * `<available_skills>` listing as a durable transcript message instead of
 * baking it into the system prompt. Two reasons, both taken from the DeepSeek
 * Harness's skill catalog:
 *
 * - the system prompt stays free of per-session data (it is written once and
 *   never needs to change while the session lives), and
 * - a skill added or removed on disk reaches an open session: the catalog is
 *   re-discovered before every run and republished only when it changed.
 */

/** Provider name of the skill catalog. */
export const SKILLS_PROVIDER = "skills";

export interface SkillCatalogOptions {
  /** Workspace folders to discover skills from (empty for a chat session,
   * which sees the global and built-in skills only). */
  folders: string[];
  /** Whether the session has a browser backend attached (gates the built-in
   * web-browser skill, like the skill tool's own catalog). */
  browserAvailable?: boolean;
  /** Global skills directory override (tests); see sessionSkills. */
  globalDirs?: string[];
}

interface CatalogState {
  text: string;
}

function textOf(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const text = (state as CatalogState).text;
  return typeof text === "string" ? text : undefined;
}

export function createSkillCatalogProvider(
  options: SkillCatalogOptions,
): ContextProvider {
  /** The listing of the last publication; undefined until the first one. */
  let published: string | undefined;

  return {
    name: SKILLS_PROVIDER,
    next(): ContextUpdate[] {
      const skills = sessionSkills(options.folders, {
        browserAvailable: options.browserAvailable,
        globalDirs: options.globalDirs,
      });
      const listing = formatAvailableSkills(skills);
      if (listing.length === 0) {
        // Nothing to announce for a session without skills. A catalog that
        // emptied out is worth one message: the earlier listing is stale.
        if (published === undefined) return [];
        published = undefined;
        return [{
          title: "Skills (none available)",
          body: "No skills are available in this session any more.",
        }];
      }
      if (published === listing) return [];

      const listed = listing.split("\n").length;
      const hidden = skills.length - listed;
      const body = `Skills available to this session${
        published === undefined
          ? ""
          : " (this catalog replaces the earlier one)"
      }. Load a skill with the skill tool before starting work that matches it.
${
        hidden > 0
          ? `Only the first ${listed} skills are listed; the remaining ` +
            `${hidden} stay loadable with the skill tool by name.\n`
          : ""
      }
<available_skills>
${listing}
</available_skills>`;
      published = listing;
      return [{
        title: `Skills (${skills.length} available)`,
        body,
        state: { text: listing } satisfies CatalogState,
      }];
    },
    rebase(state: unknown): void {
      published = textOf(state);
    },
  };
}
