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

  // --- visuals (diagrams and images the agent puts in its reply) ----------
  "chat.visual.error.title": {
    ja: "図を表示できません",
    en: "Diagram not shown",
  },
  "chat.visual.error.root": {
    ja: "中身が <svg> 要素ではありません",
    en: "Its content is not an <svg> element",
  },
  "chat.visual.error.script": {
    ja: "スクリプトを含む図は表示できません",
    en: "Diagrams may not contain scripts",
  },
  "chat.visual.error.size": {
    ja: "図が大きすぎます（上限 {limit}）",
    en: "Diagram is too large (limit {limit})",
  },
  "chat.visual.error.source": { ja: "ソースを表示", en: "Show source" },

  // --- mode selection and stella -------------------------------------------
  "chat.modeSelect.title": {
    ja: "モードを選択",
    en: "Select a mode",
  },
  "chat.modeSelect.code.title": { ja: "code mode", en: "code mode" },
  "chat.modeSelect.code.description": {
    ja:
      "ワークスペースのコードを読んで直すエージェント。セッションをタブで並べて管理し、このマシンのファイルとシェルをそのまま使います。",
    en:
      "A coding agent for your workspaces. Sessions live in tabs, and it uses this machine's files and shell directly.",
  },
  "chat.modeSelect.stella.title": { ja: "stella mode", en: "stella mode" },
  "chat.modeSelect.stella.description": {
    ja: "シームレスな開発体験",
    en: "A seamless development experience",
  },
  "chat.modeSelect.stella.unavailable": {
    ja: "この環境では使えません: {reason}",
    en: "Not available on this machine: {reason}",
  },
  "chat.modeSelect.choose": { ja: "これにする", en: "Use this" },
  "chat.modeSelect.current": { ja: "使用中", en: "In use" },

  "chat.stella.empty": {
    ja: "依頼を入力してください。エージェントは仮想マシンの中で作業します。",
    en: "Enter a request. The agent works inside its virtual machine.",
  },
  "chat.stella.noAgent": {
    ja: "左の一覧からエージェントを選んでください",
    en: "Pick an agent on the left",
  },
  "chat.stella.machine.starting": {
    ja: "はじめての準備をしています（数分かかります）…",
    en: "Preparing the machine for the first time (this takes a few minutes)…",
  },
  "chat.stella.agents.title": { ja: "エージェント", en: "Agents" },
  "chat.stella.agents.new": { ja: "新しいエージェント", en: "New agent" },
  "chat.stella.agents.name": { ja: "名前", en: "Name" },
  "chat.stella.agents.role": { ja: "役割", en: "Role" },
  "chat.stella.agents.roleHint": {
    ja: "このエージェントが何をするか、どう振る舞うか",
    en: "What this agent does and how it works",
  },
  "chat.stella.agents.create": { ja: "作成", en: "Create" },
  "chat.stella.agents.creating": { ja: "作成中…", en: "Creating…" },
  "chat.stella.agents.delete": {
    ja: "このエージェントを削除",
    en: "Delete this agent",
  },
  "chat.stella.agents.deleteTitle": {
    ja: "「{name}」を削除しますか？",
    en: 'Delete "{name}"?',
  },
  "chat.stella.agents.deleteBody": {
    ja: "このエージェントとの会話の履歴もすべて消えます。元に戻せません。",
    en: "Its whole conversation is deleted too. This cannot be undone.",
  },
  "chat.stella.agents.empty": {
    ja: "まだエージェントがいません。作成してください。",
    en: "No agent yet. Create one.",
  },
  "chat.stella.conversationError": {
    ja: "会話を開けませんでした: {error}",
    en: "Could not open the conversation: {error}",
  },
  "chat.stella.placeholder": {
    ja: "依頼を入力してください…",
    en: "Enter a request…",
  },
  "chat.stella.machine.screen": { ja: "画面", en: "Screen" },
  "chat.stella.machine.screenEmpty": {
    ja: "マシンが起動すると、ここに画面が表示されます。",
    en: "The machine's screen appears here once it runs.",
  },
  "chat.stella.machine.screenConnecting": {
    ja: "画面に接続しています…",
    en: "Connecting to the screen…",
  },
  "chat.stella.handover.reason": {
    ja: "エージェントが画面を任せようとしています",
    en: "The agent is handing the screen to you",
  },
  "chat.stella.handover.notePlaceholder": {
    ja: "何をしたか（任意）",
    en: "What you did (optional)",
  },
  "chat.stella.handover.done": { ja: "完了", en: "Done" },
  "chat.stella.handover.finishing": { ja: "送信中…", en: "Sending…" },
  "chat.stella.machine.screenFailed": {
    ja: "画面に接続できませんでした: {reason}",
    en: "Could not connect to the screen: {reason}",
  },

  // --- error banner --------------------------------------------------------
  "chat.error.copyTitle": {
    ja: "クリックしてエラー内容をコピー",
    en: "Click to copy error details",
  },
  "chat.error.copyAriaLabel": {
    ja: "エラーをクリップボードにコピー",
    en: "Copy error to clipboard",
  },
} satisfies Record<string, LocalizedText>;
