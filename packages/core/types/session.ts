import type { ThinkingLevel } from "../shared.ts";

export interface SessionInfo {
  id: string;
  workspaceId: string;
  name: string;
  modelProvider: string;
  modelId: string;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
  /** Thinking level of the session's model (set via the model picker).
   * Attached by the core when sessions are returned; absent on raw rows. */
  thinkingLevel?: ThinkingLevel;
  /** The thinking levels the session's model supports. */
  thinkingLevels?: ThinkingLevel[];
}
