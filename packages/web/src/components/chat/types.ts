import type { AgentMessage } from "../../types.ts";

/** An image content block of a user message (`data` is base64 without the
 * `data:<mime>;base64,` header; see ContentImages). */
export type UserMessageImage = {
  type: "image";
  data: string;
  mimeType: string;
};

/** One conversation turn: the user message (or system notification) that
 * started a run plus everything the agent produced in response. A
 * compaction checkpoint is a turn of its own (`standalone`): it marks a
 * replacement in the history rather than starting a run, so it renders as a
 * single row without the activity header. */
export interface ConversationTurnData {
  user: AgentMessage;
  responses: AgentMessage[];
  /** True for a compaction checkpoint row (see buildTurns). */
  standalone?: boolean;
}
