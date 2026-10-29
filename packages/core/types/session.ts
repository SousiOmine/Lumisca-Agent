import type { ThinkingLevel } from "../shared/mod.ts";
import type { ModelInfo } from "../shared/providers.ts";

export interface SessionInfo {
  id: string;
  workspaceId: string;
  name: string;
  modelProvider: string;
  modelId: string;
  /** The session's system prompt, snapshotted at creation (workspace
   * AGENTS.md + environment + personalization included). */
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
  /** Thinking level of the session's model (set via the model picker).
   * Attached by the core when sessions are returned; absent on raw rows. */
  thinkingLevel?: ThinkingLevel;
  /** The thinking levels the session's model supports. */
  thinkingLevels?: ThinkingLevel[];
  /** The session's model with its catalog metadata (context window,
   * reasoning flag, modalities). Attached by the core when sessions are
   * returned so clients render model-specific UI (e.g. the context meter)
   * without fetching the model list; absent on raw rows. */
  model?: ModelInfo;
  /** True for sessions of the folder-less chat workspace ("simple chat"
   * without a workspace). Attached by the core when sessions are returned;
   * absent on raw rows. */
  chat?: boolean;
  /** True for a stella agent's conversation. It is not a session the user
   * opened — stella has no session concept — so it never appears in a
   * session list; it exists so one ongoing conversation per agent can reuse
   * the message store, compaction and rewind. */
  stella?: boolean;
  /** The stella agent whose conversation this is (absent for every other
   * session). */
  agentId?: string;
}
