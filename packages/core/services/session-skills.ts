import type { SkillInfo } from "../skills/discover.ts";
import { skillInfo } from "../skills/discover.ts";
import { sessionSkills } from "../tools/toolsets.ts";
import type { SessionServiceDeps } from "./session-deps.ts";

type Deps = Pick<
  SessionServiceDeps,
  | "requireWorkspace"
  | "browserAvailable"
  | "computerAvailable"
  | "globalSkillDirs"
  | "appSkillDirs"
  | "stellaSkills"
>;

/**
 * The skills a session can load, as the palette and the guide list them.
 *
 * The discovery is the same one the agent's `skill` tool and the catalog
 * provider run, so the list a user picks from and the list the model is told
 * about cannot diverge. A code-mode session gets the workspace's skills, the
 * plugins and the user's folders; a stella conversation gets its agent's own
 * folder, the machine's shared folder and the same user folders, which the
 * machine side has already discovered.
 */
export class SessionSkills {
  constructor(private readonly deps: Deps) {}

  /** The skills a session in this workspace would get. */
  listSkills(workspaceId?: string): SkillInfo[] {
    const folders =
      workspaceId === undefined
        ? []
        : this.deps.requireWorkspace(workspaceId).folders;
    return sessionSkills(folders, {
      browserAvailable: this.deps.browserAvailable(),
      computerAvailable: this.deps.computerAvailable(),
      // The palette lists what this workspace's main agent can load.
      mcpAdmin: true,
      // A workspace session is a coding session (it has the file tools the
      // guide teaches); the folder-less chat subset does not.
      skillAuthoring: workspaceId !== undefined,
      ...(this.deps.appSkillDirs !== undefined
        ? { appSkillDirs: this.deps.appSkillDirs }
        : {}),
      ...(this.deps.globalSkillDirs !== undefined
        ? { globalDirs: this.deps.globalSkillDirs }
        : {}),
    }).map(skillInfo);
  }

  /** One stella conversation's skill catalog. */
  listStellaSkills(agentId: string): SkillInfo[] {
    return this.deps.stellaSkills(agentId).map(skillInfo);
  }
}
