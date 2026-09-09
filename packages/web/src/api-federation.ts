import type {
  AgentMessage,
  AskAnswer,
  BackgroundCommandInfo,
  FederatedWorkspace,
  GoalInfo,
  ModelInfo,
  ModePrompt,
  PeerStatus,
  PendingImage,
  ProviderInfo,
  SessionInfo,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
  Workspace,
  WorkspaceFileEntry,
} from "./types.ts";
import { fedRequest, promptBody, request, sessionPath } from "./api-client.ts";
import type { SessionInfoDto } from "./api-local.ts";

/** Federated (hub-and-spoke) API: resources owned by a peer server. The
 * agent runs on the peer; the hub only proxies. Every method here mirrors a
 * local `api.*` method through the single `/api/fed/:peerId` proxy (paths
 * are the "/api"-relative form with the peer id added by fedRequest). */
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
  fsRoots: (peerId: string) => fedRequest<string[]>(peerId, "/fs/roots"),
  fsBrowse: (peerId: string, path: string) =>
    fedRequest<
      {
        path: string;
        parent: string | null;
        entries: Array<{ name: string; path: string }>;
      }
    >(
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
  createSession: (peerId: string, input: {
    workspaceId?: string;
    name?: string;
  }) =>
    fedRequest<SessionInfo>(peerId, "/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getSession: (peerId: string, sessionId: string) =>
    fedRequest<SessionInfoDto>(peerId, sessionPath(sessionId)),
  getMessages: (peerId: string, sessionId: string) =>
    fedRequest<AgentMessage[]>(peerId, sessionPath(sessionId, "/messages")),
  /** All sessions of a peer, newest first (for the recent sessions list). */
  listSessions: (peerId: string) =>
    fedRequest<SessionInfo[]>(peerId, "/sessions"),
  getTodo: (peerId: string, sessionId: string) =>
    fedRequest<{ todos: TodoPhase[] }>(peerId, sessionPath(sessionId, "/todo")),
  getTasks: (peerId: string, sessionId: string) =>
    fedRequest<{ tasks: TaskInfo[] }>(
      peerId,
      sessionPath(sessionId, "/tasks"),
    ),
  getBackground: (peerId: string, sessionId: string) =>
    fedRequest<{ backgrounds: BackgroundCommandInfo[] }>(
      peerId,
      sessionPath(sessionId, "/background"),
    ),
  getGoal: (peerId: string, sessionId: string) =>
    fedRequest<{ goal: GoalInfo | null }>(
      peerId,
      sessionPath(sessionId, "/goal"),
    ),
  cancelGoal: (peerId: string, sessionId: string) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      sessionPath(sessionId, "/goal"),
      { method: "DELETE" },
    ),
  closeSession: (peerId: string, sessionId: string) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      sessionPath(sessionId, "/close"),
      { method: "POST" },
    ),
  prompt: (
    peerId: string,
    sessionId: string,
    text: string,
    images?: PendingImage[],
    mode?: ModePrompt,
  ) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      sessionPath(sessionId, "/prompt"),
      { method: "POST", body: JSON.stringify(promptBody(text, images, mode)) },
    ),
  abort: (peerId: string, sessionId: string) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      sessionPath(sessionId, "/abort"),
      { method: "POST" },
    ),
  rewind: (peerId: string, sessionId: string, timestamp: number) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      sessionPath(sessionId, "/rewind"),
      { method: "POST", body: JSON.stringify({ timestamp }) },
    ),
  /** Answer a pending ask of a remote session (the agent runs on the peer;
   * the answer is forwarded to the machine holding the question). */
  answer: (
    peerId: string,
    sessionId: string,
    toolCallId: string,
    answers: AskAnswer[],
  ) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      sessionPath(sessionId, "/answer"),
      { method: "POST", body: JSON.stringify({ toolCallId, answers }) },
    ),
  updateSessionModel: (
    peerId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ) =>
    fedRequest<SessionInfo>(
      peerId,
      sessionPath(sessionId, "/model"),
      { method: "POST", body: JSON.stringify({ provider, modelId }) },
    ),
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
};
