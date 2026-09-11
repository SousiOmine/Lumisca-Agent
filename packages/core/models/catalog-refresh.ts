/**
 * Background model-catalog refresh for the long-running entry points (the
 * server and the interactive CLI). One home so the startup policy — never
 * block startup, never fail it when offline — cannot drift between them.
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
 * Callers that resolve a model immediately after startup (the one-shot
 * `lumisca run`) must NOT use this — a refresh landing mid-resolve could
 * drop the model that was just selected.
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
