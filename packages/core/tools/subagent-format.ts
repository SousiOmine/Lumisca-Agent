import type { AgentMessage } from "../ai/types.ts";
import { contentText } from "../shared/mod.ts";
import type {
  NotificationMessage,
  NotificationPayload,
} from "../types/notification.ts";
import type { SubagentType, TaskInfo } from "../shared/mod.ts";
import { MAX_TOOL_OUTPUT, truncate, truncatedNote } from "./truncate.ts";
import {
  EXPLORE_SUBAGENT_SECTIONS,
  GENERAL_SUBAGENT_SECTIONS,
  renderPromptSections,
} from "./prompt-sections.ts";

/** The system prompt of one sub-agent: its identity (ids and role, which
 * only the caller knows) plus the guidelines of its kind, pruned to the
 * tools it actually has (see prompt-sections). */
export function subagentSystemPrompt(
  agentId: string,
  parentId: string,
  type: SubagentType,
  tools: readonly string[],
): string {
  const role = type === "explore" ? "research" : "coding";
  const sections = type === "explore"
    ? EXPLORE_SUBAGENT_SECTIONS
    : GENERAL_SUBAGENT_SECTIONS;
  return `You are a ${role} sub-agent of Lumisca, started by agent ${parentId} ` +
    `to handle one piece of work. Your own id is ${agentId}.
Work on the assigned task and answer with a complete final report as your last message.
If you need input mid-task, send a message to ${parentId} with send_message. You cannot ask the user directly.

Guidelines:
${renderPromptSections(sections, tools)}
`;
}

/** The text of the final assistant message of a finished sub-agent run. */
export function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant") return contentText(message.content);
  }
  return "";
}

/** Stamp a payload as a notification message (role + timestamp). */
export function notificationMessage(
  payload: NotificationPayload,
): NotificationMessage {
  return {
    role: "notification",
    ...payload,
    timestamp: Date.now(),
  };
}

/** Tail of a failed sub-agent's partial output, so a lost run still hands
 * over what it had produced. Bounded: the notification becomes a message in
 * the parent's transcript. */
const PARTIAL_OUTPUT_TAIL_CHARS = 4096;

/** Tools whose closing tags a gateway streams through the text channel when
 * its own tool-call parse fails. */
const TOOL_SYNTAX_END_PATTERN =
  /<\/(?:parameter|invoke|tool_call|tool_calls|function_calls)>\s*$/;

/** True when a response ends inside a tool-call block. Some providers
 * deliver a tool call as plain text (the tags below are the tool-use
 * dialect they use); the call then never executes and the run still looks
 * like a clean finish — so the report must be flagged as incomplete instead
 * of being trusted as final. */
export function endsWithToolCallSyntax(text: string): boolean {
  return TOOL_SYNTAX_END_PATTERN.test(text.trimEnd());
}

/** The warning appended to a task report that ends inside a tool-call
 * block, or "" when the report ends normally. */
function toolSyntaxWarning(info: TaskInfo): string {
  if (info.text.length === 0 || !endsWithToolCallSyntax(info.text)) return "";
  return "\n\n[warning] This report ends inside a tool-call block, which " +
    "means the provider streamed a tool call as plain text and it never " +
    "executed. Treat the report as incomplete.";
}

/** The partial output a failed run produced before the transport cut it. */
function partialOutputSection(info: TaskInfo): string {
  const text = info.text.trim();
  if (text.length === 0) return "";
  const tail = text.length <= PARTIAL_OUTPUT_TAIL_CHARS
    ? text
    : `…\n${text.slice(-PARTIAL_OUTPUT_TAIL_CHARS)}`;
  return `\n\n[partial output before the failure]\n${tail}`;
}

/** The notification injected into the spawning agent's loop when a
 * sub-agent completes. The title starts with "[Task ...]" so system prompts
 * can teach agents to recognize it as a system notification. */
export function formatTaskCompletion(
  info: TaskInfo,
  failure?: string,
): NotificationPayload {
  if (info.status === "finished") {
    const result = truncate(
      info.text + toolSyntaxWarning(info),
      MAX_TOOL_OUTPUT,
    );
    return {
      kind: "task",
      title: `[Task ${info.agentId} (${info.description}) finished]`,
      body: result.text +
        (result.truncated ? truncatedNote("task result") : ""),
      status: "success",
    };
  }
  const verb = info.status === "aborted" ? "was aborted" : "failed";
  // A failed run keeps whatever it managed to produce: the notification is
  // often the only thing the parent reads, and four long investigations
  // were lost to a transport cut that reported nothing but the error text.
  const body = truncate(
    `${failure ?? ""}${partialOutputSection(info)}`,
    MAX_TOOL_OUTPUT,
  );
  return {
    kind: "task",
    title: `[Task ${info.agentId} (${info.description}) ${verb}]`,
    body: body.text + (body.truncated ? truncatedNote("task result") : ""),
    status: "error",
  };
}

/** The text shown by task_output for one task. */
export function formatTaskOutput(info: TaskInfo): string {
  const head =
    `Agent ${info.agentId} (${info.subagentType}, ${info.description}): ${info.status}`;
  const text = info.text.trim();
  if (info.status === "running") {
    return text.length > 0 ? `${head}\nLive output (tail):\n${text}` : head;
  }
  const body = text.length > 0
    ? `${head}\n${text}${toolSyntaxWarning(info)}`
    : head;
  return body;
}
