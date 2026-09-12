import { Hono } from "hono";
import type { UpdateStatus } from "../update/service.ts";
import { parseBody, requireBoolean } from "./util.ts";

/** The slice of the updater the HTTP layer needs (interface segregation:
 * the routes never reach into the state machine). `UpdateService` satisfies
 * it structurally. */
export interface UpdateApi {
  status(): UpdateStatus;
  setAuto(enabled: boolean): UpdateStatus;
  setAutoRestart(enabled: boolean): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  apply(): Promise<UpdateStatus>;
  restart(): Promise<UpdateStatus>;
}

/**
 * Auto-update endpoints of the standalone server. The desktop shell has its
 * own updater (packages/desktop src-tauri/src/update.rs) behind the shell
 * bridge; these serve the same UI when the page is opened in a browser, so
 * the response shape matches that bridge.
 *
 * Every action answers with the fresh status — including failures: a failed
 * check or download is reported in `error` (like the desktop's does) rather
 * than as an HTTP error, because the caller's question is "what is the state
 * now", and a rejected request would only say "something went wrong". Input
 * errors (a malformed body) stay 4xx.
 */
export function updateRoutes(update: UpdateApi): Hono {
  const app = new Hono();

  app.get("/update/status", (c) => c.json(update.status()));

  app.post("/update/set-auto", async (c) => {
    const body = await parseBody<{ enabled?: unknown }>(c);
    return c.json(update.setAuto(requireBoolean(body?.enabled, "enabled")));
  });

  app.post("/update/set-auto-restart", async (c) => {
    const body = await parseBody<{ enabled?: unknown }>(c);
    return c.json(
      update.setAutoRestart(requireBoolean(body?.enabled, "enabled")),
    );
  });

  app.post("/update/check", async (c) => c.json(await update.check()));
  app.post("/update/download", async (c) => c.json(await update.download()));

  // "install" applies the staged package (the files next to the binary); the
  // running process keeps serving until the restart is asked for.
  app.post("/update/install", async (c) => c.json(await update.apply()));

  app.post("/update/restart", async (c) => c.json(await update.restart()));

  return app;
}
