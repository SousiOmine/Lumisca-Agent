import { Hono } from "hono";
import type { SessionInfo, SkillInfo, StellaAgent } from "@lumisca/core";
import type { StellaAvailability } from "@lumisca/core";
import { CoreError } from "@lumisca/core";
import { errorMessage } from "@lumisca/core";
import { AppError, parseBody, requireNonEmptyString } from "./util.ts";

/** The slice of the core these routes need (interface segregation). */
export interface StellaApi {
  listStellaAgents(): StellaAgent[];
  defaultStellaAgent(): StellaAgent | undefined;
  createStellaAgent(input: { name: string; role: string }): StellaAgent;
  renameStellaAgent(id: string, name: string): StellaAgent;
  deleteStellaAgent(id: string): Promise<void>;
  getAppMode(): "code" | "stella" | undefined;
  setAppMode(mode: "code" | "stella"): void;
  getStellaAvailability(): Promise<StellaAvailability>;
  getStellaStatus(): Promise<{
    availability: StellaAvailability;
    state: string;
    vncPort: number | null;
    reason: string;
    starting: boolean;
  }>;
  /** Bring the machine up if it is not (the first conversation starts it). */
  ensureStellaReady(): Promise<void>;
  getOrCreateStellaSession(agentId?: string): Promise<SessionInfo>;
  listStellaSkills(): SkillInfo[];
}

/**
 * The stella machine's API.
 *
 * There is no start / stop / reset route: the machine is started by the code
 * that needs it (the conversation endpoint) and stopped when the server stops.
 * A user who picked stella mode asked for a machine, not for a container to
 * operate, and every control that existed only to move it between states was
 * something to read, understand and get wrong.
 *
 * These routes are mounted unconditionally: a machine that cannot run on this
 * host answers with its reason instead of a 404, so the mode-selection screen
 * can explain itself.
 */
export function stellaRoutes(core: StellaApi): Hono {
  const app = new Hono();

  /** Choose the mode. A dedicated route rather than the generic settings
   * surface: switching to stella is a capability check (the machine must be
   * usable), not a value write. Switching is allowed while a run is going in
   * either mode — the modes are separate surfaces and stopping someone's work
   * to change a view would be surprising. */
  app.put("/stella/mode", async (c) => {
    const body = await parseBody<{ mode?: unknown }>(c);
    const mode = body?.mode;
    if (mode !== "code" && mode !== "stella") {
      throw new AppError('mode must be "code" or "stella"', 400);
    }
    try {
      core.setAppMode(mode);
    } catch (error) {
      throw new AppError(
        errorMessage(error),
        503,
      );
    }
    return c.json(await statusBody());
  });

  /** The stored mode plus what this host can do, in one call: the client
   * needs both to decide between showing its tabs and showing the mode
   * picker. */
  app.get("/stella/status", async (c) => {
    return c.json(await statusBody());
  });

  /** The one shape every stella route answers with: the stored mode plus the
   * machine's state. One builder so the mode route's answer and the status
   * route's answer cannot describe different worlds. */
  const statusBody = async () => {
    const status = await core.getStellaStatus();
    return {
      mode: core.getAppMode() ?? null,
      availability: status.availability,
      state: status.state,
      vncPort: status.vncPort,
      reason: status.reason,
      starting: status.starting,
    };
  };

  // --- agents (the agent of each conversation) -----------------------------

  /** The sidebar's list, most recently used first, plus which one a fresh
   * screen opens. */
  app.get("/stella/agents", (c) => {
    return c.json({
      agents: core.listStellaAgents(),
      defaultAgentId: core.defaultStellaAgent()?.id ?? null,
    });
  });

  app.post("/stella/agents", async (c) => {
    const body = await parseBody<{ name?: unknown; role?: unknown }>(c);
    const name = requireNonEmptyString(body?.name, "name");
    const role = requireNonEmptyString(body?.role, "role");
    try {
      return c.json(core.createStellaAgent({ name, role }), 201);
    } catch (error) {
      // A duplicate name is a conflict (409), not a malformed request: the
      // client shows it as "that name is taken" rather than as a typo.
      throw new AppError(
        errorMessage(error),
        error instanceof CoreError && error.kind === "conflict" ? 409 : 400,
      );
    }
  });

  app.patch("/stella/agents/:id", async (c) => {
    const body = await parseBody<{ name?: unknown }>(c);
    const name = requireNonEmptyString(body?.name, "name");
    try {
      return c.json(core.renameStellaAgent(c.req.param("id"), name));
    } catch (error) {
      throw new AppError(
        errorMessage(error),
        error instanceof CoreError && error.kind === "not_found" ? 404 : 400,
      );
    }
  });

  /** Delete an agent and its conversation. The client confirms first: the
   * transcript goes with it. */
  app.delete("/stella/agents/:id", async (c) => {
    await core.deleteStellaAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** The stella conversation, created on first use. Its id is what the
   * client uses for every session-scoped call (prompt, messages, abort).
   *
   * This is also where the machine starts: a conversation needs it, and no
   * other endpoint is guaranteed to run first. A first run builds the image,
   * so the response can take minutes — the client shows that as its one
   * piece of machine state. */
  app.get("/stella/session", async (c) => {
    try {
      await core.ensureStellaReady();
      const agentId = c.req.query("agentId");
      return c.json(
        await core.getOrCreateStellaSession(
          agentId === undefined || agentId === "" ? undefined : agentId,
        ),
      );
    } catch (error) {
      throw new AppError(
        errorMessage(error),
        503,
      );
    }
  });

  /** The skills a stella session's agent can load (the machine's own, the
   * user's global set, the built-ins) — the composer's `/skill` palette. */
  app.get("/stella/skills", (c) => {
    return c.json({ skills: core.listStellaSkills() });
  });

  return app;
}
