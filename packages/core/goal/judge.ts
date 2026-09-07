import type { Api, Model } from "../ai/types.ts";
import type { AgentMessage, StreamFn } from "../ai/types.ts";
import { streamText } from "../agent/stream-text.ts";
import { contentText, safeJsonParse } from "../shared/mod.ts";

/** System prompt for the judging model: decide whether the goal is
 * achieved from the recent transcript and, when it is not, write the next
 * turn's instruction. Reply with JSON only (like the safety checker). */
const GOAL_JUDGE_SYSTEM_PROMPT =
  "You are the goal judge of a coding agent. You are given the user's GOAL " +
  "and an excerpt of the recent transcript (the main agent's work so far). " +
  "Decide whether the goal is already achieved. When it is not achieved, " +
  "write the next turn's instruction (nextPrompt): a short, concrete " +
  "instruction telling the main agent what to do next toward the goal " +
  "(e.g. which file to fix, which test to run). Reply with JSON only, " +
  "no prose: " +
  '{"achieved": true|false, "reason": "short explanation", "nextPrompt": "instruction for the next turn (empty when achieved)"}';

/** How long a judgement may take before the check gives up. */
const GOAL_JUDGE_TIMEOUT_MS = 30_000;

/** Upper bound of the transcript excerpt sent to the judge (tail-kept). */
export const MAX_GOAL_TRANSCRIPT_CHARS = 8000;

/** The outcome of one goal judgement. `nextPrompt` is empty when the goal
 * is achieved. */
export interface GoalVerdict {
  achieved: boolean;
  reason: string;
  nextPrompt: string;
}

/** Input to one judgement: the declared goal, the recent transcript as
 * plain text (already truncated), and the loop progress. */
export interface GoalJudgeInput {
  goal: string;
  transcript: string;
  iteration: number;
  maxIterations: number;
}

/**
 * Judges whether the session's goal is achieved using the fast model (or
 * the main model as a fallback when no fast model is configured — the
 * caller resolves which model to pass). One LLM call returns both the
 * verdict and, when unachieved, the next turn's prompt, so the loop stays
 * cheap and fast.
 *
 * Returns null when the reply is not the expected JSON; throws on stream
 * errors and timeouts (the caller stops the loop and surfaces the error).
 */
export class GoalJudge {
  constructor(
    private readonly model: Model<Api>,
    private readonly streamFn: StreamFn,
  ) {}

  async judge(input: GoalJudgeInput): Promise<GoalVerdict | null> {
    const controller = new AbortController();
    const collect = async () => {
      const text = await streamText(
        this.streamFn,
        this.model,
        {
          systemPrompt: GOAL_JUDGE_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [{ type: "text", text: buildGoalJudgeUserText(input) }],
            timestamp: Date.now(),
          }],
        },
        "goal judgement request failed",
        { signal: controller.signal },
      );
      return parseGoalVerdict(text);
    };
    // Same timeout discipline as the safety checker: abort well-behaved
    // streams and race providers that ignore the signal, so the check
    // never hangs the agent loop.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        collect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("goal judgement timed out"));
          }, GOAL_JUDGE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build the user text for one judgement: goal + progress + last output. */
export function buildGoalJudgeUserText(input: GoalJudgeInput): string {
  return `GOAL:\n${input.goal}\n\n` +
    `PROGRESS: iteration ${input.iteration}/${input.maxIterations}\n\n` +
    `LAST OUTPUT:\n${input.transcript}`;
}

/** Extract {"achieved": bool, "reason": string, "nextPrompt": string} from
 * the model's reply. Models occasionally wrap the JSON in markdown fences
 * or add prose; take the first balanced {...} object and parse it. An
 * achieved verdict may omit nextPrompt (normalized to ""). Returns null
 * when nothing parses into the expected shape. */
export function parseGoalVerdict(text: string): GoalVerdict | null {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (match === null) return null;
  const parsed = safeJsonParse<unknown>(match[0]);
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v["achieved"] !== "boolean") return null;
  if (typeof v["reason"] !== "string") return null;
  const nextRaw = v["nextPrompt"];
  if (
    nextRaw !== undefined && typeof nextRaw !== "string"
  ) return null;
  const nextPrompt = typeof nextRaw === "string" ? nextRaw.trim() : "";
  const reason = (v["reason"] as string).trim();
  if (reason.length === 0) return null;
  // An unachieved verdict without a next instruction cannot drive the
  // loop, so it is treated as unparseable (the caller stops safely).
  if (v["achieved"] === false && nextPrompt.length === 0) return null;
  return {
    achieved: v["achieved"] as boolean,
    reason,
    nextPrompt: v["achieved"] ? "" : nextPrompt,
  };
}

/** The main agent's last output as plain text for the judge. Only the
 * latest assistant message is used: earlier turns are intentionally
 * excluded. Tail-kept to MAX_GOAL_TRANSCRIPT_CHARS for safety. */
export function lastAssistantOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const text = transcriptTextOf(message).trim();
    if (text.length === 0) continue;
    if (text.length <= MAX_GOAL_TRANSCRIPT_CHARS) return text;
    return text.slice(text.length - MAX_GOAL_TRANSCRIPT_CHARS);
  }
  return "";
}

/** Render recent agent messages as plain text (kept for tests/debug).
 * The goal loop itself uses {@link lastAssistantOutput} instead. */
export function excerptTranscript(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const role = message.role;
    // Mode/notification internals carry no progress signal beyond their
    // text; include them under their own label when they have text.
    const text = transcriptTextOf(message);
    if (text.trim().length === 0) continue;
    lines.push(`[${role}] ${text}`);
  }
  const joined = lines.join("\n\n");
  if (joined.length <= MAX_GOAL_TRANSCRIPT_CHARS) return joined;
  return joined.slice(joined.length - MAX_GOAL_TRANSCRIPT_CHARS);
}

/** Plain-text rendering of one transcript message for the judge. */
function transcriptTextOf(message: AgentMessage): string {
  const m = message as {
    content?: unknown;
    fullPrompt?: unknown;
    title?: unknown;
    body?: unknown;
  };
  if (typeof m.fullPrompt === "string") return m.fullPrompt;
  if (typeof m.title === "string" || typeof m.body === "string") {
    return `${m.title ?? ""}\n${m.body ?? ""}`.trim();
  }
  const content = m.content as
    | string
    | Array<{ type: string; text?: string }>
    | undefined;
  if (content === undefined) return "";
  return contentText(content);
}
