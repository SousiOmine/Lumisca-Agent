import type { SessionAgent } from "../agent/session-agent.ts";
import type { AgentMessage, ImageContent } from "../ai/types.ts";
import type { ModePrompt } from "../domain/mode-message.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { StellaEntry } from "../domain/stella-conversation.ts";
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
import type { UploadFile } from "../vm/uploads.ts";
import { SessionAssets } from "./session-assets.ts";
import type { SessionServiceDeps } from "./session-deps.ts";
import {
  type CreateSessionInput,
  type DefaultModel,
  SessionLifecycle,
} from "./session-lifecycle.ts";
import { SessionRuns } from "./session-runs.ts";
import { SessionSkills } from "./session-skills.ts";
import { SessionState } from "./session-state.ts";
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
  private readonly state: SessionState;
  private readonly transcript: SessionTranscript;
  private readonly assets: SessionAssets;
  private readonly skills: SessionSkills;
  private readonly runs: SessionRuns;

  constructor(deps: SessionServiceDeps) {
    this.lifecycle = new SessionLifecycle(deps);
    this.state = new SessionState(deps);
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

  getSession(id: string): SessionInfo | undefined {
    return this.lifecycle.getSession(id);
  }

  findStellaSession(agentId: string): SessionInfo | undefined {
    return this.lifecycle.findStellaSession(agentId);
  }

  openSession(id: string): SessionInfo {
    return this.lifecycle.openSession(id);
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
    return this.state.getAgent(id);
  }

  getTodo(id: string): TodoPhase[] {
    return this.state.getTodo(id);
  }

  getTasks(id: string): TaskInfo[] {
    return this.state.getTasks(id);
  }

  getBackground(id: string): BackgroundCommandInfo[] {
    return this.state.getBackground(id);
  }

  getPendingQuestions(id: string): PendingQuestion[] {
    return this.state.getPendingQuestions(id);
  }

  getSessionLastError(id: string): string | undefined {
    return this.state.getSessionLastError(id);
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

  savePromptUploads(
    id: string,
    uploads: readonly UploadFile[],
  ): Promise<PromptFileRef[]> {
    return this.assets.savePromptUploads(id, uploads);
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
