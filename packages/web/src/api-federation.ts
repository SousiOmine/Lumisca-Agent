import type {
  ModelInfo,
  PeerStatus,
  ProviderInfo,
  SessionInfo,
  SkillInfo,
  ThinkingLevel,
  WorkspaceFileEntry,
} from "./types.ts";
import { fedRequest, request } from "./api-client.ts";
import { sessionRoutes } from "./api-local.ts";

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
  workspaceFiles: (peerId: string, workspaceId: string, query: string) =>
    fedRequest<{ entries: WorkspaceFileEntry[] }>(
      peerId,
      `/workspaces/${encodeURIComponent(workspaceId)}/files?query=${
        encodeURIComponent(query)
      }`,
    ),
  /** A peer's skills for a workspace (the `/skill` palette of a session
   * running there); omitted workspaceId → its chat skills. */
  getSkills: (peerId: string, workspaceId?: string) =>
    fedRequest<{ skills: SkillInfo[] }>(
      peerId,
      workspaceId === undefined
        ? "/skills"
        : `/skills?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  /** All sessions of a peer, newest first (for the recent sessions list). */
  listSessions: (peerId: string) =>
    fedRequest<SessionInfo[]>(peerId, "/sessions"),
  /** The peer's providers/models (model picker data for remote sessions). */
  listProviders: (peerId: string) =>
    fedRequest<ProviderInfo[]>(peerId, "/providers"),
  listModels: (peerId: string, providerId: string) =>
    fedRequest<ModelInfo[]>(
      peerId,
      `/providers/${encodeURIComponent(providerId)}/models`,
    ),
  setModelThinkingLevel: (
    peerId: string,
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ) =>
    fedRequest<{ ok: boolean; thinkingLevel: ThinkingLevel }>(
      peerId,
      `/providers/${encodeURIComponent(providerId)}/models/${
        encodeURIComponent(modelId)
      }/thinking-level`,
      { method: "PUT", body: JSON.stringify({ level }) },
    ),

  /** The session-scoped endpoints of a peer (`getSession`, `prompt`, …),
   * from the table every surface shares (see sessionRoutes). */
  ...sessionRoutes,
};
