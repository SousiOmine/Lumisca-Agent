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

  // --- panel headings -------------------------------------------------------
  "panels.todo.title": { ja: "進捗", en: "Progress" },
  "panels.task.title": { ja: "タスク", en: "Tasks" },
  "panels.goal.title": { ja: "ゴール", en: "Goal" },
  "panels.background.title": {
    ja: "バックグラウンド",
    en: "Background",
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
  // --- routines (scheduled requests) ----------------------------------------
  "panels.routine.title": { ja: "ルーチン", en: "Routines" },
  "panels.routine.description": {
    ja:
      "{agent} の会話で、決めた時刻に依頼を実行します。作成と変更は会話からエージェントに頼んでください。",
    en:
      "Requests {agent}'s conversation runs on a schedule. Ask the agent in the conversation to create or change one.",
  },
  "panels.routine.noAgent": {
    ja: "相手を選ぶと、その会話のルーチンが表示されます。",
    en: "Pick a counterpart to see the routines of its conversation.",
  },
  "panels.routine.empty": {
    ja:
      "まだありません。「毎朝 8 時にデプロイを確認して」のようにエージェントへ頼むと作成できます。",
    en:
      'None yet. Ask the agent for one ("check the deploy every morning at 8").',
  },
  "panels.routine.schedule.daily": {
    ja: "毎日 {time}",
    en: "Every day at {time}",
  },
  "panels.routine.schedule.weekly": {
    ja: "毎週 {days} {time}",
    en: "Every week on {days} at {time}",
  },
  "panels.routine.schedule.every": {
    ja: "{minutes} 分ごと",
    en: "Every {minutes} minutes",
  },
  "panels.routine.weekday.1": { ja: "月", en: "Mon" },
  "panels.routine.weekday.2": { ja: "火", en: "Tue" },
  "panels.routine.weekday.3": { ja: "水", en: "Wed" },
  "panels.routine.weekday.4": { ja: "木", en: "Thu" },
  "panels.routine.weekday.5": { ja: "金", en: "Fri" },
  "panels.routine.weekday.6": { ja: "土", en: "Sat" },
  "panels.routine.weekday.7": { ja: "日", en: "Sun" },
  "panels.routine.status.ok": { ja: "成功", en: "succeeded" },
  "panels.routine.status.error": { ja: "失敗", en: "failed" },
  "panels.routine.status.stopped": { ja: "停止", en: "stopped" },
  "panels.routine.status.running": { ja: "実行中", en: "Running" },
  "panels.routine.disabled": { ja: "停止中", en: "Disabled" },
  "panels.routine.next": { ja: "次回 {when}", en: "next {when}" },
  "panels.routine.last": {
    ja: "前回 {when} {status}",
    en: "last {when} {status}",
  },
  "panels.routine.run": { ja: "今すぐ実行", en: "Run now" },
  "panels.routine.stop": { ja: "停止", en: "Stop" },
  "panels.routine.enable": { ja: "有効にする", en: "Enable" },
  "panels.routine.disable": { ja: "無効にする", en: "Disable" },

  // --- UI cards (the chat_ui tool) ------------------------------------------
  "panels.ui.invalid": {
    ja: "このカードを表示できませんでした",
    en: "This card could not be displayed",
  },
  "panels.ui.submit": { ja: "送信", en: "Send" },
  "panels.ui.multiple": { ja: "複数選べます", en: "Select any number" },
  "panels.ui.flow": { ja: "フローチャート", en: "Flowchart" },
  "panels.ui.yes": { ja: "はい", en: "Yes" },
  "panels.ui.no": { ja: "いいえ", en: "No" },

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
