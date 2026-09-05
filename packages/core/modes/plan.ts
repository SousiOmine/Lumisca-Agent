import type { AgentMode } from "./mod.ts";

/**
 * Plan mode: the agent drafts an implementation plan for the user's
 * request. It is a text-taking mode: the request is the composer text
 * typed after the `/plan` token (e.g. `/plan ブラウザ履歴機能を追加して`),
 * supplied via `buildPromptForText` — the mode has no fixed options.
 *
 * The internal rules enforce the plan-only contract: no file edits until
 * the user explicitly permits them (asked at the end of the planning
 * phase), and questions the agent cannot decide itself go to the ask
 * tool instead of being guessed.
 */

/** The plan-mode internal rules, embedded in every plan prompt. */
const PLAN_RULES = `# 内部ルール
- ユーザーが明示的に許可するまで、ファイルの編集・書き込みは禁止です。write / edit ツールは使用せず、bash でもファイルを変更するコマンド（リダイレクト、mv / rm / mkdir、git commit / push など）は実行しないでください。読み取り専用のコマンド（git status / git diff、deno test など副作用のないもの）は調査目的で使用できます。
- エージェントが判断できないこと（依頼の解釈、計画の前提、実装方針の選択など、計画の成否に影響する判断）は、ask ツールでユーザーに質問してください。自分で調査・確認できることは質問せず、調査してください。

# 進め方
1. 依頼内容を正確に把握してください。曖昧な点があれば ask ツールでユーザーに質問してください。
2. read / grep / glob / list_dir ツールと読み取り専用の bash コマンドで既存のコードと構造を調査し、実装方針を固めてください。
3. 実装計画を立案してください。計画には以下を含めてください:
   - 目的と実装方針
   - 変更対象となるファイル・モジュールと、それぞれの変更内容
   - 実装手順（段階に分けて）
   - 検証方法（テスト・ビルド・手動確認）
   - リスクと注意点

# 実装の開始
計画を提示した後、ask ツールで「この計画で実装を進めますか?」とユーザーに確認してください（「実装を進める」「計画のみで終了」などの選択肢を用意してください）。
- ユーザーが明示的に実装を許可した場合のみ、計画に沿って実装を開始してください。
- 許可が得られなかった場合は、計画の提示で終了してください。
- 実装を開始した場合は計画に忠実に進め、完了後は変更内容と検証結果を報告してください。`;

/** Build the plan-mode prompt for a request. An empty request yields a
 * defensive fallback that asks the user for it instead of planning
 * blindly (the UI never sends this — it requires the request text). */
export function buildPlanPrompt(request: string): string {
  const trimmed = request.trim();
  const subject = trimmed.length > 0
    ? trimmed
    : "（依頼内容が指定されていません。まず ask ツールでユーザーに依頼内容を確認してください）";
  return `あなたは実装プランナーです。ユーザーの依頼に従って、実装計画を立案してください。コードの編集は、ユーザーが明示的に許可するまで行わないでください。

# 依頼内容
${subject}

${PLAN_RULES}`;
}

export const planMode: AgentMode = {
  id: "plan",
  label: "プラン",
  modeLabel: "プランモード",
  description: "実装計画を立案します（許可するまで編集しません）",
  options: [],
  // Text-taking mode: the request arrives via buildPromptForText; a plain
  // buildPrompt call has no request, so it falls back to asking the user.
  buildPrompt(): string {
    return buildPlanPrompt("");
  },
  buildPromptForText(text: string): string {
    return buildPlanPrompt(text);
  },
  buildShortText(): string {
    return "実装計画を立案してください";
  },
};
