import type { SetupState } from "@lumisca/core/shared";
import { Hono } from "hono";

/** The slice of the core these routes need (interface segregation). */
export interface SetupApi {
  /** Whether this installation's first-run setup is done (a marker file
   * beside the settings file; see core/settings/setup.ts). */
  getSetup(): SetupState;
  /** Write the marker. Idempotent. */
  completeSetup(): SetupState;
}

/**
 * The first-run setup: one fact, and the one transition it has.
 *
 * There is no "reset": the marker file is the one way to ask for the wizard
 * again (delete it), so this surface cannot be used to hide an installation's
 * setup state from whoever reads the config directory by hand.
 *
 * Both answers have the same shape because both are the state after the call:
 * a client that just finished does not have to ask again.
 */
export function setupRoutes(core: SetupApi): Hono {
  const app = new Hono();

  app.get("/setup", (c) => c.json(core.getSetup()));

  app.post("/setup/complete", (c) => c.json(core.completeSetup()));

  return app;
}
