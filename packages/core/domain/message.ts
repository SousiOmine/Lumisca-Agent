/**
 * Message and content shapes: the transcript's vocabulary.
 *
 * These are what the agent loop, the retry policy, the database and the UI
 * event bridge exchange. They live apart from the provider catalog and the
 * stream contract so a change to one does not put every consumer of the
 * other in its blast radius.
 */

import type { PromptFileRef } from "../shared/attachments.ts";

import type { Api } from "./model.ts";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantMessageContent = (
  | TextContent
  | ThinkingContent
  | ToolCall
)[];

// ---- usage / cost ----------------------------------------------------------

export interface Usage {
  /** Prompt tokens that neither hit the prompt cache nor were written to
   * it. A prompt is `input + cacheRead + cacheWrite` tokens wide — the
   * three parts are reported (and priced) separately by the provider. */
  input: number;
  output: number;
  /** Prompt tokens the provider served from its prompt cache. */
  cacheRead: number;
  /** Prompt tokens the provider wrote into its prompt cache. */
  cacheWrite: number;
  reasoningTokens?: number;
  /** Financial cost of the usage, when the provider reports/derives it. */
  cost?: number;
  /** Total tokens of the turn as the provider reports them
   * (prompt + completion), when they are known. */
  total?: number;
}

export type StopReason =
  | "pending"
  | "stop"
  /** The provider cut the answer at the output cap; the turn is incomplete
   * (see ai/stream.ts, which maps the SDK's finish reason onto this). */
  | "length"
  | "toolUse"
  | "error"
  | "aborted";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  /** True when the prompt was delivered into the run that was already
   * active instead of starting its own run (see
   * SessionAgent.joinsActiveRun); absent when it started its own run. The
   * UI keeps such a prompt inside that run's turn instead of starting a
   * new one (see web's buildTurns) — the same delivery fact
   * NotificationMessage carries, with the same reason: a message that did
   * not start a run must not end the running turn. Not provider-facing:
   * the transport reads role and content only (see toCoreMessages). */
  steered?: boolean;
  /** Set on a prompt a routine started (see shared/routine.ts): the
   * routine's name. The conversation does not draw the prompt (its text is
   * the routine's instruction plus guidance for the model), so this name is
   * never read as the user's words; it identifies the run, and it is what the
   * agent list names. Never provider-facing. */
  routine?: string;
  /** Files and pictures the user attached to this prompt, already written
   * into the machine (see vm/uploads.ts). The conversation draws them under
   * the bubble by reading them back from the machine; the model is told
   * their paths through the text, so this stays in the transcript and out of
   * the provider payload.
   *
   * A picture is an entry here rather than an `image` block in `content`.
   * Both would put the bytes in the database, and a conversation that lives
   * for years must not carry every screenshot ever pasted into it: the
   * machine is where the bytes live, and it is also where the agent works.
   * A picture the machine no longer has is gone — the same as a file. */
  files?: PromptFileRef[];
  /**
   * What the MODEL is sent, when that is not what the user said.
   *
   * A prompt can carry instructions that exist only for the model: the
   * notice naming attached files ("they are inside the machine, open them
   * with read"), a mode's framing, a hint the UI adds on the user's behalf.
   * Those belong in the request and NOT on the screen — the user wrote a
   * sentence and should see that sentence, not a paragraph addressed to
   * something else.
   *
   * `content` stays the user's own message: it is what the conversation
   * draws, what `history_search` returns, and what a rewind shows. When
   * this field is present the transport sends it instead, so the two can
   * differ in either direction — the model can be told more than the user
   * wrote, and (a prompt with no words at all, only files) the model can be
   * sent a message whose visible text is empty. That emptiness is a display
   * fact, never a reason to drop the message: it still starts a run.
   *
   * Never provider-facing on its own terms: `content` remains the message's
   * identity, so a client that does not know this field still shows the
   * right text.
   */
  modelContent?: string;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantMessageContent;
  api: Api;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  /** True when the provider marked the failure retryable (the AI SDK's
   * `APICallError.isRetryable`). Persisted with the message so a post-mortem
   * can tell a transient cut from a permanent rejection. */
  errorRetryable?: boolean;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

/** The message union the app converts to LLM messages. */

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type LlmContentBlock = TextContent | ImageContent | ThinkingContent;

/** A message as handed to the LLM transport (not yet provider-specific).
 * The content blocks are the assistant's own union too: an assistant turn
 * carries tool calls, and the transport serializes them (`toCoreMessages`
 * maps a toolCall block to the provider's tool-call part). */

export interface LlmMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | (LlmContentBlock | ToolCall)[];
  timestamp?: number;
}

// ---- agent message (the transcript, incl. Lumisca extras) --------------------

/** The transcript message: the three conversational roles plus the mode,
 * notification, context and checkpoint roles the agent loop injects. */

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | ModeMessage
  | NotificationMessage
  | ContextMessage
  | CheckpointMessage;

/** A user message generated by an agent mode (e.g. review). The UI renders
 * it with a short text + mode badge instead of the full prompt text; the
 * LLM sees `fullPrompt` plus the attached images (see toLlmMessages in
 * types/notification.ts, and buildModeMessage in types/mode-message.ts for
 * the constructor). */

