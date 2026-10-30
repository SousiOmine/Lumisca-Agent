import type { AgentMessage, CheckpointMessage } from "../ai/types.ts";
import type {
  AskQuestion,
  GoalInfo,
  SubagentStatus,
  SubagentType,
  TodoPhase,
} from "../shared/mod.ts";
import type { SessionInfo } from "./session.ts";

/**
 * How a client tells two messages of one transcript apart: the role and the
 * timestamp the message was stamped with, plus the tool call id for a tool
 * result (parallel results can share a millisecond, and the identity must stay
 * unambiguous). The web calls this a message key; the transcript windows name
 * their cursor with it, and a rewind reports what it removed by it.
 */
export interface MessageIdentity {
  role: string;
  timestamp: number;
  toolCallId?: string;
}

/** Events emitted by the core and forwarded to any client (WebSocket, HTTP). */
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
  /** A tool call finished running. The outcome is carried by the toolResult
   * message (`message_end`), not by this event — the event only clears the
   * tool line's running state. */
  | {
    type: "tool_end";
    sessionId: string;
    toolCallId: string;
    toolName: string;
  }
  | { type: "agent_end"; sessionId: string }
  | { type: "session_error"; sessionId: string; message: string }
  /** The transcript was rewound from a user message onward. `removed` is
   * the exact list of messages deleted (memory + database); clients drop
   * those identities from the view and remember them so a later resync
   * cannot resurrect them. */
  | {
    type: "messages_truncated";
    sessionId: string;
    removed: MessageIdentity[];
  }
  /** Older history was condensed into a checkpoint message because the
   * conversation reached the model's request limit (see
   * agent/context-compaction.ts). The checkpoint was INSERTED immediately
   * before `before`: every message stays in the transcript (and in the
   * database), and the model's view now starts after the checkpoint —
   * clients show the row where it sits without dropping anything.
   *
   * The position is an identity, not an index: clients hold a WINDOW of the
   * transcript (see session/transcript-window.ts), so an index would not say
   * where the row belongs in what they have. Unlike `messages_truncated` this
   * arrives while a run keeps streaming: it never clears the run state. */
  | {
    type: "messages_checkpoint";
    sessionId: string;
    before: MessageIdentity;
    message: CheckpointMessage;
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
  /** The agent handed the machine's screen to the user (`vm_ask_user`) and
   * the run is blocked until they finish. Clients make the screen pane
   * interactive while it lasts; the resync snapshot carries the same
   * pending handover (`handover` events are never replayed). */
  | {
    type: "handover";
    sessionId: string;
    toolCallId: string;
    reason: string;
    instructions: string | null;
  }
  /** The handover ended (the user finished, the run was aborted, or the
   * session closed). `note` is what the user reported doing, empty when
   * they only pressed done. Clients stop accepting input on the screen. */
  | {
    type: "handover_end";
    sessionId: string;
    toolCallId: string;
    note: string;
  }
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
  }
  /** A background command started (the async_bash tool). Clients add it to
   * the background panel; its live output arrives as `background_delta`
   * events. */
  | {
    type: "background_start";
    sessionId: string;
    commandId: string;
    pid: number;
    command: string;
    cwd: string;
    startedAt: number;
  }
  /** A chunk of a background command's decoded output. Clients append it to
   * the command's view; the stream restarts after a reload (deltas are not
   * replayed, the resync endpoint carries only the tail). */
  | {
    type: "background_delta";
    sessionId: string;
    commandId: string;
    delta: string;
  }
  /** A background command finished, was killed, or timed out. Clients update
   * the command's status in the panel; `tail` is the final output tail. */
  | {
    type: "background_end";
    sessionId: string;
    commandId: string;
    state: "finished" | "killed";
    exitCode?: number;
    finishedAt: number;
    tail: string;
  }
  /** The session's goal started (`/goal` mode). Clients show it in the
   * right-side goal panel; the resync endpoint carries the same snapshot. */
  | { type: "goal_start"; sessionId: string; goal: GoalInfo }
  /** The session's goal progressed (iteration, judging status, or the
   * judge's reason). Clients replace the goal panel wholesale. */
  | { type: "goal_progress"; sessionId: string; goal: GoalInfo }
  /** The session's goal finished. `achieved` is true when the judge
   * confirmed the goal; otherwise `reason` explains the stop (limit,
   * cancel, or judge failure). Clients clear the goal panel. */
  | {
    type: "goal_done";
    sessionId: string;
    text: string;
    achieved: boolean;
    reason: string;
  }
  /** The hub's event stream to one peer closed or (re)opened. The hub
   * relays each peer's stream to its UI clients; while that relay is down
   * the peer's sessions miss events (an `agent_end`, a tool result, a todo
   * mutation) and nothing else would tell a client watching one of them.
   * `connected: false` announces the gap, `connected: true` says the relay
   * is back — clients then re-read the snapshots of that peer's open
   * sessions. Peer-scoped, not session-scoped: it carries no sessionId. */
  | { type: "peer_stream"; peerId: string; connected: boolean };
