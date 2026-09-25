import type { LocalizedText } from "./types.ts";

/**
 * Messages of the chat surface: the chat view and its composer, the
 * new-session screen, the message rows, and the slash-command menu (its
 * agent-mode entries carry the mode's UI text — the prompts the modes send
 * are uniformly English and live in core/modes).
 *
 * Keys are `chat.<surface>.<element>`; the shared actions (close, back, …)
 * live in `common.ts`.
 */
export const chat = {
  // --- agent modes (menu text of core/modes) --------------------------------
  "chat.mode.review.label": { ja: "レビュー", en: "Review" },
  "chat.mode.review.description": {
    ja: "コード変更をレビューします",
    en: "Review code changes",
  },
  "chat.mode.review.modeLabel": { ja: "レビューモード", en: "Review mode" },
  "chat.mode.review.option.baseDiff.label": {
    ja: "ベースブランチとの差分",
    en: "Changes against the base branch",
  },
  "chat.mode.review.option.baseDiff.description": {
    ja: "現在のブランチと main などのベースブランチの差分をレビュー",
    en: "Review the diff against the base branch (main, …)",
  },
  "chat.mode.review.option.baseDiff.shortText": {
    ja: "ベースブランチとの差分をレビューしてください",
    en: "Review the changes against the base branch",
  },
  "chat.mode.review.option.uncommitted.label": {
    ja: "未コミットの変更",
    en: "Uncommitted changes",
  },
  "chat.mode.review.option.uncommitted.description": {
    ja: "まだコミットされていない変更をレビュー",
    en: "Review changes that are not committed yet",
  },
  "chat.mode.review.option.uncommitted.shortText": {
    ja: "未コミットの変更をレビューしてください",
    en: "Review the uncommitted changes",
  },
  "chat.mode.plan.label": { ja: "プラン", en: "Plan" },
  "chat.mode.plan.description": {
    ja:
      "作業計画を立案します（ユーザーの承認があるまでファイル編集は行いません）",
    en: "Draft a plan (no file edits until you approve)",
  },
  "chat.mode.plan.modeLabel": { ja: "プラン作成モード", en: "Plan mode" },
  "chat.mode.goal.label": { ja: "ゴール", en: "Goal" },
  "chat.mode.goal.description": {
    ja: "目標を設定し、達成するまでAIが自律的に作業を継続します",
    en: "Set a goal; the agent keeps working until it is reached",
  },
  "chat.mode.goal.modeLabel": { ja: "ゴールモード", en: "Goal mode" },

  // --- client-side slash commands ------------------------------------------
  "chat.slash.compact.label": { ja: "履歴を圧縮", en: "Compact history" },
  "chat.slash.compact.description": {
    ja: "古い履歴を要約します（続けて指示を書くと要約の観点を指定できます）",
    en: "Summarize older history (type a focus after it to steer the summary)",
  },
  "chat.slash.skill.label": { ja: "スキル", en: "Skills" },
  "chat.slash.skill.description": {
    ja: "このセッションで使えるスキルを呼び出します",
    en: "Invoke a skill available in this session",
  },
  "chat.slash.prompt.label": { ja: "保存済みプロンプト", en: "Saved prompts" },
  "chat.slash.prompt.description": {
    ja: "保存したプロンプトテンプレートを挿入",
    en: "Insert a saved prompt template",
  },

  // --- chat view -----------------------------------------------------------
  "chat.empty.workspace": {
    ja:
      "作業内容（タスク）を入力してください。ワークスペース内のファイル操作やコマンド実行をAIが自律して進めます。",
    en:
      "Enter a task. The AI will autonomously operate files and run commands in your workspace.",
  },
  "chat.empty.chat": {
    ja:
      "メッセージを入力してください。フォルダー連携を行わないシンプルなチャットです。",
    en: "Enter a message. This is a simple chat without folder collaboration.",
  },

  // --- composer ------------------------------------------------------------
  "chat.composer.placeholder": {
    ja: "指示・メッセージを入力してください…",
    en: "Type a message or instruction…",
  },
  "chat.composer.submit": { ja: "送信", en: "Send" },
  "chat.composer.image.remove": { ja: "添付画像を削除", en: "Remove image" },
  "chat.composer.mention.loading": { ja: "読み込み中…", en: "Loading…" },
  "chat.composer.mention.noMatch": {
    ja: "一致するファイルが見つかりません",
    en: "No matching files",
  },
  "chat.composer.slash.back": {
    ja: "コマンド一覧に戻る",
    en: "Back to commands",
  },
  "chat.composer.slash.empty": {
    ja: "該当するコマンドがありません",
    en: "No matching commands",
  },
  "chat.composer.remoteDefault": {
    ja: "接続先サーバーで設定されたデフォルトモデルを使用します",
    en: "Using the default model set on the connected server",
  },
  "chat.composer.modelSelect": { ja: "モデルを選択", en: "Select model" },
  "chat.composer.modelSwitchTitle": {
    ja: "モデル・推論強度の選択",
    en: "Select model and thinking level",
  },
  "chat.composer.providerUnconfigured": {
    ja:
      "プロバイダー「{provider}」が未設定のため送信できません。設定画面でAPIキーを登録するか、モデルを切り替えてください。",
    en:
      'This session\'s provider "{provider}" is not configured, so nothing can be sent. Register an API key in the settings, or switch to another model.',
  },
  "chat.composer.stop": { ja: "処理を停止", en: "Stop" },

  // --- new session ---------------------------------------------------------
  "chat.newSession.title": { ja: "新しいセッション", en: "New session" },
  "chat.newSession.workspace": { ja: "ワークスペース", en: "Workspace" },
  "chat.newSession.peer": { ja: "接続先サーバー", en: "Server" },
  "chat.newSession.defaultModelError": {
    ja: "デフォルトのモデルを取得できませんでした:",
    en: "Could not fetch the default model:",
  },
  "chat.newSession.noProvider": {
    ja:
      "プロバイダーが未設定のため、モデルを選べません。設定画面でAPIキーを登録してください。",
    en:
      "No provider is configured, so no model can be selected. Register an API key in the settings.",
  },
  "chat.newSession.placeholder": {
    ja: "依頼するタスクを入力してください…",
    en: "Enter a task to start…",
  },
  "chat.newSession.submitCreating": { ja: "作成中…", en: "Creating…" },
  "chat.newSession.submitStart": { ja: "開始", en: "Start" },
  "chat.newSession.recentTitle": {
    ja: "最近使ったセッション",
    en: "Recent sessions",
  },
  "chat.newSession.chatName": {
    ja: "通常チャット（ワークスペースなし）",
    en: "Chat (no workspace)",
  },

  // --- deliverables (the present tool, listed under the conversation) ------
  "chat.deliverables.title": { ja: "成果物", en: "Deliverables" },
  "chat.deliverables.copyPath": {
    ja: "パスをコピー: {path}",
    en: "Copy path: {path}",
  },
  "chat.deliverables.copied": { ja: "コピーしました", en: "Copied" },
  "chat.deliverables.kind.document": { ja: "ドキュメント", en: "Document" },
  "chat.deliverables.kind.spreadsheet": {
    ja: "表計算",
    en: "Spreadsheet",
  },
  "chat.deliverables.kind.presentation": {
    ja: "プレゼンテーション",
    en: "Presentation",
  },
  "chat.deliverables.kind.image": { ja: "画像", en: "Image" },
  "chat.deliverables.kind.code": { ja: "コード", en: "Code" },
  "chat.deliverables.kind.archive": { ja: "アーカイブ", en: "Archive" },
  "chat.deliverables.kind.audio": { ja: "音声", en: "Audio" },
  "chat.deliverables.kind.video": { ja: "動画", en: "Video" },

  // --- error banner --------------------------------------------------------
  "chat.error.copyTitle": {
    ja: "クリックしてエラー内容をコピー",
    en: "Click to copy error details",
  },
  "chat.error.copyAriaLabel": {
    ja: "エラーをクリップボードにコピー",
    en: "Copy error to clipboard",
  },

  // --- user message actions ------------------------------------------------
  "chat.message.rewind": { ja: "メッセージを巻き戻す", en: "Rewind message" },
  "chat.message.copy": {
    ja: "クリップボードにコピー",
    en: "Copy to clipboard",
  },
  "chat.message.copied": { ja: "コピーしました", en: "Copied" },

  // --- model picker (rendered inside Composer, translated here) ------------
  "chat.modelPicker.providerError": {
    ja: "プロバイダー一覧を取得できませんでした（サーバーに接続できません）",
    en: "Could not fetch the provider list (cannot reach the server)",
  },
  "chat.modelPicker.modelError": {
    ja: "モデル一覧を取得できませんでした",
    en: "Could not fetch the model list",
  },
  "chat.modelPicker.noProviders": {
    ja:
      "利用可能なプロバイダーが未設定です。設定画面でAPIキーを登録してください。",
    en: "No providers configured. Register an API key in the settings.",
  },
  "chat.modelPicker.settingsLink": { ja: "設定画面", en: "Settings" },
  "chat.modelPicker.searchPlaceholder": {
    ja: "モデルを検索…",
    en: "Search models…",
  },
  "chat.modelPicker.thinkingLabel": {
    ja: "推論強度（思考レベル）",
    en: "Thinking level",
  },
  "chat.modelPicker.thinkingModel": {
    ja: "推論モデル（Reasoning）",
    en: "Reasoning model",
  },
  "chat.modelPicker.emptyImage": {
    ja: "画像認識に対応したモデルがありません",
    en: "No image-capable models available",
  },
  "chat.modelPicker.emptyEnabled": {
    ja: "利用可能なモデルがありません（設定画面でモデルを有効化してください）",
    en: "No models available (enable models in the settings)",
  },
  "chat.modelPicker.empty": {
    ja: "条件に一致するモデルがありません",
    en: "No models match the current filter",
  },
} satisfies Record<string, LocalizedText>;
