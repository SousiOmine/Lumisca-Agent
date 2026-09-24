import type { LocalizedText } from "./types.ts";

/**
 * Messages of the side panels and session lists: the progress panels (todo,
 * tasks, background commands, goal, context usage), the question panel, and
 * the recent-session list/modal.
 *
 * Keys are `panels.<surface>.<element>`; the shared actions (close, back,
 * …) live in `common.ts`.
 */
export const panels = {
  // --- shared panel actions -------------------------------------------------
  "panels.common.collapse": {
    ja: "パネルを折りたたむ",
    en: "Collapse panel",
  },

  // --- agent activity (turn timer) -----------------------------------------
  "panels.activity.working": {
    ja: "作業中（経過時間: {time}）",
    en: "Working (elapsed: {time})",
  },
  "panels.activity.completed": {
    ja: "作業完了（所要時間: {time}）",
    en: "Completed ({time})",
  },

  // --- context usage -------------------------------------------------------
  "panels.context.title": {
    ja: "コンテキスト消費量（トークン）",
    en: "Context usage (tokens)",
  },
  "panels.context.limit": { ja: "コンテキスト上限", en: "Context limit" },
  "panels.context.cacheRate": {
    ja: "プロンプトキャッシュ率",
    en: "Prompt cache hit rate",
  },
  "panels.context.usageRate": {
    ja: "コンテキスト使用率: {value}",
    en: "Context usage: {value}",
  },

  // --- goal ----------------------------------------------------------------
  "panels.goal.judging": {
    ja: "進捗を判定中…",
    en: "Judging progress…",
  },
  "panels.goal.stopTitle": {
    ja: "ゴール実行を中止する",
    en: "Stop goal execution",
  },
  "panels.goal.stop": { ja: "中止", en: "Stop" },

  // --- question (ask tool) -------------------------------------------------
  "panels.question.header": { ja: "質問", en: "Question" },
  "panels.question.placeholder": {
    ja: "選択肢にない回答はこちらに入力してください",
    en: "Type your answer here",
  },
  "panels.question.ariaLabel": {
    ja: "「{question}」への回答",
    en: 'Answer to "{question}"',
  },
  "panels.question.submitting": { ja: "送信中…", en: "Submitting…" },
  "panels.question.submit": { ja: "回答を送信", en: "Submit answer" },

  // --- recent sessions list / modal ----------------------------------------
  "panels.recent.empty": { ja: "履歴はありません", en: "No history" },
  "panels.recent.untitled": {
    ja: "無題のセッション",
    en: "Untitled session",
  },
  "panels.recent.openTab": {
    ja: "「{name}」を新しいタブで開く",
    en: 'Open "{name}" in a new tab',
  },

  // --- sessions modal ------------------------------------------------------
  "panels.sessions.title": {
    ja: "セッション履歴",
    en: "Session history",
  },

  // --- thinking level slider -----------------------------------------------
  "panels.thinking.ariaLabel": {
    ja: "推論強度（思考レベル）",
    en: "Thinking level",
  },
} satisfies Record<string, LocalizedText>;
