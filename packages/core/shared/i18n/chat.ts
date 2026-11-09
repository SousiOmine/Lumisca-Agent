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
    ja: "現在のブランチと main などのベースブランチとの差分をレビュー",
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
    ja: "保存したプロンプトテンプレートを挿入します",
    en: "Insert a saved prompt template",
  },

  // --- chat view -----------------------------------------------------------
  "chat.empty.workspace": {
    ja:
      "作業内容（タスク）を入力してください。ワークスペース内のファイル操作やコマンド実行をAIが自律的に進めます。",
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
    ja: "メッセージを入力...",
    en: "Type a message...",
  },
  "chat.composer.submit": { ja: "送信", en: "Send" },
  /** The composer's own name: the placeholder disappears once the reader
   * types, so the field would otherwise have no label at all to announce. */
  "chat.composer.label": { ja: "メッセージ入力", en: "Message" },
  "chat.composer.image.remove": { ja: "添付画像を削除", en: "Remove image" },
  /** Attaching without a drag: the picker button, and the ways a pick can be
   * refused before anything is sent. */
  "chat.composer.attach.pick": {
    ja: "ファイルを添付",
    en: "Attach files",
  },
  /** Shown above the field once the text is close to the cap (the composer
   * stops accepting input at 0, so the count never goes negative). */
  "chat.composer.lengthLeft": {
    ja: "あと {count} 文字入力できます",
    en: "{count} characters left",
  },
  "chat.composer.attach.tooLarge": {
    ja: "「{name}」は大きすぎるため添付できません",
    en: '"{name}" is too large to attach',
  },
  "chat.composer.attach.readFailed": {
    ja: "「{name}」を読み取れませんでした",
    en: 'Could not read "{name}"',
  },
  /** A file that is not a picture, dropped in a mode with no machine to put
   * it in (code mode): the tools work on the user's own folders, so there is
   * nowhere for the bytes to go. */
  "chat.composer.attach.imageOnly": {
    ja: "「{name}」は添付できません。このモードで添付できるのは画像だけです",
    en:
      '"{name}" cannot be attached: only pictures can be attached in this mode',
  },
  "chat.composer.mention.noMatch": {
    ja: "一致するファイルが見つかりません",
    en: "No matching files",
  },
  /** The mention list could not be loaded at all: the reader must be able to
   * tell an unreachable server from a query that matched nothing. */
  "chat.composer.mention.failed": {
    ja: "ファイル一覧を取得できませんでした",
    en: "Could not load the file list",
  },
  "chat.composer.slash.back": {
    ja: "コマンド一覧に戻る",
    en: "Back to commands",
  },
  "chat.composer.slash.empty": {
    ja: "該当するコマンドがありません",
    en: "No matching commands",
  },
  "chat.composer.modelSelect": { ja: "モデルを選択", en: "Select model" },
  "chat.composer.modelSwitchTitle": {
    ja: "モデルを変更",
    en: "Change model",
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
  "chat.newSession.defaultModelError": {
    ja: "デフォルトのモデルを取得できませんでした:",
    en: "Could not fetch the default model:",
  },
  "chat.newSession.defaultModelSaveFailed": {
    ja: "選んだモデルを既定として保存できませんでした:",
    en: "Could not save the chosen model as the default:",
  },
  "chat.newSession.noProvider": {
    ja:
      "プロバイダーが未設定のため、モデルを選べません。設定画面でAPIキーを登録してください。",
    en:
      "No provider is configured, so no model can be selected. Register an API key in the settings.",
  },
  "chat.newSession.placeholder": {
    ja: "メッセージを入力...",
    en: "Type a message...",
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
    ja: "内容が <svg> 要素ではありません",
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

  // --- attachments (files the agent sends to the user) --------------------
  "chat.attach.download": { ja: "ダウンロード", en: "Download" },

  // --- mode selection and stella -------------------------------------------
  "chat.modeSelect.title": {
    ja: "モードを選択",
    en: "Select a mode",
  },
  "chat.modeSelect.code.title": { ja: "code mode", en: "code mode" },
  "chat.modeSelect.code.description": {
    ja: "マシンのファイルとシェルを使用して開発",
    en: "Develop with this machine's files and shell",
  },
  "chat.modeSelect.stella.title": { ja: "stella mode", en: "stella mode" },
  /** The title bar's label for a stella conversation. Not the mode's name:
   * what the window shows is the app, not which mode was picked — the mode is
   * already the only thing on screen, and "stella mode" in the corner names a
   * setting the reader chose once rather than the program they are in. */
  "chat.stella.titleBarLabel": {
    ja: "Lumisca Agent",
    en: "Lumisca Agent",
  },
  "chat.modeSelect.stella.description": {
    ja: "シームレスな開発体験",
    en: "A seamless development experience",
  },
  "chat.modeSelect.stella.unavailable": {
    ja: "この環境では利用できません: {reason}",
    en: "Not available on this machine: {reason}",
  },
  "chat.modeSelect.choose": { ja: "このモードを選択", en: "Use this" },
  "chat.modeSelect.current": { ja: "使用中", en: "In use" },

  "chat.stella.empty": {
    ja: "依頼を入力してください。エージェントは仮想マシンの中で作業します。",
    en: "Enter a request. The agent works inside its virtual machine.",
  },
  "chat.stella.noAgent": {
    ja: "左の一覧からエージェントを選んでください",
    en: "Pick an agent on the left",
  },
  /** The conversation is open and empty (a fresh agent, or one whose earlier
   * messages were all removed). Without this the pane is blank, which reads
   * as a broken view rather than as "nothing has been said yet". */
  "chat.stella.transcript.empty": {
    ja: "まだメッセージがありません",
    en: "No messages yet",
  },
  /** Shown while the conversation is being opened (the server is making sure
   * the machine is up). Without it the pane is empty for as long as that
   * takes, which on a phone over a slow link reads as "nothing happened". */
  "chat.stella.loading": {
    ja: "読み込んでいます…",
    en: "Loading…",
  },
  "chat.stella.machine.starting": {
    ja: "初回セットアップを行っています（数分かかります）…",
    en: "Preparing the machine for the first time (this takes a few minutes)…",
  },
  "chat.stella.agents.title": { ja: "エージェント", en: "Agents" },
  /** The conversation header's back button on a phone, where the list and
   * the conversation are two screens rather than two columns. */
  "chat.stella.backToList": {
    ja: "エージェント一覧に戻る",
    en: "Back to the agents",
  },
  /** An address named stella mode on a server whose machine cannot run. The
   * mode is refused rather than shown degraded (see App.tsx): the sentence
   * explains why the reader landed on code mode instead. */
  "chat.stella.refused": {
    ja: "stella モードはこのサーバーで使えません: {reason}",
    en: "stella mode cannot run on this server: {reason}",
  },
  "chat.stella.agents.new": { ja: "新しいエージェント", en: "New agent" },
  "chat.stella.agents.name": { ja: "名前", en: "Name" },
  /** Both fields are optional, and the form has to say so: a field that looks
   * required next to a disabled button is the wall this removed. */
  "chat.stella.agents.nameHint": {
    ja: "空のままにすると自動で付けます",
    en: "Leave it empty and one is picked for you",
  },
  "chat.stella.agents.role": { ja: "役割", en: "Role" },
  "chat.stella.agents.roleHint": {
    ja: "このエージェントの役割や振る舞い（任意）",
    en: "What this agent does and how it works (optional)",
  },
  "chat.stella.agents.create": { ja: "作成", en: "Create" },
  "chat.stella.agents.creating": { ja: "作成中…", en: "Creating…" },
  /** The row's menu (the ⋮ on an agent), and the dialog it opens. What can be
   * changed is what the user chose: the label, the picture and the model. The
   * role is fixed at creation (it is the agent's working instruction), so
   * this dialog deliberately has no field for it. */
  "chat.stella.agents.menu": {
    ja: "{name} のメニュー",
    en: "Menu for {name}",
  },
  "chat.stella.agents.edit": {
    ja: "名前・アイコン・モデルを編集",
    en: "Edit name, icon and model",
  },
  "chat.stella.agents.editTitle": {
    ja: "「{name}」を編集",
    en: 'Edit "{name}"',
  },
  "chat.stella.agents.icon": { ja: "アイコン", en: "Icon" },
  "chat.stella.agents.iconHint": {
    ja: "エージェントのアイコンを設定",
    en: "Set this agent's icon",
  },
  "chat.stella.agents.iconChoose": {
    ja: "画像を選択",
    en: "Choose a picture",
  },
  "chat.stella.agents.iconReset": {
    ja: "デフォルトに戻す",
    en: "Back to the initial",
  },
  /** The model the agent's conversation runs on. It is the AGENT's choice
   * (not one made per message), and leaving it unset follows the app's
   * default model — the model settings page. */
  "chat.stella.agents.model": { ja: "モデル", en: "Model" },
  "chat.stella.agents.modelDefault": {
    ja: "既定のモデル",
    en: "Default model",
  },
  "chat.stella.agents.modelUseDefault": {
    ja: "既定に戻す",
    en: "Use the default",
  },
  "chat.stella.agents.modelHint": {
    ja:
      "このエージェントの会話が使うモデルです。未設定なら既定のモデルを使います。",
    en:
      "The model this agent's conversation runs on. Unset means the app's default model.",
  },
  "chat.stella.agents.deleteTitle": {
    ja: "「{name}」を削除しますか？",
    en: 'Delete "{name}"?',
  },
  "chat.stella.agents.deleteBody": {
    ja:
      "このエージェントとの会話履歴もすべて削除されます。この操作は取り消せません。",
    en: "Its whole conversation is deleted too. This cannot be undone.",
  },
  "chat.stella.agents.empty": {
    ja:
      "登録されているエージェントがありません。「新しいエージェント」から作成してください。",
    en: "No agent yet. Create one.",
  },
  /** The starter agent the server creates on a fresh installation, so the
   * sidebar is never empty (LumiscaCore.ensureStellaAgent). The role is the
   * instruction the agent works from, so it stays a plain sentence about the
   * machine it lives in. */
  "chat.stella.agents.starterName": { ja: "アシスタント", en: "Assistant" },
  "chat.stella.agents.starterRole": {
    ja:
      "仮想マシンの中で作業する開発アシスタント。依頼に応じて調査、実装、検証を行い、結果を短く報告します。",
    en:
      "A development assistant that works inside the machine: investigate, implement and verify what it is asked to do, and report the result briefly.",
  },
  "chat.stella.conversationError": {
    ja: "会話を開けませんでした: {error}",
    en: "Could not open the conversation: {error}",
  },
  "chat.stella.placeholder": {
    ja: "メッセージを入力...",
    en: "Type a message...",
  },
  /** A file a prompt brought into the machine that the machine no longer
   * has (the agent moved or deleted it): the conversation says so rather
   * than showing a copy that exists nowhere else. */
  "chat.stella.fileGone": {
    ja: "このファイルはマシンから削除されました",
    en: "This file was deleted from the machine",
  },
  "chat.stella.working": { ja: "作業中…", en: "Working…" },
  /** The second line of an agent's row: what the conversation last said.
   * Words are shown as they are; a message that carried no words is
   * described, because "3 files" is a caption rather than something the user
   * wrote. */
  "chat.stella.agents.preview.files": {
    ja: "ファイル {count} 件",
    en: "{count} files",
  },
  "chat.stella.agents.preview.card": { ja: "カード", en: "Card" },
  "chat.stella.agents.preview.routine": {
    ja: "ルーチン「{name}」",
    en: 'Routine "{name}"',
  },
  "chat.stella.machine.screen": { ja: "画面", en: "Screen" },
  /** Filling the window with the machine's screen: the picture is small in a
   * column, and looking at something in it means seeing more than a thumbnail
   * shows. */
  "chat.stella.machine.fullscreen": {
    ja: "全画面で表示",
    en: "Show full screen",
  },
  "chat.stella.machine.exitFullscreen": {
    ja: "全画面を終了",
    en: "Exit full screen",
  },
  /** The header's show/hide control of the screen pane: the pane is a panel
   * the user opens and closes, so the label says which way the next click
   * goes. */
  "chat.stella.machine.showScreen": {
    ja: "画面を表示",
    en: "Show the screen",
  },
  "chat.stella.machine.hideScreen": {
    ja: "画面を隠す",
    en: "Hide the screen",
  },
  "chat.stella.machine.screenEmpty": {
    ja: "マシンが起動すると、ここに画面が表示されます。",
    en: "The machine's screen appears here once it runs.",
  },
  "chat.stella.machine.screenConnecting": {
    ja: "画面に接続しています…",
    en: "Connecting to the screen…",
  },
  "chat.stella.handover.reason": {
    ja: "エージェントから画面操作が引き継がれました",
    en: "The agent is handing the screen to you",
  },
  "chat.stella.handover.notePlaceholder": {
    ja: "操作内容（任意）",
    en: "What you did (optional)",
  },
  "chat.stella.handover.done": { ja: "完了", en: "Done" },
  "chat.stella.handover.finishing": { ja: "送信中…", en: "Sending…" },
  /** When the wait ends by itself: the agent resumes without the user, so
   * saying when keeps a late return from looking like a lost run. */
  "chat.stella.handover.deadline": {
    ja: "この待機は {time} までです（過ぎるとエージェントは自動で再開します）",
    en: "This wait ends at {time} (the agent resumes on its own)",
  },
  "chat.composer.image.alt": { ja: "添付画像", en: "Attachment" },
  "chat.stella.machine.screenFailed": {
    ja: "画面に接続できませんでした: {reason}",
    en: "Could not connect to the screen: {reason}",
  },

  // --- history window ------------------------------------------------------
  "chat.history.loadingOlder": {
    ja: "以前の履歴を読み込んでいます…",
    en: "Loading earlier history…",
  },

  // --- message actions -----------------------------------------------------
  /** The icon-only buttons under a message. Both are given a name: a screen
   * reader would otherwise read two anonymous "button"s. */
  "chat.message.rewind": { ja: "入力欄に戻す", en: "Restore to composer" },
  "chat.message.copy": { ja: "コピー", en: "Copy" },
  "chat.message.copied": { ja: "コピーしました", en: "Copied" },
  /** A list that failed to load, said where it was needed: the empty state
   * of the same list would otherwise be indistinguishable from an outage. */
  "chat.skills.unavailable": {
    ja: "スキル一覧を読み込めませんでした",
    en: "Could not load the skills",
  },
  "chat.prompts.unavailable": {
    ja: "保存済みプロンプトを読み込めませんでした",
    en: "Could not load the saved prompts",
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
