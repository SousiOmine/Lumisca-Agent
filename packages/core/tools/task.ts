import { CoreError } from "../errors.ts";
import {
  TOOL_SEND_MESSAGE,
  TOOL_TASK,
  TOOL_TASK_OUTPUT,
} from "../shared/mod.ts";
import type { TaskHub } from "./task-hub.ts";
import {
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";
import { formatTaskOutput } from "./subagent-format.ts";
// --- tools -------------------------------------------------------------------

const taskSchema = object({
  subagent_type: string(
    'The kind of sub-agent to launch: "general" (full coding agent) or "explore" (read-only research)',
  ),
  description: string(
    "A short (3-5 word) description of the work, shown in the UI",
  ),
  prompt: string(
    "Complete, self-contained instructions for the sub-agent. It starts " +
      "with no context, so include every fact it needs.",
  ),
});

/** Build the tool that starts a sub-agent. The agent runs in the background
 * and the tool returns immediately, so the caller can keep working; the
 * result arrives later as a "[Task ...]" notification (or via
 * task_output). */
export function createTaskTool(
  hub: TaskHub,
  agentId: string,
  depth: number,
): Tool<typeof taskSchema> {
  return {
    name: TOOL_TASK,
    label: "Task",
    description:
      "Start a sub-agent that works on one job in the background while you " +
      "continue with other work. Returns immediately with the agent id. " +
      'The result arrives later as a "[Task ...]" notification; use ' +
      "task_output to check progress, or wait: true when your next step " +
      "depends on the result. Reach a running sub-agent with send_message.",
    parameters: taskSchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      if (
        params.subagent_type !== "general" &&
        params.subagent_type !== "explore"
      ) {
        throw new CoreError(
          `Unknown subagent_type "${params.subagent_type}": expected ` +
            `"general" or "explore"`,
          "invalid",
        );
      }
      const info = hub.spawn(
        agentId,
        depth,
        params.subagent_type,
        params.description,
        params.prompt,
      );
      return Promise.resolve({
        content: [{
          type: "text",
          text:
            `Task started: ${info.agentId} (${info.subagentType}) — ${info.description}\n` +
            `It runs in the background: continue with other work. Its ` +
            `completion arrives as a "[Task ${info.agentId} ...]" ` +
            `notification; check progress with task_output or reach it with ` +
            `send_message.`,
        }],
        details: { ...info },
      });
    },
  };
}

const taskOutputSchema = object({
  agent_id: string(
    "The id of the sub-agent (returned by the task tool when it was started)",
  ),
  wait: optional(boolean(
    "Wait until the agent finishes instead of returning immediately (default false)",
  )),
  timeout_sec: optional(integer(
    "With wait: how long to wait in seconds before returning the current state (default 30, max 300)",
  )),
});

/** Build the tool that reports on a sub-agent: its status and, when
 * settled, its final report; while running, the tail of its live response.
 * `wait: true` blocks the caller until the agent settles (bounded by
 * `timeout_sec`, and settled by the caller's run abort). */
export function createTaskOutputTool(
  hub: TaskHub,
  agentId: string,
): Tool<typeof taskOutputSchema> {
  return {
    name: TOOL_TASK_OUTPUT,
    label: "Task Output",
    description:
      "Check a sub-agent started with task: its status and, when finished, " +
      "its final report; while running, the tail of its live response. " +
      "Use wait: true to block until it finishes.",
    parameters: taskOutputSchema,
    async execute(_toolCallId, params, signal): Promise<ToolResult> {
      const timeoutSec = params.timeout_sec ?? 30;
      if (timeoutSec < 1 || timeoutSec > 300) {
        throw new CoreError(
          `timeout_sec must be between 1 and 300 (got ${timeoutSec})`,
          "invalid",
        );
      }
      const info = params.wait === true
        ? await hub.wait(params.agent_id, agentId, timeoutSec, signal)
        : hub.info(params.agent_id);
      return {
        content: [{ type: "text", text: formatTaskOutput(info) }],
        details: { ...info },
      };
    },
  };
}

const sendMessageSchema = object({
  to: string(
    'The id of the agent to message. Use "parent" to reach the agent that started this one.',
  ),
  summary: string("A short (5-10 word) summary of the message"),
  message: string("The full message text"),
});

/** Build the tool that sends a message to another agent (mesh: the main
 * agent or any sub-agent of the session's tree). The recipient sees it as a
 * "[Message from ...]" notification on its next step. */
export function createSendMessageTool(
  hub: TaskHub,
  agentId: string,
): Tool<typeof sendMessageSchema> {
  return {
    name: TOOL_SEND_MESSAGE,
    label: "Send Message",
    description:
      "Send a message to another agent (the main agent or a sub-agent " +
      'started with task). The recipient sees it as a "[Message from ' +
      '...]" notification on its next step. Use "parent" as the id to ' +
      "reach the agent that started this one. This only delivers the " +
      "message; replies arrive as messages from the other side.",
    parameters: sendMessageSchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      const { deliveredTo } = hub.sendMessage(
        agentId,
        params.to,
        params.summary,
        params.message,
      );
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Message sent to ${deliveredTo}: ${params.summary}`,
        }],
        details: { from: agentId, to: deliveredTo, summary: params.summary },
      });
    },
  };
}
