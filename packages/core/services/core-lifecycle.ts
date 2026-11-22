import * as fsp from "node:fs/promises";
import type { SessionPool } from "../agent/pool.ts";
import type { CoreState } from "../bootstrap.ts";
import type { LumiscaDb } from "../db/mod.ts";
import { MIN_VACUUM_BYTES, vacuumMarkerPath } from "../db/vacuum.ts";
import { errorMessage } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { createLogger } from "../log.ts";
import type { McpService } from "../mcp/service.ts";
import type { ShareHub } from "../share/hub.ts";
import type { EnvRequestRegistry } from "../vm/env-request.ts";
import type { HandoverRegistry } from "../vm/handover-registry.ts";
import type { StellaMachine } from "../vm/machine.ts";

const log = createLogger("core");

export interface CoreLifecycleDeps {
  routines: { close(): void };
  mcp: Pick<McpService, "close">;
  shareHub: Pick<ShareHub, "close">;
  pool: Pick<SessionPool, "closeAll">;
  events: Pick<EventHub, "sessionIds">;
  handovers: Pick<HandoverRegistry, "sessionIds">;
  envRequests: Pick<EnvRequestRegistry, "sessionIds">;
  shareRequests: { sessionIds(): Iterable<string> };
  stella: Pick<StellaMachine, "stopAll">;
  db: Pick<LumiscaDb, "close">;
  state: CoreState;
  dbPath: string | undefined;
  forgetSession(sessionId: string): void;
}

/** Shut the core down: stop the timers, close the MCP connections, release
 * the sessions and the machines, close the database, then note whether the
 * file is worth rewriting at the next start. */
export async function closeCore(deps: CoreLifecycleDeps): Promise<void> {
  deps.routines.close();
  deps.mcp.close();
  deps.shareHub.close();
  await deps.pool.closeAll();
  const forgotten = new Set([
    ...deps.events.sessionIds(),
    ...deps.handovers.sessionIds(),
    ...deps.envRequests.sessionIds(),
    ...deps.shareRequests.sessionIds(),
  ]);
  for (const sessionId of forgotten) deps.forgetSession(sessionId);
  await deps.stella.stopAll();
  deps.db.close();
  await requestVacuumIfWorthwhile(deps);
}

async function requestVacuumIfWorthwhile(
  deps: Pick<CoreLifecycleDeps, "state" | "dbPath">,
): Promise<void> {
  if (deps.state.freedBytes < MIN_VACUUM_BYTES || deps.dbPath === undefined) {
    return;
  }
  try {
    await fsp.writeFile(
      vacuumMarkerPath(deps.dbPath),
      String(deps.state.freedBytes),
      { mode: 0o600 },
    );
  } catch (error) {
    log.warn(`could not request a database rewrite: ${errorMessage(error)}`);
  }
}
