/**
 * `vm_ask_user`: hand the machine's screen to the user and wait.
 *
 * The tool is the only way an agent can ask a human to do something at the
 * screen. It is preloaded rather than discoverable (the same reason the
 * screen tools are): an agent that cannot see the tool would try to solve
 * a login form itself, waste turns clicking at a wall, and — worse — fight
 * the user for the pointer once they take over.
 *
 * What it deliberately does NOT do is accept the user's answer as data: the
 * user acts on the screen directly, and what comes back is only their
 * description of it. That is the contract the prompt teaches, so the model
 * does not wait for a secret to be handed to it (which would put the secret
 * in the transcript).
 */
import { CoreError } from "../errors.ts";
import { TOOL_VM_ASK_USER } from "../shared/mod.ts";
import {
  object,
  optional,
  type SchemaObject,
  type SchemaOptional,
  type SchemaString,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import type { HandoverHub } from "./handover.ts";

/** Longest reason / instructions accepted. These are read by the user in a
 * banner above the screen, not stored as a document. */
export const MAX_HANDOVER_REASON_CHARS = 500;
export const MAX_HANDOVER_INSTRUCTION_CHARS = 1_000;

const askUserSchema: SchemaObject<{
  reason: SchemaString;
  instructions: SchemaOptional<SchemaString>;
}> = object({
  reason: string(
    'Why you need the user at the screen, in one sentence (e.g. "the ' +
      'login form needs a password only they know")',
  ),
  instructions: optional(string(
    "What the user should do, step by step. Omit when the reason says it " +
      "already",
  )),
});

export interface VmAskUserOptions {
  handover: HandoverHub;
}

/** Build `vm_ask_user` for one stella session. */
export function createVmAskUserTool(
  options: VmAskUserOptions,
): Tool<typeof askUserSchema> {
  return {
    name: TOOL_VM_ASK_USER,
    label: "VM Ask User",
    description:
      "Hand the machine's screen to the user and stop until they finish. " +
      "Use this when a step needs a person: a password, a verification " +
      "code, a CAPTCHA, a consent dialog you cannot read. The user drives " +
      "the machine in the browser and presses a button when done; then this " +
      "tool returns. While it waits, do not click or type. The result says " +
      "what the user did, in their words — take a vm_screenshot afterwards " +
      "to see the screen yourself.",
    parameters: askUserSchema,
    execute: (_id, params, signal): Promise<ToolResult> => {
      const reason = params.reason.trim();
      if (reason.length === 0) {
        throw new CoreError("reason must not be empty", "invalid");
      }
      if (reason.length > MAX_HANDOVER_REASON_CHARS) {
        throw new CoreError(
          `reason must be at most ${MAX_HANDOVER_REASON_CHARS} characters ` +
            `(got ${reason.length})`,
          "invalid",
        );
      }
      const instructions = params.instructions?.trim();
      if (
        instructions !== undefined &&
        instructions.length > MAX_HANDOVER_INSTRUCTION_CHARS
      ) {
        throw new CoreError(
          `instructions must be at most ${MAX_HANDOVER_INSTRUCTION_CHARS} ` +
            `characters (got ${instructions.length})`,
          "invalid",
        );
      }
      const toolCallId = _id;
      const hub = options.handover;
      const waiting = hub.pendingHandover();
      if (waiting !== null) {
        throw new CoreError(
          "The user is already being asked to take over the screen",
          "conflict",
        );
      }
      return hub.wait(
        toolCallId,
        reason,
        instructions === undefined || instructions.length === 0
          ? null
          : instructions,
        signal,
      ).then((note) => {
        const text = note.trim().length === 0
          ? "The user finished at the screen. Take a vm_screenshot to see " +
            "the result before continuing."
          : `The user finished at the screen and reported: ${note.trim()}\n\n` +
            "Take a vm_screenshot to see the result before continuing.";
        return {
          content: [{ type: "text", text }],
          details: { note: note.trim() },
        };
      });
    },
  };
}
