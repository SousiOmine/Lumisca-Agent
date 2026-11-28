import type {
  AskAnswer,
  ClientEvent,
  FolderShare,
  PromptFileRef,
  SessionInfo,
  StellaAgent,
  StellaAgentSummary,
  StellaEntry,
  StellaEnvRequest,
  StellaHandover,
  StellaQuestion,
  StellaShareRequest,
  WindowQuery,
} from "@lumisca/core";
import type {
  StellaMachineStatus,
  StellaStatus,
  ThinkingLevel,
} from "@lumisca/core/shared";

/** The slice of the core these routes need (interface segregation). */
export interface StellaApi {
  /** The sidebar's rows: the agents with what their conversation last said
   * (see shared/stella-preview.ts). The list exists for this route only, so
   * it is the summary shape that is declared here. */
  listStellaAgentSummaries(): StellaAgentSummary[];
  /** Create the starter agent a fresh installation talks to, unless one
   * already exists. Returns the agent a client opens. */
  ensureStellaAgent(): Promise<StellaAgent>;
  /** Create an agent: its row, and its working folder with MEMORY.md in it
   * when the machine is up (see LumiscaCore.createStellaAgent). */
  createStellaAgent(input: {
    name: string;
    role: string;
  }): Promise<StellaAgent>;
  /** Change an agent's name, its picture, its model, that model's thinking
   * strength and/or whether it is switched on, in one call: the sidebar's
   * edit dialog saves the first four together, and a request that stored one
   * but refused the other would leave the user with half of what they asked
   * for. `icon` undefined → unchanged, null → back to the initial,
   * `{ bytes, extension }` → a new picture; `model` undefined → unchanged,
   * null → the app's default model, a pair → the model to run on (the core
   * also moves the agent's existing conversation to it, now or as its
   * current run ends); `thinkingLevel` undefined → unchanged,
   * `{ provider, modelId, level }` → stores the level for that model (the
   * level belongs to the model, so the request names it); `enabled`
   * undefined → unchanged, false → switch the agent off (closing its
   * conversation and giving its desktop back), true → switch it on. */
  updateStellaAgent(
    id: string,
    patch: {
      name?: string;
      icon?: { bytes: Uint8Array; extension: string } | null;
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: { provider: string; modelId: string; level: string };
      enabled?: boolean;
    },
  ): Promise<StellaAgent>;
  /** Replace the agent's own text, the identity, with what the user typed in
   * the row menu's editor. Trimming and the length limit are the core's, so
   * the dialog and the agent's own `identity` tool share one rule. Answers
   * the updated agent. */
  setStellaAgentIdentity(id: string, content: string): StellaAgent;
  deleteStellaAgent(id: string): Promise<void>;
  getStellaStatus(): Promise<StellaStatus>;
  /** One agent's machine, as the screen pane draws it. */
  getStellaAgentStatus(agentId: string): Promise<StellaMachineStatus>;
  /** Wake one agent's machine without a prompt (the pane's wake button). */
  wakeStellaAgent(agentId: string): Promise<void>;
  /** Note that the user is driving one agent's screen, which keeps its
   * machine awake. */
  touchStellaAgent(agentId: string): void;
  /** The conversation, created on first use. Opening it prepares the image
   * but does not start a container: the first prompt wakes the machine. */
  getOrCreateStellaSession(agentId?: string): Promise<SessionInfo>;
  /** Start the setup turn of an agent that has not been set up yet, once
   * (see LumiscaCore.startStellaOnboarding). False when there is nothing to
   * start — already set up, no open conversation, or a run in flight. */
  startStellaOnboarding(agentId: string): boolean;
  /** Make sure one agent's machine is up, starting it when it is not.
   * Sending is not opening: an already-open conversation never reaches the
   * endpoint above again, and the machine may have been slept since, so the
   * first prompt of a wake has to bring it up. */
  ensureStellaReady(agentId: string): Promise<void>;
  /** Make one agent's skill catalog current enough to run (see
   * StellaMachine.ensureSkills). Needed after a wake: a sleeping machine is
   * not read, so its catalog is empty until this. */
  ensureStellaSkills(agentId: string): Promise<void>;
  /** The conversation a stella agent already has, or undefined. The client
   * addresses the conversation by agent, never by session id. */
  findStellaSession(agentId: string): SessionInfo | undefined;
  /** One window of the conversation as the client draws it (the model's own
   * rows are projected away — see agent/stella-stream.ts). Undefined when the
   * conversation is not open. */
  readStellaConversation(
    sessionId: string,
    query: WindowQuery,
  ): { items: StellaEntry[]; older: string | null } | undefined;
  /** One window of a conversation that is not open, read from the store
   * alone. A disabled agent's conversation is served this way. */
  readStellaConversationFromStore(
    sessionId: string,
    query: WindowQuery,
  ): { items: StellaEntry[]; older: string | null };
  /** Search all stored entries of one conversation, newest first. */
  searchStellaConversation(
    sessionId: string,
    query: string,
    limit?: number,
  ): StellaEntry[];
  /** The questions the run is waiting on (the ask tool). */
  getPendingQuestions(sessionId: string): StellaQuestion[];
  /** The screen hand-over the run is blocked on, or null. */
  getPendingHandover(sessionId: string): StellaHandover | null;
  /** The environment variable the run is waiting for the user to fill in,
   * or null (`vm_env`). */
  getPendingEnvRequest(sessionId: string): StellaEnvRequest | null;
  /** The folder request the run is waiting on, or null (`share_request` /
   * `share_disconnect`). */
  getPendingShareRequest(sessionId: string): StellaShareRequest | null;
  /** The user lent a folder: let the blocked run continue. */
  finishShareLend(sessionId: string, toolCallId?: string): void;
  /** The user refused to lend one. */
  declineShareRequest(sessionId: string, toolCallId?: string): void;
  /** The desktop app withdrew the loan it was asked to. */
  finishShareDisconnect(sessionId: string, toolCallId: string): void;
  /** The desktop app could not withdraw it, and said why. */
  failShareDisconnect(
    sessionId: string,
    toolCallId: string,
    error: string,
  ): void;
  /** The folders lent to this conversation from the user's own computer
   * (see core/share). Empty when none — the usual case. */
  getShares(sessionId: string): FolderShare[];
  getSessionLastError(sessionId: string): string | undefined;
  getSession(sessionId: string): SessionInfo | undefined;
  /** The thinking level the conversation's model runs at, and the levels it
   * supports (the model's own settings row, read through the session). The
   * composer shows its strength rail from this. */
  getThinkingState(sessionId: string): {
    thinkingLevel: ThinkingLevel;
    thinkingLevels: ThinkingLevel[];
  };
  getAgent(sessionId: string): { isStreaming: boolean } | undefined;
  getStellaAgent(id: string): StellaAgent | undefined;
  openSession(sessionId: string): SessionInfo;
  /** Send a prompt into the conversation (fire-and-forget; the events carry
   * the progress). `uploads` are the files and pictures the user sent: they
   * are already inside the machine, and the message records where. Optional
   * so a caller (a test double, a routine) that only has words does not have
   * to spell out "no attachments". */
  startPrompt(
    sessionId: string,
    text: string,
    images?: never,
    mode?: never,
    files?: PromptFileRef[],
  ): void;
  /** Put a prompt's attached pictures into the machine. */
  savePromptImages(
    sessionId: string,
    uploads: readonly { name: string; bytes: Uint8Array }[],
  ): Promise<PromptFileRef[]>;
  abort(sessionId: string): void;
  rewind(sessionId: string, timestamp: number): Promise<void>;
  /** Part of the shared conversation API's type, not of this surface: a
   * conversation's model is its agent's, so the model route is not mounted
   * here (see ConversationRoutesOptions.modelRoute). */
  setSessionModel(sessionId: string, provider: string, modelId: string): void;
  answerQuestion(
    sessionId: string,
    toolCallId: string,
    answers: AskAnswer[],
  ): void;
  finishHandover(sessionId: string, note: string, toolCallId?: string): void;
  /** Store the value the user typed for the variable `vm_env` asked about
   * (written into the machine; never recorded anywhere else). */
  provideStellaEnv(
    sessionId: string,
    value: unknown,
    toolCallId?: string,
  ): Promise<void>;
  /** The user refused to enter a value. */
  declineStellaEnv(sessionId: string, toolCallId?: string): void;
  /** The text on the machine's clipboard (empty when nothing was copied
   * there). The chat's screen pane reads and writes it while the user drives
   * the screen; the VNC connection cannot carry the text (see
   * vm/clipboard.ts). */
  readStellaClipboard(sessionId: string): Promise<string>;
  writeStellaClipboard(sessionId: string, text: string): Promise<void>;
  /** Subscribe to the core's event stream (the conversation's WS projects
   * from it; see stellaEventsOf). */
  subscribe(listener: (event: ClientEvent) => void): () => void;
  getSessionRevision(sessionId: string): number;
}
