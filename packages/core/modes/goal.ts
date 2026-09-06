import type { AgentMode } from "./mod.ts";

/** Default upper bound for the autonomous goal loop (see goal/loop.ts).
 * Kept here so the prompt text and the runtime agree on the same number;
 * a future setting may override it per goal. */
export const DEFAULT_MAX_GOAL_ITERATIONS = 10;

/** The goal-mode internal rules, embedded in every goal prompt. The
 * server-side loop (fast model judge) decides continuation; the agent
 * itself just works toward the goal and reports completion. */
const GOAL_RULES = `# 進め方
1. ゴール達成のために必要な作業（調査・編集・テスト・修正）を進めてください。
2. エージェントが判断できないこと（依頼の解釈、計画の前提、実装方針の選択など、計画の成否に影響する判断）は、ask ツールでユーザーに質問してください。自分で調査・確認できることは質問せず、調査してください。
3. 途中でユーザーから停止（abort）や巻き戻し（rewind）の指示があった場合は、直ちに従ってください。

# 終了条件
- ゴールが達成できたら、その根拠（テスト結果・変更内容など）とともに完了を報告して終了してください。`;

/** Build the goal-mode prompt for a goal. An empty goal yields a
 * defensive fallback that asks the user for it instead of running
 * blindly (the UI never sends this — it requires the goal text). */
export function buildGoalPrompt(goal: string): string {
  const trimmed = goal.trim();
  const subject = trimmed.length > 0
    ? trimmed
    : "（ゴールが指定されていません。まず ask ツールでユーザーにゴールを確認してください）";
  return `あなたはゴール達成エージェントです。以下のゴールが達成されるまで、自律的に作業を進めてください。

# ゴール
${subject}

${GOAL_RULES}`;
}

export const goalMode: AgentMode = {
  id: "goal",
  label: "ゴール",
  modeLabel: "ゴールモード",
  description: "ゴールを宣言し、達成まで自律的に反復します",
  options: [],
  // Text-taking mode: the goal arrives via buildPromptForText; a plain
  // buildPrompt call has no goal, so it falls back to asking the user.
  buildPrompt(): string {
    return buildGoalPrompt("");
  },
  buildPromptForText(text: string): string {
    return buildGoalPrompt(text);
  },
  buildShortText(): string {
    return "ゴール達成まで作業してください";
  },
};
