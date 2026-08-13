import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "../content.ts";
import type {
  NotificationMessage,
  NotificationPayload,
} from "../types/notification.ts";
import type { SubagentType, TaskInfo } from "../shared.ts";
import { MAX_TOOL_OUTPUT, truncate, truncatedNote } from "./truncate.ts";

/** The system prompt of one sub-agent. Teaches the notification prefixes so
 * injected messages are never mistaken for user input, and the agent ids so
 * send_message can address the right agent. */
export function subagentSystemPrompt(
  agentId: string,
  parentId: string,
  type: SubagentType,
  canDelegate: boolean,
): string {
  const role = type === "explore" ? "research" : "coding";
  const lines = [
    `You are a ${role} sub-agent of Lumisca, started by agent ${parentId} ` +
    `to handle one piece of work. Your own id is ${agentId}.`,
    `Work on the assigned task and answer with a complete final report as ` +
    `your last message.`,
    `- A message starting with "[Message from ...]" is a message from ` +
    `another agent, not from the user: answer it with send_message or ` +
    `fold it into your work.`,
    `- If you need input mid-task, send a message to ${parentId} with ` +
    `send_message. You cannot ask the user directly.`,
  ];
  if (type === "explore") {
    lines.push(
      `- You are read-only: investigate with read/grep/glob/list_dir/skill ` +
        `and report findings with file references (path:line). Never modify ` +
        `files or run commands.`,
      `- Be thorough before concluding: the parent agent relies on your ` +
        `report.`,
    );
  } else {
    if (canDelegate) {
      lines.push(
        `- You can delegate independent work to further sub-agents with the ` +
          `task tool: they start in the background, so keep working while ` +
          `they run. Their completion arrives as a "[Task ...]" ` +
          `notification, or use task_output (wait: true) when your next ` +
          `step depends on the result.`,
      );
    }
    lines.push(
      `- Make the final report self-contained: what you did, what you ` +
        `found, and what remains open.`,
    );
  }
  return lines.join("\n");
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

/** The notification injected into the spawning agent's loop when a
 * sub-agent completes. The title starts with "[Task ...]" so system prompts
 * can teach agents to recognize it as a system notification. */
export function formatTaskCompletion(
  info: TaskInfo,
  failure?: string,
): NotificationPayload {
  if (info.status === "finished") {
    const result = truncate(info.text, MAX_TOOL_OUTPUT);
    return {
      kind: "task",
      title: `[Task ${info.agentId} (${info.description}) finished]`,
      body: result.text +
        (result.truncated ? truncatedNote("task result") : ""),
      status: "success",
    };
  }
  const verb = info.status === "aborted" ? "was aborted" : "failed";
  return {
    kind: "task",
    title: `[Task ${info.agentId} (${info.description}) ${verb}]`,
    body: failure ?? "",
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
  return text.length > 0 ? `${head}\n${text}` : head;
}
