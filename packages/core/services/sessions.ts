import type { SessionAgent } from "../agent/session-agent.ts";
import type { AgentMessage, ImageContent } from "../domain/message.ts";
import type { ModePrompt } from "../domain/mode-message.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { StellaEntry } from "../domain/stella-conversation.ts";
import { CoreError } from "../errors.ts";
import type { WindowPage, WindowQuery } from "../session/transcript-window.ts";
import type { ContextUsageSummary } from "../shared/context-usage.ts";
import type {
  AskAnswer,
  PromptFileRef,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
} from "../shared/mod.ts";
import type { SkillInfo } from "../skills/discover.ts";
import type { PendingQuestion } from "../tools/ask.ts";
import type { BackgroundCommandInfo } from "../tools/background.ts";
import type { HostPromptFile, PromptImageFile } from "../vm/uploads.ts";
import { SessionAssets } from "./session-assets.ts";
import type { SessionServiceDeps } from "./session-deps.ts";
import {
  type CreateSessionInput,
  type DefaultModel,
  SessionLifecycle,
} from "./session-lifecycle.ts";
import { SessionRuns } from "./session-runs.ts";
import { SessionSkills } from "./session-skills.ts";
import { SessionTranscript } from "./session-transcript.ts";

export type { SessionServiceDeps } from "./session-deps.ts";
export type { CreateSessionInput, DefaultModel } from "./session-lifecycle.ts";

/**
 * The sessions an installation owns: one entry point over six collaborators.
 *
 * The work is split by the question asked: {@link SessionLifecycle} owns the
 * row and the live agent's existence, {@link SessionState} what the agent is
 * doing now, {@link SessionTranscript} the history, {@link SessionAssets} the
 * files, {@link SessionSkills} the catalog and {@link SessionRuns} steering a
 * run. This class only forwards, which keeps the API the routes and the
 * facade already use (a new area does not force every caller to be re-wired).
 */
export class SessionService {
  private readonly lifecycle: SessionLifecycle;
  /** The live state reads: what a session is doing right now (see the
   * "live state" section). The pool owns it; the persisted rows cover only
   * what a reopen can restore. */
  private readonly pool: SessionServiceDeps["pool"];
  private readonly transcript: SessionTranscript;
  private readonly assets: SessionAssets;
  private readonly skills: SessionSkills;
  private readonly runs: SessionRuns;
  private readonly models: SessionServiceDeps["models"];
  private readonly agentDisabled: SessionServiceDeps["agentDisabled"];

  constructor(deps: SessionServiceDeps) {
    this.lifecycle = new SessionLifecycle(deps);
    this.models = deps.models;
    this.agentDisabled = deps.agentDisabled;
    this.pool = deps.pool;
    this.transcript = new SessionTranscript(deps);
    this.assets = new SessionAssets(deps);
    this.skills = new SessionSkills(deps);
    this.runs = new SessionRuns(deps);
  }

  // --- life ---------------------------------------------------------------

  getDefaultModel(): Promise<DefaultModel | null> {
    return this.lifecycle.getDefaultModel();
  }

  createSession(input: CreateSessionInput): Promise<SessionInfo> {
    return this.lifecycle.createSession(input);
  }

  listSessions(workspaceId?: string): SessionInfo[] {
    return this.lifecycle.listSessions(workspaceId);
  }

  listEverySession(): SessionInfo[] {
    return this.lifecycle.listEverySession();
  }

  getSession(id: string): SessionInfo | undefined {
    return this.lifecycle.getSession(id);
  }

  /** The session, or a `not_found` error naming it. */
  requireSession(id: string): SessionInfo {
    const session = this.lifecycle.getSession(id);
    if (session === undefined) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    return session;
  }

  findStellaSession(agentId: string): SessionInfo | undefined {
    return this.lifecycle.findStellaSession(agentId);
  }

  /** Open a session, unless it is a stella conversation whose agent is
   * disabled: building its agent would undo the release the disable
   * performed, and its conversation is served from the store instead. */
  openSession(id: string): SessionInfo {
    const session = this.lifecycle.getSession(id);
    if (
      session?.personaId !== undefined &&
      this.agentDisabled(session.personaId)
    ) {
      throw new CoreError(`Agent ${session.personaId} is disabled`, "conflict");
    }
    return this.lifecycle.openSession(id);
  }