export interface ModeMessage {
  role: "mode";
  modeId: string;
  optionId: string;
  modeLabel: string;
  /** Short text shown by the UI (and used as the goal text for "/goal"). */
  shortText: string;
  /** The full prompt sent to the LLM (via toLlmMessages). */
  fullPrompt: string;
  /** Images the user attached in the composer, sent to the LLM after the
   * full prompt (the mode counterpart of a user message's image blocks;
   * empty when none were attached). The UI renders them in the bubble like
   * a user message's, and the rewind action restores them to the
   * composer. */
  images: ImageContent[];
  /** True when the mode prompt was delivered into the run that was already
   * active instead of starting its own run (see
   * SessionAgent.promptWhileRunning); absent when it started its own run.
   * The UI keeps such a prompt inside that run's turn instead of starting
   * a new one (see web's buildTurns) — the same delivery fact
   * NotificationMessage carries, with the same reason: a message that did
   * not start a run must not end the running turn. */
  steered?: boolean;
  timestamp: number;
}

/** Kind of a system notification injected into an agent loop: background
 * command completions (async_bash), sub-agent task completions (task),
 * agent-to-agent messages (send_message), empty-response retries (the
 * session agent retries a response that produced neither text nor a tool
 * call), and the loop's own advisories (the repeat guard's reminder — see
 * ai/agent.ts). */

export type NotificationKind =
  | "background"
  | "task"
  | "message"
  | "retry"
  /** An advisory the loop or the session agent appends to the transcript
   * itself — the repeat guard's reminder (see ai/agent.ts) — rather than a
   * completion delivered from outside. */
  | "notice";

/** Outcome of the event a notification reports. The UI shows a check for
 * success, an error badge for failure, and nothing for neutral. */

export type NotificationStatus = "success" | "error" | "neutral";

/** A system notification delivered to an agent as a first-class message
 * (injected by the session agent or steered into a sub-agent). The agent
 * sees it as a user message — see toLlmMessages — whose text starts with
 * the prefix contract taught in the system prompt ("[Background command
 * ...]", "[Task ...]", "[Message from ...]"). The UI renders it as a
 * compact one-line row instead of a user message. */

export interface NotificationMessage {
  role: "notification";
  kind: NotificationKind;
  /** Head line shown by the UI and used as the first line of the
   * agent-visible text (e.g. "[Background command #2 finished after 12s
   * (exit code 0)]"). */
  title: string;
  /** Detail text (output tail / task result / message body); empty when
   * there is nothing beyond the title. */
  body: string;
  status: NotificationStatus;
  /** True when the notification was steered into the run that was already
   * active instead of starting its own run (see
   * SessionAgent.deliverPrompt); absent when it started its own run. The UI
   * keeps a steered notification inside that run's turn instead of starting
   * a new one (see web's buildTurns): it is a system event of the ongoing
   * work, like a tool result, so it must not split the turn — the running
   * turn's work log would collapse mid-run. */
  steered?: boolean;
  timestamp: number;
}

/**
 * A durable snapshot of dynamic context (ai/context-providers): the
 * session's skill catalog, or the workspace instruction files. It is
 * appended to the transcript when the underlying context changes — and only
 * then — so the model always works from the current value while the system
 * prompt stays free of per-session data (the DeepSeek Harness's
 * `PromptContext`; see toLlmMessages for the model-facing text).
 */

export interface ContextMessage {
  role: "context";
  /** Provider that published it ("skills", "instructions"). */
  provider: string;
  /** One-line label of the record, kept when a prune reduces the body. No
   * client draws it — see the web's buildTurns. The body carries the framing
   * the model reads, so the label is never model-facing prose. */
  title: string;
  /** Model-facing text. */
  body: string;
  /** Provider-specific snapshot state, handed back to the provider's
   * `rebase()` when the transcript is re-read (session reopen, rewind) so a
   * reopened session neither republishes an unchanged value nor loses track
   * of what the history already carries. */
  state?: unknown;
  timestamp: number;
}

/**
 * A compaction checkpoint: the summary that replaced an older span of the
 * transcript to keep the conversation inside the model's request limit (see
 * ai/context-compaction.ts). It is one durable message sitting where the
 * replaced span was, so the history after a compaction reads as
 * checkpoint → retained recent messages.
 *
 * The replacement is how the DeepSeek Harness's compaction seam makes a
 * summary durable: the summary rides on an ordinary model-facing message
 * (`user/message` with a checkpoint source there; here a role of its own,
 * which also keeps it out of the user-message path in the UI) instead of
 * being an append-only note the model would read as new input.
 */

export interface CheckpointMessage {
  role: "checkpoint";
  /** Head line: the UI row label, carrying what was replaced (the model
   * never reads it — the body is the model-facing text). */
  title: string;
  /** Model-facing text: the checkpoint preamble plus the framed summary,
   * sent as ONE user message (see toLlmMessages). */
  body: string;
  timestamp: number;
}

// ---- tool definition ----------------------------------------------------------

/** The tool type the agent runtime owns (a Lumisca agent tool). */
