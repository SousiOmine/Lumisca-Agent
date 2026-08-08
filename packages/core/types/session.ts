import type { ThinkingLevel } from "../shared.ts";

export interface SessionInfo {
  id: string;
  workspaceId: string;
  name: string;
  modelProvider: string;
  modelId: string;
  systemPrompt?: string;
  /** True when `systemPrompt` was provided by the user. Generated prompts
   * are not persisted; they are rebuilt from the workspace (including
   * AGENTS.md) whenever the session is opened. */
  systemPromptCustom?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Thinking level of the session's model (set via the model picker).
   * Attached by the core when sessions are returned; absent on raw rows. */
  thinkingLevel?: ThinkingLevel;
  /** The thinking levels the session's model supports. */
  thinkingLevels?: ThinkingLevel[];
}
