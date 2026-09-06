import { useState } from "react";
import { IconMessageQuestion, IconSend } from "@tabler/icons-react";
import type { AskAnswer, AskQuestion, PendingQuestion } from "../types.ts";

/** Selected option indices per question id, inside one question card. */
type Selections = Record<string, number[]>;

/** Free-text input per question id, inside one question card. Always
 * available alongside the predefined options. */
type CustomInputs = Record<string, string>;

/** The user's answer for one question: the selected option labels and/or
 * the free-text input. Single choice is exclusive (free text wins);
 * multi choice combines selections with the free text. */
function toAnswer(
  question: AskQuestion,
  indices: number[],
  custom: string,
): AskAnswer {
  const trimmed = custom.trim();
  if (trimmed.length === 0) {
    return {
      id: question.id,
      values: indices.map((i) => question.options[i]!.label),
    };
  }
  if (question.multi === true) {
    return {
      id: question.id,
      values: [
        ...indices.map((i) => question.options[i]!.label),
        trimmed,
      ],
    };
  }
  return { id: question.id, values: [trimmed] };
}

/** True when every question has at least one selection or a free-text
 * input (submit enabled). */
function allAnswered(
  questions: AskQuestion[],
  selections: Selections,
  customs: CustomInputs,
): boolean {
  return questions.every(
    (q) =>
      (selections[q.id]?.length ?? 0) > 0 ||
      (customs[q.id]?.trim().length ?? 0) > 0,
  );
}

/** Initial selection: the recommended option is preselected when given. */
function initialSelections(
  questions: AskQuestion[],
): Selections {
  const selections: Selections = {};
  for (const q of questions) {
    if (q.recommended !== undefined && q.options[q.recommended] !== undefined) {
      selections[q.id] = [q.recommended];
    }
  }
  return selections;
}

function QuestionCard({
  pending,
  onAnswer,
}: {
  pending: PendingQuestion;
  onAnswer: (toolCallId: string, answers: AskAnswer[]) => Promise<void>;
}) {
  const [selections, setSelections] = useState<Selections>(() =>
    initialSelections(pending.questions)
  );
  const [customs, setCustoms] = useState<CustomInputs>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Toggle (multi) or replace (single) the selection of an option.
   * Single choice is exclusive with the free-text input: picking an
   * option clears it. */
  const select = (questionId: string, index: number, multi: boolean) => {
    setSelections((prev) => {
      const current = prev[questionId] ?? [];
      const next = multi
        ? current.includes(index)
          ? current.filter((i) => i !== index)
          : [...current, index]
        : [index];
      return { ...prev, [questionId]: next };
    });
    if (!multi) {
      setCustoms((prev) =>
        prev[questionId] ? { ...prev, [questionId]: "" } : prev
      );
    }
  };

  /** Edit the free-text input. Single choice is exclusive: typing clears
   * the option selections so the answer stays a single value. */
  const editCustom = (questionId: string, value: string, multi: boolean) => {
    setCustoms((prev) => ({ ...prev, [questionId]: value }));
    if (!multi && value.trim().length > 0) {
      setSelections((prev) =>
        (prev[questionId]?.length ?? 0) > 0
          ? { ...prev, [questionId]: [] }
          : prev
      );
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(
        pending.toolCallId,
        pending.questions.map((q) =>
          toAnswer(q, selections[q.id] ?? [], customs[q.id] ?? "")
        ),
      );
      // The panel disappears once the tool_end event arrives.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="question-card">
      <div className="question-card-header">
        <IconMessageQuestion size={14} />
        <span>質問</span>
      </div>
      {pending.questions.map((q) => {
        const multi = q.multi === true;
        const selected = selections[q.id] ?? [];
        const custom = customs[q.id] ?? "";
        return (
          <div key={q.id} className="question-item">
            {q.header && <div className="question-header">{q.header}</div>}
            <div className="question-text">{q.question}</div>
            <div
              className="question-options"
              role={multi ? "group" : "radiogroup"}
            >
              {q.options.map((option, index) => {
                const active = selected.includes(index);
                return (
                  <button
                    key={index}
                    type="button"
                    role={multi ? "checkbox" : "radio"}
                    aria-checked={active}
                    className={`question-option${active ? " selected" : ""}`}
                    onClick={() => select(q.id, index, multi)}
                  >
                    <span className="question-option-mark">
                      {active ? (multi ? "☑" : "●") : (multi ? "☐" : "○")}
                    </span>
                    <span className="question-option-label">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="question-option-desc">
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              className="question-free-input"
              placeholder="自由入力（選択肢にない場合はこちらに入力）"
              aria-label={`${q.question}への自由入力`}
              value={custom}
              onChange={(e) => editCustom(q.id, e.target.value, multi)}
            />
          </div>
        );
      })}
      <div className="question-card-footer">
        <button
          type="button"
          className="btn primary"
          onClick={submit}
          disabled={submitting ||
            !allAnswered(pending.questions, selections, customs)}
        >
          <IconSend size={13} />
          {submitting ? "送信中..." : "回答を送信"}
        </button>
        {error && <span className="question-error">{error}</span>}
      </div>
    </div>
  );
}

/** The agent's pending questions (ask tool), shown above the composer.
 * One card per tool call; each card submits its answers independently. */
export function QuestionPanel({
  pending,
  onAnswer,
}: {
  pending: PendingQuestion[];
  onAnswer: (toolCallId: string, answers: AskAnswer[]) => Promise<void>;
}) {
  if (pending.length === 0) return null;
  return (
    <div className="question-panel">
      {pending.map((p) => (
        <QuestionCard key={p.toolCallId} pending={p} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
