import { Hono } from "hono";
import type { SessionInfo, SkillInfo } from "@lumisca/core";
import type { StellaAvailability } from "@lumisca/core";
import { AppError, parseBody } from "./util.ts";

/** The slice of the core these routes need (interface segregation). */
export interface StellaApi {
  getAppMode(): "code" | "stella" | undefined;
  setAppMode(mode: "code" | "stella"): void;
  getStellaAvailability(): Promise<StellaAvailability>;
  getStellaStatus(): Promise<{
    availability: StellaAvailability;
    state: string;
    vncPort: number | null;
    reason: string;
  }>;
  startStellaVm(): Promise<void>;
  stopStellaVm(): Promise<void>;
  resetStellaVm(): Promise<void>;
  getOrCreateStellaSession(): Promise<SessionInfo>;
  listStellaSkills(): SkillInfo[];
}

/**
 * The stella machine's API.
 *
 * These routes are mounted unconditionally: a machine that cannot run on
 * this host answers with its reason instead of a 404, so the mode-selection
 * screen can explain itself. Only `POST /stella/start` and the conversation
 * endpoints refuse with an error — those are actions that cannot be
 * simulated.
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
    // Check the machine before asking the core to store the choice: the
    // core refuses a stella mode whose availability was never established,
    // and this route is what establishes it.
    if (mode === "stella") await core.getStellaAvailability();
    try {
      core.setAppMode(mode);
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : String(error),
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
    };
  };

  app.post("/stella/start", async (c) => {
    try {
      await core.startStellaVm();
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : String(error),
        503,
      );
    }
    return c.json(await statusBody());
  });

  app.post("/stella/stop", async (c) => {
    await core.stopStellaVm();
    return c.json(await statusBody());
  });

  /** Throw the machine away. Everything inside goes with it, so the client
   * confirms with the user first; the conversation itself survives (it is
   * in this application's database, not in the machine). */
  app.post("/stella/reset", async (c) => {
    try {
      await core.resetStellaVm();
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : String(error),
        503,
      );
    }
    return c.json(await statusBody());
  });

  /** The stella conversation, created on first use. Its id is what the
   * client uses for every session-scoped call (prompt, messages, abort). */
  app.get("/stella/session", async (c) => {
    try {
      return c.json(await core.getOrCreateStellaSession());
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : String(error),
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
