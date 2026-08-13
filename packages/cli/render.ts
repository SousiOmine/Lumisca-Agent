import {
  type AskAnswer,
  type AskQuestion,
  contentText,
  type LumiscaCore,
} from "@lumisca/core";
import { color, error, errorText, getPromptFn, header, info } from "./ui.ts";
import { selectFromList } from "./select.ts";

/** Event-rendering helpers for the REPL. Kept separate from the input loop
 * (repl.ts) so the terminal formatting lives in one place. */

export function summarize(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

export function printToolStart(toolName: string, args: unknown): void {
  const argsText = summarize(JSON.stringify(args ?? {}), 120);
  console.log(color.cyan(`  ⚙ ${toolName} ${color.faint(argsText)}`));
}

export function printTaskStart(
  agentId: string,
  subagentType: string,
  description: string,
): void {
  console.log(
    color.blue(
      `  ◉ task ${agentId} (${subagentType}) ${color.faint(description)}`,
    ),
  );
}

export function printTaskEnd(agentId: string, status: string): void {
  const mark = status === "finished" ? color.green("✓") : color.red("✗");
  console.log(color.blue(`  ${mark} task ${agentId} ${status}`));
}

export function printToolEnd(
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const r = result as
    | { content?: Array<{ type: string; text?: string }> }
    | null;
  const text = r?.content
    ? contentText(r.content as Array<{ type: string; text?: string }>)
    : "";
  const summary = summarize(text, 200);
  if (isError) {
    console.log(color.red(`  ✗ ${toolName} → ${summary}`));
  } else {
    console.log(color.dim(`  ✓ ${toolName} → ${summary}`));
  }
}

/**
 * Tracks whether the agent's streamed text is mid-line, so follow-up
 * output (errors, questions, prompts) starts on a fresh line. The
 * streaming flag is deliberately shared across session switches (one
 * stream at a time per REPL).
 */
export class StreamPrinter {
  private streaming = false;

  get isStreaming(): boolean {
    return this.streaming;
  }

  /** Append a streamed delta (marks the line as open). */
  write(delta: string): void {
    process.stdout.write(delta);
    this.streaming = true;
  }

  /** Close the streamed line: a newline for assistant messages (they are
   * printed without one), always for errors/questions (whatever was
   * mid-line must end). `role` undefined = unconditional newline. */
  end(role?: string): void {
    if (this.streaming && (role === undefined || role === "assistant")) {
      process.stdout.write("\n");
    }
    this.streaming = false;
  }
}

/** Answer the agent's questions (the ask tool) inline: each question is
 * shown with its options and the user answers in the terminal; the answers
 * resolve the blocked run via core.answerQuestion. Without this the run
 * would block forever — the REPL loop waits for the agent to idle before
 * reading input, so the answering must happen here, in the event handler. */
export async function answerQuestions(
  core: LumiscaCore,
  sessionId: string,
  toolCallId: string,
  questions: AskQuestion[],
): Promise<void> {
  const answers: AskAnswer[] = [];
  for (const question of questions) {
    let chosen: string[] | null = null;
    while (chosen === null) {
      chosen = question.multi === true
        ? await pickMulti(question)
        : await pickSingle(question);
      if (chosen === null) {
        info("回答が必要です(エージェントが待機中)。選択してください。");
      }
    }
    answers.push({ id: question.id, values: chosen });
  }
  try {
    core.answerQuestion(sessionId, toolCallId, answers);
  } catch (e) {
    // The ask may be gone (run aborted/rewound while answering).
    error(errorText(e));
  }
}

/** One-of-N selection with the shared searchable picker. */
async function pickSingle(question: AskQuestion): Promise<string[] | null> {
  const option = await selectFromList(
    question.question,
    question.options.map((o) => ({
      label: o.description ? `${o.label} — ${o.description}` : o.label,
      value: o.label,
    })),
  );
  return option === null ? null : [option];
}

/** Several-of-N selection: a numbered list plus comma-separated input. */
async function pickMulti(question: AskQuestion): Promise<string[] | null> {
  header(question.question);
  question.options.forEach((option, i) => {
    const label = option.description
      ? `${option.label} — ${option.description}`
      : option.label;
    console.log(`  ${color.yellow(String(i + 1).padStart(2))}  ${label}`);
  });
  const input = await getPromptFn()("番号をカンマ区切りで選択 (空Enterで戻る)");
  if (input === null) return null;
  const values: string[] = [];
  for (const raw of input.split(",")) {
    const n = Number(raw.trim());
    if (!Number.isInteger(n)) continue;
    const option = question.options[n - 1];
    if (option === undefined) {
      error(`無効な番号: ${raw.trim()}`);
      return null;
    }
    values.push(option.label);
  }
  return values.length > 0 ? values : null;
}
