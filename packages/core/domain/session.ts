import type { ThinkingLevel } from "../shared/mod.ts";
import type { ModelInfo } from "../shared/providers.ts";

export interface SessionInfo {
  id: string;
  workspaceId: string;
  name: string;
  modelProvider: string;
  modelId: string;
  /** The session's system prompt, as last generated (see
   * AgentFactory.ensureSystemPrompt). It is a stored derivation of the
   * mode, the workspace folders and a stella agent's role, not a frozen
   * snapshot: it is re-derived on every open and replaced when the result
   * differs, so a folder edit or a changed prompt in a new release reaches
   * a session that already exists. */
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
