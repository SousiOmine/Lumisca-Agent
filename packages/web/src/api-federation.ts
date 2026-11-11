import { request } from "./api-client.ts";
import { peerRoutes, sessionRoutes } from "./api-local.ts";
import type { PeerStatus } from "./types.ts";

/** Federated (hub-and-spoke) API: resources owned by a peer server. The
 * agent runs on the peer; the hub only proxies. Every method here mirrors a
 * local `api.*` method through the single `/api/fed/:peerId` proxy (paths
 * are the "/api"-relative form with the peer id added by fedRequest), and
 * the session-scoped ones are the shared table (see sessionRoutes), which
 * takes the peer id as its first argument for exactly that reason.
 *
 * Workspaces are not here: a workspace is the folder set of the server the
 * window displays, and the desktop switches servers from the title bar
 * (`components/ConnectionPicker.tsx`) instead of mixing several machines'
 * workspaces into one list. Sessions still travel: a session that already
 * exists on a peer is reopened from the session list and runs there. */
export const fed = {
  /** Peer reachability: which registered machines answer, and under what
   * name. The session list labels its rows with them; a peer that does not
   * answer contributes no sessions. */
  peers: () => request<{ peers: PeerStatus[] }>("/api/fed/peers"),

  /** The endpoints that exist on both this server and a peer, from the table
   * every surface shares (peerRoutes in api-local.ts). Each takes the peer id
   * as its first argument — the same argument `api`'s local spelling
   * fixes to "" — so a path, method or body cannot be written differently
   * for the two machines. */
  ...peerRoutes,

  /** The session-scoped endpoints of a peer (`getSession`, `prompt`, …),
   * from the table every surface shares (see sessionRoutes). */
  ...sessionRoutes,
};
