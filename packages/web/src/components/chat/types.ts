import type { AgentMessage } from "../../types.ts";

/** An image content block of a user message (`data` is base64 without the
 * `data:<mime>;base64,` header; see ContentImages). */
export type UserMessageImage = {
  type: "image";
  data: string;
  mimeType: string;
};

/** One conversation turn: the user message (or system notification) that
 * started a run plus everything the agent produced in response. */
export interface ConversationTurnData {
  user: AgentMessage;
  responses: AgentMessage[];
}
