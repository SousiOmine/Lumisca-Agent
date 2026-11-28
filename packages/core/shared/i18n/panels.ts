import type { LocalizedText } from "./types.ts";

/**
 * Messages of the side panels and session lists: the progress panels (todo,
 * tasks, background commands, context usage), the question panel, and
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
  "panels.todo.status.pending": { ja: "未着手", en: "Pending" },
  "panels.todo.status.in_progress": { ja: "進行中", en: "In progress" },
  "panels.todo.status.completed": { ja: "完了", en: "Done" },
  "panels.todo.status.abandoned": { ja: "取りやめ", en: "Abandoned" },
  "panels.todo.status.blocked": { ja: "保留", en: "Blocked" },
  "panels.task.title": { ja: "タスク", en: "Tasks" },
  "panels.background.title": {
    ja: "バックグラウンド",
    en: "Background",
  },

  // --- agent activity (turn timer) -----------------------------------------
  "panels.activity.thinking": {
    ja: "考え中…",
    en: "Thinking…",
  },
  "panels.activity.working": {
    ja: "作業中（経過時間: {time}）",
    en: "Working (elapsed: {time})",
  },
  "panels.activity.completed": {
    ja: "作業完了",
    en: "Completed",
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

  // --- question (ask tool) -------------------------------------------------
  // --- routines (scheduled requests) ----------------------------------------
  "panels.routine.empty": {
    ja: "登録されたルーチンはありません。「毎朝8時にデプロイを確認して」のようにエージェントに依頼すると作成できます。",
    en: 'None yet. Ask the agent for one ("check the deploy every morning at 8").',
  },
  "panels.routine.schedule.daily": {
    ja: "毎日{time}",
    en: "Every day at {time}",
  },
  "panels.routine.schedule.weekly": {
    ja: "毎週{days} {time}",
    en: "Every week on {days} at {time}",
  },
  "panels.routine.schedule.every": {
    ja: "{minutes}分ごと",
    en: "Every {minutes} minutes",
  },
  "panels.routine.schedule.once": {
    ja: "{at}に1回",
    en: "Once at {at}",
  },
  "panels.routine.schedule.watch": {
    ja: "{minutes}分ごとに確認し、{what}が変わったら実行",
    en: "Check every {minutes} minutes, run when {what} changes",
  },
  "panels.routine.watch.http": {
    ja: "{url}（{condition}）",
    en: "{url} ({condition})",
  },
  "panels.routine.watch.file": {
    ja: "{path}（{condition}）",
    en: "{path} ({condition})",
  },
  "panels.routine.watch.command": {
    ja: "{command}（{condition}）",
    en: "{command} ({condition})",
  },
  "panels.routine.watch.mcp": {
    ja: "{server}の{tool}（{condition}）",
    en: "{server}: {tool} ({condition})",
  },
  "panels.routine.watch.newItem": {
    ja: "新しい項目",
    en: "a new item",
  },
  "panels.routine.watch.valueChanged": {
    ja: "値の変化",
    en: "a value change",
  },
  "panels.routine.watch.status": {
    ja: "状態コード{status}",
    en: "status {status}",
  },
  "panels.routine.watch.bodyChanged": { ja: "本文", en: "the body" },
  "panels.routine.watch.modified": { ja: "更新時刻", en: "the timestamp" },
  "panels.routine.watch.content": { ja: "内容", en: "the content" },
  "panels.routine.watch.exit": { ja: "終了コード{code}", en: "exit {code}" },
  "panels.routine.watch.contains": {
    ja: "{text}を含むこと",
    en: "it contains {text}",
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
  "panels.routine.status.skipped": { ja: "見送り", en: "skipped" },
  "panels.routine.disabled": { ja: "停止中", en: "Disabled" },
  "panels.routine.queued": { ja: "待機中", en: "Waiting" },
  "panels.routine.next": { ja: "次回{when}", en: "next {when}" },
  "panels.routine.last": {
    ja: "前回{when} {status}",
    en: "last {when} {status}",
  },
  "panels.routine.checked": {
    ja: "確認{when}",
    en: "checked {when}",
  },
  "panels.routine.checkFailed": {
    ja: "確認{when}に失敗",
    en: "check failed at {when}",
  },
  "panels.routine.run": { ja: "今すぐ実行", en: "Run now" },
  "panels.routine.stop": { ja: "停止", en: "Stop" },
  "panels.routine.enable": { ja: "有効化", en: "Enable" },
  "panels.routine.disable": { ja: "無効化", en: "Disable" },
  /** Shown above the list when the AGENT is switched off: its routines are
   * readable and editable, but nothing fires until it is back on. */
  "panels.routine.agentDisabled": {
    ja: "このエージェントは無効化されているため、ルーチンは実行されません。",
    en: "This agent is disabled, so its routines do not run.",
  },

  // --- UI cards (the `ui` fence's JSON) --------------------------------------
  "panels.ui.invalidApp": {
    ja: "このUIを表示できませんでした",
    en: "This UI could not be displayed",
  },
  "panels.ui.spec": { ja: "仕様", en: "JSON" },
  "panels.ui.buildingApp": {
    ja: "UIを組み立てています…",
    en: "Building UI…",
  },
  "panels.ui.flow": { ja: "フローチャート", en: "Flowchart" },

  "panels.question.header": { ja: "質問", en: "Question" },
  "panels.question.placeholder": {
    ja: "自由回答を入力",
    en: "Enter another answer",
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

  // --- tool rows -----------------------------------------------------------
  // The one-line summary a tool call shows in the transcript. The wording is
  // the app's, not the model's: a row the user reads should follow the app
  // language like every other label.
  "panels.tool.name.read": { ja: "ファイル読み込み", en: "Read file" },
  "panels.tool.name.write": { ja: "ファイル作成", en: "Write file" },
  "panels.tool.name.edit": { ja: "ファイル編集", en: "Edit file" },
  "panels.tool.name.listDir": { ja: "フォルダー一覧", en: "List folder" },
  "panels.tool.name.chatAttach": { ja: "ファイル添付", en: "Attach files" },
  "panels.tool.name.visual": { ja: "画像表示", en: "Show image" },
  "panels.tool.name.pdfReadPages": { ja: "PDF読み込み", en: "Read PDF" },
  "panels.tool.name.bash": { ja: "コマンド実行", en: "Run command" },
  "panels.tool.name.asyncBash": {
    ja: "バックグラウンド実行",
    en: "Run in background",
  },
  "panels.tool.name.asyncBashStatus": {
    ja: "実行状況を確認",
    en: "Check background process",
  },
  "panels.tool.name.asyncBashKill": {
    ja: "プロセス停止",
    en: "Stop process",
  },
  "panels.tool.name.eval": { ja: "コード実行", en: "Run code" },
  "panels.tool.name.execute": { ja: "コード実行", en: "Run code" },
  "panels.tool.name.webSearch": { ja: "Web検索", en: "Web search" },
  "panels.tool.name.webFetch": { ja: "Webページ取得", en: "Fetch web page" },
  "panels.tool.name.browserOpen": { ja: "ブラウザで開く", en: "Open page" },
  "panels.tool.name.browserObserve": {
    ja: "ページ内容を確認",
    en: "Inspect page",
  },
  "panels.tool.name.browserAct": { ja: "ブラウザ操作", en: "Browser action" },
  "panels.tool.name.browserWait": { ja: "ページ待機", en: "Wait for page" },
  "panels.tool.name.browserScreenshot": {
    ja: "ブラウザ画面を取得",
    en: "Capture browser",
  },
  "panels.tool.name.browserClose": {
    ja: "ブラウザを閉じる",
    en: "Close browser",
  },
  "panels.tool.name.computerScreenshot": {
    ja: "画面を取得",
    en: "Capture screen",
  },
  "panels.tool.name.computerAct": { ja: "画面操作", en: "Screen action" },
  "panels.tool.name.computerListWindows": {
    ja: "ウィンドウ一覧",
    en: "List windows",
  },
  "panels.tool.name.vmAskUser": {
    ja: "ユーザーに確認",
    en: "Request user action",
  },
  "panels.tool.name.ask": { ja: "質問", en: "Ask question" },
  "panels.tool.name.todo": { ja: "進捗を更新", en: "Update plan" },
  "panels.tool.name.sendChat": { ja: "メッセージを送信", en: "Send message" },
  "panels.tool.name.skill": { ja: "スキルを読み込み", en: "Load skill" },
  "panels.tool.name.historySearch": {
    ja: "履歴を検索",
    en: "Search history",
  },
  "panels.tool.name.identity": { ja: "メモを更新", en: "Update memory" },
  "panels.tool.name.task": { ja: "サブタスク実行", en: "Run task" },
  "panels.tool.name.taskOutput": {
    ja: "サブタスク結果を取得",
    en: "Read task output",
  },
  "panels.tool.name.sendMessage": {
    ja: "エージェントへ送信",
    en: "Message agent",
  },
  "panels.tool.name.agentCreate": {
    ja: "エージェント作成",
    en: "Create agent",
  },
  "panels.tool.name.routineCreate": {
    ja: "ルーチン作成",
    en: "Create routine",
  },
  "panels.tool.name.routineList": { ja: "ルーチン一覧", en: "List routines" },
  "panels.tool.name.routineUpdate": {
    ja: "ルーチン更新",
    en: "Update routine",
  },
  "panels.tool.name.routineDelete": {
    ja: "ルーチン削除",
    en: "Delete routine",
  },
  "panels.tool.name.routineRun": { ja: "ルーチン実行", en: "Run routine" },
  "panels.tool.name.search": { ja: "ツール検索", en: "Search tools" },
  "panels.tool.name.call": { ja: "外部ツール実行", en: "Call tool" },
  "panels.tool.askQuestions": {
    ja: "{count}件の質問",
    en: "{count} questions",
  },
  "panels.tool.askOneQuestion": { ja: "1件の質問", en: "1 question" },
  "panels.tool.taskWaitSuffix": { ja: "（待機）", en: " (wait)" },
  "panels.tool.sendTo": { ja: "{to}へ: {summary}", en: "to {to}: {summary}" },
  "panels.tool.backgroundList": { ja: "一覧", en: "list" },
} satisfies Record<string, LocalizedText>;
