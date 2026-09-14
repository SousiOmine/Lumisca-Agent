import { Hono } from "hono";
import type { SkillInfo } from "@lumisca/core";

/** The slice of the core these routes need (interface segregation). */
export interface SkillApi {
  /** The skills a session in this workspace would get; omitted workspaceId
   * → a chat session's skills (global and built-in only). */
  listSkills(workspaceId?: string): SkillInfo[];
}

export function skillRoutes(core: SkillApi): Hono {
  const app = new Hono();

  /** The skills a session in this workspace would see. The composer's
   * `/skill` palette and the agent's skill tool read the same discovery
   * (see LumiscaCore.listSkills), so the palette never offers a skill the
   * agent cannot load. Omitting workspaceId asks for a chat session's
   * skills — the same "omitted → chat" contract as POST /sessions. An
   * unknown id is a 404, never a silent fallback to the chat list. */
  app.get("/skills", (c) => {
    return c.json({ skills: core.listSkills(c.req.query("workspaceId")) });
  });

  return app;
}
