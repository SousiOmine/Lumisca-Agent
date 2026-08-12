import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionInfo } from "./session.ts";

/** Events emitted by the core and forwarded to any client (WebSocket, CLI). */
export type ClientEvent =
  | { type: "session_created"; session: SessionInfo }
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
  | { type: "session_error"; sessionId: string; message: string }
  /** The transcript was rewound from a user message onward. `removed` is
   * the exact list of messages deleted (memory + database); clients drop
   * those keys from the view and remember them so a later resync cannot
   * resurrect them. Carried as role+timestamp pairs (the app's message
   * identity key). */
  | {
    type: "messages_truncated";
    sessionId: string;
    removed: Array<{ role: string; timestamp: number }>;
  }
  /** The session title changed (e.g. auto-generated from the first
   * message by the fast model). Clients update the displayed name. */
  | { type: "session_renamed"; sessionId: string; name: string };
