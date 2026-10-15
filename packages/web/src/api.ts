/** API surface barrel (split for single responsibility):
 * - `./api-client.ts` — request/fedRequest/sessionRequest/peerRouted/
 *   promptBody/token plus the session-route binders,
 * - `./api-local.ts` — the session route table and `api` (this server),
 * - `./api-federation.ts` — `fed` (peer servers via the fed proxy),
 * - `./api-routing.ts` — sessionApi/workspaceApi/modelApi/connectEvents. */
export { api, type SessionInfoDto, type SessionSnapshot } from "./api-local.ts";
export { fed } from "./api-federation.ts";
export {
  connectEvents,
  modelApi,
  sessionApi,
  workspaceApi,
} from "./api-routing.ts";
