/**
 * Background model-catalog refresh for the long-running entry point (the
 * server). One home so the startup policy — never block startup, never
 * fail it when offline — stays in one place.
 */
import { createLogger } from "../log.ts";
import { errorMessage } from "../errors.ts";
import type { CatalogStatus } from "../shared/providers.ts";

const log = createLogger("catalog");

/** The core surface this helper needs (implemented by LumiscaCore). */
export interface CatalogRefresher {
  refreshModelCatalog(): Promise<CatalogStatus>;
}

/**
 * Refresh the live model catalog without blocking startup, or failing it
 * when the machine is offline: the bundled snapshot simply stays active and
 * the reason is logged at debug level.
 *
 * Callers that resolve a model immediately after startup must NOT use this
 * — a refresh landing mid-resolve could drop the model that was just
 * selected, leaving the session pointing at a model that no longer exists.
 */
export function refreshCatalogInBackground(core: CatalogRefresher): void {
  void core.refreshModelCatalog()
    .then((status) =>
      log.debug(`model catalog refreshed from ${status.source}`)
    )
    .catch((error) =>
      log.debug(`model catalog refresh failed: ${errorMessage(error)}`)
    );
}