  /** The thinking level a session's model runs at, and the levels that model
   * supports. The level belongs to the model, not to the session, so it is
   * read through the session's current model every time. */
  getThinkingState(sessionId: string): {
    thinkingLevel: ThinkingLevel;
    thinkingLevels: ThinkingLevel[];
  } {
    const session = this.lifecycle.getSession(sessionId);
    if (session === undefined) {
      throw new CoreError(`Session not found: ${sessionId}`, "not_found");
    }
    const model = this.models.getSessionModel(
      session.modelProvider,
      session.modelId,
    );
    return this.models.thinkingState(
      session.modelProvider,
      session.modelId,
      model,
    );
  }

  closeSession(id: string): Promise<void> {
    return this.lifecycle.closeSession(id);
  }

  deleteSession(id: string): Promise<void> {
    return this.lifecycle.deleteSession(id);
  }

  setSessionModel(id: string, provider: string, modelId: string): void {
    this.lifecycle.setSessionModel(id, provider, modelId);
  }

  deferRebuild(id: string): void {
    this.lifecycle.deferRebuild(id);
  }

  releasePendingRebuild(id: string): void {
    this.lifecycle.releasePendingRebuild(id);
  }

  setSessionName(id: string, name: string): void {
    this.lifecycle.setSessionName(id, name);
  }

  getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel {
    return this.lifecycle.getModelThinkingLevel(provider, modelId);
  }

  // --- live state ---------------------------------------------------------

  getAgent(id: string): SessionAgent | undefined {
    return this.pool.get(id);
  }

  getTodo(id: string): TodoPhase[] {
    return this.pool.getTodo(id);
  }

  getTasks(id: string): TaskInfo[] {
    return this.pool.getTasks(id);
  }

  getBackground(id: string): BackgroundCommandInfo[] {
    return this.pool.getBackground(id);
  }

  getPendingQuestions(id: string): PendingQuestion[] {
    return this.pool.getPendingQuestions(id);
  }

  getSessionLastError(id: string): string | undefined {
    return this.pool.lastError(id);
  }

  // --- history ------------------------------------------------------------

  readTranscript(
    id: string,
    query: WindowQuery,
  ): WindowPage<AgentMessage> | undefined {
    return this.transcript.readTranscript(id, query);
  }

  readStellaConversation(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> | undefined {
    return this.transcript.readStellaConversation(id, query);
  }

  /** One window of a conversation that is not open (a disabled agent's). */
  readStellaConversationFromStore(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> {
    return this.transcript.readStellaConversationFromStore(id, query);
  }

  getSessionUsage(id: string): ContextUsageSummary {
    return this.transcript.getSessionUsage(id);
  }

  // --- files --------------------------------------------------------------

  resolveSessionVisual(
    sessionId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.assets.resolveSessionVisual(sessionId, name);
  }

  resolveSessionAttachment(
    sessionId: string,
    name: string,
  ): Promise<
    { path: string; mimeType: string; downloadName: string } | undefined
  > {
    return this.assets.resolveSessionAttachment(sessionId, name);
  }

  savePromptImages(
    id: string,
    uploads: readonly PromptImageFile[],
  ): Promise<PromptFileRef[]> {
    return this.assets.savePromptImages(id, uploads);
  }

  savePromptFile(
    id: string,
    file: HostPromptFile,
    signal?: AbortSignal,
  ): Promise<PromptFileRef> {
    return this.assets.savePromptFile(id, file, signal);
  }

  resolvePromptUpload(
    agentId: string,
    ref: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    return this.assets.resolvePromptUpload(agentId, ref);
  }

  // --- skills -------------------------------------------------------------

  listSkills(workspaceId?: string): SkillInfo[] {
    return this.skills.listSkills(workspaceId);
  }

  listStellaSkills(agentId: string): SkillInfo[] {
    return this.skills.listStellaSkills(agentId);
  }

  // --- runs ---------------------------------------------------------------

  startPrompt(
    id: string,
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    files?: PromptFileRef[],
  ): void {
    this.runs.startPrompt(id, text, images, mode, files);
  }

  /** Start a stella conversation's setup turn (see
   * SessionRuns.startOnboarding). */
  startOnboarding(id: string, instruction: string): void {
    this.runs.startOnboarding(id, instruction);
  }

  abort(id: string): void {
    this.runs.abort(id);
  }

  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void {
    this.runs.answerQuestion(id, toolCallId, answers);
  }

  rewind(id: string, timestamp: number): Promise<void> {
    return this.runs.rewind(id, timestamp);
  }

  compactSession(
    id: string,
    instructions?: string,
  ): Promise<number | undefined> {
    return this.runs.compactSession(id, instructions);
  }
}
