/** API surface barrel (split for single responsibility):
 * - `./api-client.ts` — request/fedRequest/sessionRequest/peerRouted/
 *   promptBody/token plus the session-route binders,
 * - `./api-local.ts` — the session route table and `api` (this server),
 * - `./api-federation.ts` — `fed` (peer servers via the fed proxy),
 * - `./api-routing.ts` — sessionApi/modelApi/connectEvents. */
export { api, type SessionInfoDto } from "./api-local.ts";
export type { SessionSnapshot } from "@lumisca/core/shared";
export { fed } from "./api-federation.ts";
export { connectEvents, modelApi, sessionApi } from "./api-routing.ts";
