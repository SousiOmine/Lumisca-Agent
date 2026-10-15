import type {
  FederatedWorkspace,
  FsBrowse,
  FsPlace,
  ModelInfo,
  PeerStatus,
  ProviderInfo,
  SessionInfo,
  SkillInfo,
  ThinkingLevel,
  Workspace,
  WorkspaceFileEntry,
} from "./types.ts";
import { fedRequest, request } from "./api-client.ts";
import { sessionRoutes } from "./api-local.ts";

/** Federated (hub-and-spoke) API: resources owned by a peer server. The
 * agent runs on the peer; the hub only proxies. Every method here mirrors a
 * local `api.*` method through the single `/api/fed/:peerId` proxy (paths
 * are the "/api"-relative form with the peer id added by fedRequest), and
 * the session-scoped ones are the shared table (see sessionRoutes), which
 * takes the peer id as its first argument for exactly that reason. */
export const fed = {
  /** Merged workspace list (hub + peers) with peer reachability. */
  workspaces: () =>
    request<{ workspaces: FederatedWorkspace[]; peers: PeerStatus[] }>(
      "/api/fed/workspaces",
    ),
  createWorkspace: (peerId: string, name: string, folders: string[]) =>
    fedRequest<Workspace>(peerId, "/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, folders }),
    }),
  updateWorkspace: (
    peerId: string,
    id: string,
    input: { name?: string; folders?: string[] },
  ) =>
    fedRequest<Workspace>(peerId, `/workspaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteWorkspace: (peerId: string, id: string) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      `/workspaces/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  /** A peer's folder-picker places (the sidebar: its user folders plus its
   * filesystem roots). */
  fsPlaces: (peerId: string) => fedRequest<FsPlace[]>(peerId, "/fs/places"),
  fsBrowse: (peerId: string, path: string) =>
    fedRequest<FsBrowse>(
      peerId,
      `/fs/browse?path=${encodeURIComponent(path)}`,
    ),
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
  createSession: (peerId: string, input: {
    workspaceId?: string;
    name?: string;
  }) =>
    fedRequest<SessionInfo>(peerId, "/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
