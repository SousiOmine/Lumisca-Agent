import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AskQuestion,
  SubagentStatus,
  SubagentType,
  TodoPhase,
} from "../shared.ts";
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
  | { type: "session_renamed"; sessionId: string; name: string }
  /** The agent asked the user a question (the ask tool). The run waits
   * for the answer; clients show the questions in the UI and post the
   * answers back via the answer endpoint. */
  | {
    type: "question";
    sessionId: string;
    toolCallId: string;
    questions: AskQuestion[];
  }
  /** The todo plan of a session changed (the todo tool): the full plan is
   * carried so clients can replace their view idempotently (resync-safe).
   * Emitted on every mutation (plan / update / clear). */
  | { type: "todo"; sessionId: string; todos: TodoPhase[] }
  /** A sub-agent task started (the task tool). Clients add it to the tasks
   * panel; its live response arrives as `task_delta` events. */
  | {
    type: "task_start";
    sessionId: string;
    agentId: string;
    parentAgentId: string;
    subagentType: SubagentType;
    description: string;
  }
  /** A chunk of a sub-agent's live response. Clients append it to the
   * task's view; the stream restarts after a reload (deltas are not
   * replayed, the resync endpoint carries only the tail). */
  | { type: "task_delta"; sessionId: string; agentId: string; delta: string }
  /** A sub-agent task finished, failed, or was aborted. Clients update the
   * task's status in the panel. */
  | {
    type: "task_end";
    sessionId: string;
    agentId: string;
    status: SubagentStatus;
  };
