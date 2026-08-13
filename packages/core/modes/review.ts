import type { AgentMode } from "./mod.ts";

/** What the review covers: the branch's diff against its base, or the
 * uncommitted worktree changes. */
export type ReviewTarget = "base-diff" | "uncommitted";

/** Shared review rules; the language of the report is left to the agent
 * (it follows the conversation's language naturally). */
const REVIEW_RULES = `# 指摘ルール
- 指摘するのは、正確性・性能・セキュリティ・保守性に意味のある影響がある問題のみです。
- 問題は具体的かつ修正可能であること。曖昧な感想や好みの指摘はしないでください。
- 作者が知ったら実際に直したいと思う問題に絞ってください。
- 作者の意図について暗黙の仮定を置かないでください。意図が読み取れない変更がある場合は、その旨を指摘として報告してください。
- 「他の場所が壊れる」と推測するだけでは不十分です。実際に影響される箇所（呼び出し元・利用箇所）をコードを読んで特定し、根拠を示してください。
- 明らかに意図的な変更（リファクタリング、命名変更、明示的な妥協など）をバグとして扱わないでください。意図的と思われる変更にはその旨を添えてください。
- レビュー対象の差分に含まれない既存の問題は掘り返さないでください。

# 報告形式
指摘ごとに、次の情報を含めて報告してください:
- 場所: ファイルパスと行番号（または変更箇所）
- 問題: 何が問題か
- 影響: なぜ問題か、何に影響するか
- 推奨する修正の方向性: どう直すべきか`;

/** Git steps for the uncommitted-changes target. */
const UNCOMMITTED_STEPS = `未コミットの変更の場合:
- \`git status\` で変更されたファイルの一覧を確認してください。
- \`git diff HEAD\` でステージ済み・未ステージの両方の変更の差分を取得してください。
- 追跡されていない新規ファイルも \`git status\` で確認し、今回の変更の一部と判断できるものは読んでレビューに含めてください。`;

/** Git steps for the base-branch-diff target. */
const BASE_DIFF_STEPS = `ベースブランチとの差分の場合:
- \`git branch --show-current\` で現在のブランチを確認してください。
- ベースブランチを特定してください: リポジトリに \`main\` または \`master\` ブランチがあればそれを使い、どちらもない場合は \`git remote show origin\` の出力からリモートの既定ブランチ（HEAD）を確認してください。
- \`git diff <ベースブランチ>...HEAD\` で、現在のブランチの変更差分を取得してください。
- 現在のブランチがベースブランチと同じ場合は差分が空になります。`;

/** Build the review user message for a target. The agent fetches the diff
 * itself with its git/bash tools, so no server support is needed. */
export function buildReviewPrompt(target: ReviewTarget): string {
  const targetLabel = REVIEW_TARGET_LABELS[target];
  const steps = target === "uncommitted" ? UNCOMMITTED_STEPS : BASE_DIFF_STEPS;
  return `あなたはコードレビュアーです。別のエンジニアが行ったコード変更をレビューし、指摘事項を報告してください。コードの修正は行わないでください（ファイルの編集・書き込みは禁止です）。指摘のみを行います。

# レビュー対象
${targetLabel}

# 進め方
1. bash ツールで git コマンドを実行して、レビュー対象の変更を取得してください。
${steps}
- 差分が空の場合、または git リポジトリではない場合は、その旨を報告して終了してください。
- 差分が大きい場合（bash の出力が切り詰められる場合）は、\`git diff -- <path>\` のようにファイル単位に分割して取得してください。
2. 変更されたファイルとその周辺を read / grep / glob ツールで読み、変更の内容と影響範囲を正確に把握してください。

${REVIEW_RULES}`;
}

/** Labels of the review targets (menu text; also embedded in the prompt's
 * 対象 line). */
export const REVIEW_TARGET_LABELS: Record<ReviewTarget, string> = {
  "base-diff": "ベースブランチとの差分",
  uncommitted: "未コミットの変更",
};

export const reviewMode: AgentMode = {
  id: "review",
  label: "レビュー",
  description: "コード変更をレビューします",
  options: [
    {
      id: "base-diff",
      label: REVIEW_TARGET_LABELS["base-diff"],
      description: "現在のブランチと main などのベースブランチの差分をレビュー",
    },
    {
      id: "uncommitted",
      label: REVIEW_TARGET_LABELS.uncommitted,
      description: "まだコミットされていない変更をレビュー",
    },
  ],
  buildPrompt(optionId: string): string {
    const target = optionId === "uncommitted" ? "uncommitted" : "base-diff";
    return buildReviewPrompt(target);
  },
};
