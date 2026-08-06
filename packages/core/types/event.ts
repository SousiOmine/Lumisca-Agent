import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Events emitted by the core and forwarded to any client (WebSocket, CLI). */
export type ClientEvent =
  | { type: "session_created"; session: unknown }
  | { type: "agent_start"; sessionId: string }
  | { type: "message_start"; sessionId: string; message: AgentMessage }
  | { type: "message_delta"; sessionId: string; delta: string }
  | { type: "message_end"; sessionId: string; message: AgentMessage }
  | {
    type: "tool_start";
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }
  | {
    type: "tool_end";
    sessionId: string;
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }
  | { type: "agent_end"; sessionId: string }
  | { type: "session_error"; sessionId: string; message: string };
