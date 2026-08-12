import { CoreError } from "../errors.ts";
import { type AskAnswer, type AskQuestion, TOOL_ASK } from "../shared.ts";
import type { ClientEvent } from "../types/event.ts";
import {
  array,
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";

/** A pending ask: the questions shown to the user, with the resolvers that
 * the answer (or the session teardown) settles. */
interface PendingAsk {
  questions: AskQuestion[];
  resolve: (answers: AskAnswer[]) => void;
  reject: (error: Error) => void;
}

/**
 * Owns the questions the agent asked (via the ask tool) in one session.
 * Each ask blocks the agent loop until the user answers: the tool registers
 * here and awaits the returned promise; answerQuestion() resolves it with
 * the user's answers (arriving via the HTTP layer), and the tool then hands
 * them back to the agent as its result.
 *
 * The lifecycle is bound to the session agent: the agent rejects every
 * pending ask when its run ends or the session closes (abort, rewind,
 * close), so no ask can hang past the run that asked it.
 */
export class AskHub {
  private readonly pending = new Map<string, PendingAsk>();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ClientEvent) => void,
  ) {}

  /** Register questions for one tool call and wait for the user's answers.
   * The questions are announced to clients via a `question` event. The
   * returned promise resolves with the answers, or rejects when the run is
   * torn down first (abort / rewind / close). */
  ask(toolCallId: string, questions: AskQuestion[]): Promise<AskAnswer[]> {
    if (this.pending.has(toolCallId)) {
      return Promise.reject(
        new CoreError(`Question already pending: ${toolCallId}`, "conflict"),
      );
    }
    this.emit({
      type: "question",
      sessionId: this.sessionId,
      toolCallId,
      questions,
    });
    return new Promise<AskAnswer[]>((resolve, reject) => {
      this.pending.set(toolCallId, { questions, resolve, reject });
    });
  }

  /** Resolve a pending ask with the user's answers. Throws when the ask is
   * gone (already answered, or the run was torn down). The answers are
   * validated against the pending questions (ids and option labels), so a
   * malformed client request surfaces as a 400 instead of reaching the
   * agent. */
  answer(toolCallId: string, answers: AskAnswer[]): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      throw new CoreError(
        `No pending question for tool call: ${toolCallId}`,
        "not_found",
      );
    }
    const byId = new Map(pending.questions.map((q) => [q.id, q]));
    if (answers.length !== pending.questions.length) {
      throw new CoreError(
        "answers must cover every question",
        "invalid",
      );
    }
    for (const answer of answers) {
      const question = byId.get(answer.id);
      if (!question) {
        throw new CoreError(
          `Unknown question id: ${answer.id}`,
          "invalid",
        );
      }
      if (!Array.isArray(answer.values) || answer.values.length === 0) {
        throw new CoreError(
          `Question "${answer.id}" has no answer`,
          "invalid",
        );
      }
      const labels = new Set(question.options.map((o) => o.label));
      for (const value of answer.values) {
        if (!labels.has(value)) {
          throw new CoreError(
            `Unknown option for question "${answer.id}": ${value}`,
            "invalid",
          );
        }
      }
    }
    this.pending.delete(toolCallId);
    pending.resolve(answers);
  }

  /** Reject every pending ask. Called when the run ends or the session
   * closes, so a torn-down run cannot leave an ask hanging. */
  rejectAll(): void {
    for (const [toolCallId, pending] of this.pending) {
      this.pending.delete(toolCallId);
      pending.reject(
        new CoreError(`Question cancelled: ${toolCallId}`, "unavailable"),
      );
    }
  }
}

const askSchema = object({
  questions: array(
    object({
      id: string(
        "A unique identifier for this question (returned with the answer)",
      ),
      question: string("The question text shown to the user"),
      header: optional(string("A short heading shown above the question")),
      options: array(
        object({
          label: string("The option label shown to the user"),
          description: optional(string(
            "An optional explanation of the option, shown under the label",
          )),
        }),
        "The choices the user can pick from (at least one)",
      ),
      multi: optional(boolean(
        "Allow selecting several options (default: single choice)",
      )),
      recommended: optional(integer(
        "Index of the option to preselect when the question appears",
      )),
    }),
    "The questions to ask the user (at least one)",
  ),
});

/** Build the tool that lets the agent ask the user a question. The user
 * answers in the UI (a panel above the composer); the selected option
 * labels are returned as the tool result, so the agent can continue from
 * the answer. The tool blocks the run until the user answers (or the run
 * is aborted). */
export function createAskTool(hub: AskHub): Tool<typeof askSchema> {
  return {
    name: TOOL_ASK,
    label: "Ask",
    description:
      "Ask the user one or more questions and get their answers. Use this " +
      "when you need input only the user can provide — preferences, " +
      "choices, or confirmation — and the task genuinely depends on it. " +
      "The user answers in the UI (a panel appears above the chat input); " +
      "the run waits for the answer. Every question offers predefined " +
      "options (use `multi: true` when several may apply, `recommended` to " +
      "preselect one). Do not use this for information you can obtain from " +
      "your own tools.",
    parameters: askSchema,
    execute: async (toolCallId, params, _signal): Promise<ToolResult> => {
      const questions = params.questions;
      if (questions.length === 0) {
        throw new CoreError("ask requires at least one question", "invalid");
      }
      const ids = new Set<string>();
      for (const q of questions) {
        if (ids.has(q.id)) {
          throw new CoreError(
            `Duplicate question id: ${q.id}`,
            "invalid",
          );
        }
        ids.add(q.id);
        if (q.options.length === 0) {
          throw new CoreError(
            `Question "${q.id}" has no options`,
            "invalid",
          );
        }
        if (
          q.recommended !== undefined &&
          (q.recommended < 0 || q.recommended >= q.options.length)
        ) {
          throw new CoreError(
            `Question "${q.id}": recommended index ${q.recommended} is out of range`,
            "invalid",
          );
        }
      }
      const answers = await hub.ask(toolCallId, questions);
      const lines = answers.map((answer) => {
        const question = questions.find((q) => q.id === answer.id);
        const text = question?.question ?? answer.id;
        return `- ${text}: ${answer.values.join(", ")}`;
      });
      return {
        content: [{
          type: "text",
          text: `Answers from the user:\n${lines.join("\n")}`,
        }],
        details: { answers },
      };
    },
  };
}
