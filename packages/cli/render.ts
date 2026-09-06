import {
  type AskAnswer,
  type AskQuestion,
  contentText,
  type LumiscaCore,
} from "@lumisca/core";
import { formatDiffStat, TOOL_EDIT, TOOL_WRITE } from "@lumisca/core/shared";
import { color, error, errorText, getPromptFn, header, info } from "./ui.ts";

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
    | {
      content?: Array<{ type: string; text?: string }>;
      details?: { addedLines?: unknown; removedLines?: unknown };
    }
    | null;
  const text = r?.content
    ? contentText(r.content as Array<{ type: string; text?: string }>)
    : "";
  let stat = "";
  if (
    !isError && (toolName === TOOL_EDIT || toolName === TOOL_WRITE) &&
    typeof r?.details?.addedLines === "number" &&
    typeof r?.details?.removedLines === "number"
  ) {
    stat = formatDiffStat(r.details.addedLines, r.details.removedLines);
  }
  const summary = summarize(text, 200) + (stat ? ` (${stat})` : "");
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
 * shown with its options plus a free-text field that is always available,
 * and the user answers in the terminal; the answers resolve the blocked
 * run via core.answerQuestion. Without this the run would block forever —
 * the REPL loop waits for the agent to idle before reading input, so the
 * answering must happen here, in the event handler. */
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
        info(
          "回答が必要です(エージェントが待機中)。選択肢の番号か自由入力で回答してください。",
        );
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

/** Print the options of a question as a numbered list. Shared by the
 * single and multi pickers so the free-text guidance cannot drift. */
function printOptions(question: AskQuestion): void {
  header(question.question);
  question.options.forEach((option, i) => {
    const label = option.description
      ? `${option.label} — ${option.description}`
      : option.label;
    console.log(`  ${color.yellow(String(i + 1).padStart(2))}  ${label}`);
  });
}

/** One-of-N selection: a number picks the option, any other text is the
 * free-text answer. */
async function pickSingle(question: AskQuestion): Promise<string[] | null> {
  printOptions(question);
  const input = await getPromptFn()(
    "番号で選択、または自由入力 (空Enterで戻る)",
  );
  if (input === null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= question.options.length) {
    return [question.options[n - 1]!.label];
  }
  return [trimmed];
}

/** Several-of-N selection: comma-separated numbers pick the options; any
 * other text is a free-text answer (mixed input like `1,3,自由な案` is
 * allowed). */
async function pickMulti(question: AskQuestion): Promise<string[] | null> {
  printOptions(question);
  const input = await getPromptFn()(
    "番号をカンマ区切りで選択、または自由入力 (空Enterで戻る、混在可 例: 1,3,自由な案)",
  );
  if (input === null) return null;
  const values: string[] = [];
  for (const raw of input.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    const n = Number(token);
    if (Number.isInteger(n) && n >= 1 && n <= question.options.length) {
      values.push(question.options[n - 1]!.label);
    } else {
      values.push(token);
    }
  }
  return values.length > 0 ? values : null;
}
