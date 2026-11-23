/** API surface barrel (split for single responsibility):
 * - `./api-client.ts` — request/fedRequest/sessionRequest/peerRouted/
 *   promptBody/token, the failure classifiers and the route-table binders,
 * - `./api-conversation.ts` — the calls a session and a conversation answer
 *   the same way (revision, prompt, abort, rewind, answer), stated once,
 * - `./api-local.ts` — the two route tables (sessionRoutes, peerRoutes) and
 *   `api` (this server),
 * - `./api-federation.ts` — `fed` (peer servers via the fed proxy),
 * - `./api-routing.ts` — sessionApi/modelApi/connectEvents. */

export type { SessionSnapshot } from "@lumisca/core/shared";
export { peerRouted } from "./api-client.ts";
export { fed } from "./api-federation.ts";
export { api, peerRoutes, type SessionInfoDto } from "./api-local.ts";
export { connectEvents, modelApi, sessionApi } from "./api-routing.ts";
