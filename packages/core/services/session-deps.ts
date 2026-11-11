import type { SessionPool } from "../agent/pool.ts";
import type { Api, Model } from "../ai/types.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import type { SessionAttachmentStore } from "../session/attachments.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { SessionRepo } from "../session/repo.ts";
import type { SessionVisualStore } from "../session/visuals.ts";
import type { Locale, ThinkingLevel } from "../shared/mod.ts";
import type { SkillDef } from "../skills/discover.ts";
import type { StellaMachine } from "../vm/machine.ts";

/**
 * Everything the session services share. Split from the classes so each one
 * can declare the slice it actually uses (`Pick<SessionServiceDeps, …>`), and
 * so the composition root can build them from one object.
 */
export interface SessionServiceDeps {
  sessions: SessionRepo;
  messages: MessageRepo;
  pool: SessionPool;
  visuals: SessionVisualStore;
  attachments: SessionAttachmentStore;
  stella: StellaMachine;
  models: {
    getModel(provider: string, modelId: string): Model<Api> | undefined;
    getSessionModel(provider: string, modelId: string): Model<Api> | undefined;
    thinkingState(
      provider: string,
      modelId: string,
      model: Model<Api> | undefined,
    ): { thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[] };
    getThinkingLevel(provider: string, modelId: string): ThinkingLevel;
  };
  /** The agent's model, allowing a retired one (see
   * ModelManager.getModelWithRetired). */
  requireModel(provider: string, modelId: string): Model<Api>;
  requireWorkspace(id: string): Workspace;
  chatWorkspace(): Workspace;
  resolveDefaultModel(
    provider?: string,
    modelId?: string,
  ): Promise<{ provider: string; modelId: string }>;
  decorate(session: SessionInfo): SessionInfo;
  /** Publish an event to every frontend listener. */
  emit(event: ClientEvent): void;
  /** Drop the in-memory state of a session (revisions, hand-over hubs). */
  forget(sessionId: string): void;
  language(): Locale;
  browserAvailable(): boolean;
  computerAvailable(): boolean;
  globalSkillDirs: string[] | undefined;
  /** The mode's shared skills folders (see SessionPoolDeps). */
  appSkillDirs: string[] | undefined;
  /** One stella agent's skill catalog as last read. */
  stellaSkills(agentId: string): SkillDef[];
}
