import type { SessionPool } from "../agent/pool.ts";
import { CoreError } from "../errors.ts";
import type {
  PendingShareRequest,
  ShareRequestRegistry,
} from "../share/request.ts";
import type {
  EnvRequestRegistry,
  PendingEnvRequest,
} from "../vm/env-request.ts";
import type { PendingHandover } from "../vm/handover.ts";
import type { HandoverRegistry } from "../vm/handover-registry.ts";

export interface SessionInterruptionsDeps {
  pool: SessionPool;
  handovers: HandoverRegistry;
  envRequests: EnvRequestRegistry;
  shareRequests: ShareRequestRegistry;
}

/**
 * The waits a blocked run leaves for the user: the screen hand-over, the
 * secret environment variable and the folder loan. The pool owns the live
 * agent that carries the pending value; the registries own the hubs the
 * answers arrive through. Keeping both here is what lets the facade answer a
 * dialog without reaching into the pool itself.
 */
export class SessionInterruptions {
  constructor(private readonly deps: SessionInterruptionsDeps) {}

  getPendingHandover(sessionId: string): PendingHandover | null {
    return this.deps.pool.get(sessionId)?.getPendingHandover() ?? null;
  }

  finishHandover(sessionId: string, note: string, toolCallId?: string): void {
    const agent = this.deps.pool.require(sessionId);
    agent.finishHandover(note, toolCallId);
  }

  getPendingEnvRequest(sessionId: string): PendingEnvRequest | null {
    return this.deps.pool.get(sessionId)?.getPendingEnvRequest() ?? null;
  }

  getPendingShareRequest(sessionId: string): PendingShareRequest | null {
    return this.deps.pool.get(sessionId)?.getPendingShareRequest() ?? null;
  }

  finishShareLend(sessionId: string, toolCallId?: string): void {
    const hub = this.deps.shareRequests.get(sessionId);
    if (hub === undefined) {
      throw new CoreError("No folder is waiting to be lent", "not_found");
    }
    hub.finishLend(toolCallId);
  }

  declineShareRequest(sessionId: string, toolCallId?: string): void {
    const hub = this.deps.shareRequests.get(sessionId);
    if (hub === undefined) {
      throw new CoreError("No folder is waiting to be lent", "not_found");
    }
    hub.decline(toolCallId);
  }

  finishShareDisconnect(sessionId: string, toolCallId: string): void {
    const hub = this.deps.shareRequests.get(sessionId);
    if (hub === undefined) {
      throw new CoreError(
        "No lent folder is waiting to be withdrawn",
        "not_found",
      );
    }
    hub.finishDisconnect(toolCallId);
  }

  failShareDisconnect(
    sessionId: string,
    toolCallId: string,
    error: string,
  ): void {
    const hub = this.deps.shareRequests.get(sessionId);
    if (hub === undefined) {
      throw new CoreError(
        "No lent folder is waiting to be withdrawn",
        "not_found",
      );
    }
    hub.failDisconnect(toolCallId, error);
  }
}
