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
    ja: "現在のブランチとmainなどのベースブランチとの差分をレビュー",
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
    ja: "作業計画を立案します。承認するまでファイル編集は行いません。",
    en: "Draft a plan. No file edits until you approve.",
  },
  "chat.mode.plan.modeLabel": { ja: "プラン作成モード", en: "Plan mode" },

  // --- client-side slash commands ------------------------------------------
  "chat.slash.compact.label": { ja: "履歴を圧縮", en: "Compact history" },
  "chat.slash.compact.description": {
    ja: "古い履歴を要約します。続けて指示を書くと、要約の観点を指定できます。",
    en: "Summarize older history. Type a focus after it to steer the summary.",
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

  // --- composer ------------------------------------------------------------
  "chat.composer.placeholder": {
    ja: "メッセージを入力…",
    en: "Type a message…",
  },
  "chat.composer.submit": { ja: "送信", en: "Send" },
  /** The composer's own name: the placeholder disappears once the reader
   * types, so the field would otherwise have no label at all to announce. */
  "chat.composer.label": { ja: "メッセージ入力", en: "Message" },
  "chat.composer.image.remove": { ja: "添付画像を削除", en: "Remove image" },
  /** The plus button's menu (the only way to attach without a drag), and the
   * ways a pick can be refused before anything is sent. A row is named for
   * what it will actually accept: a mode with no machine to put a file in
   * takes pictures only. */
  "chat.composer.attach.open": {
    ja: "添付メニューを開く",
    en: "Open the attach menu",
  },
  "chat.composer.attach.files": {
    ja: "ファイルを添付",
    en: "Attach files",
  },
  "chat.composer.attach.image": {
    ja: "画像を添付",
    en: "Attach images",
  },
  "chat.composer.insert.command": {
    ja: "コマンド",
    en: "Command",
  },
  "chat.composer.insert.file": {
    ja: "ファイルを指定",
    en: "Mention a file",
  },
  /** Shown above the field once the text is close to the cap (the composer
   * stops accepting input at 0, so the count never goes negative). */
  "chat.composer.lengthLeft": {
    ja: "あと{count}文字入力できます",
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
  "chat.composer.attach.tooManyImages": {
    ja: "画像は{count}枚まで添付できます",
    en: "You can attach up to {count} pictures",
  },
  "chat.composer.attach.tooManyFiles": {
    ja: "ファイルは{count}件まで添付できます",
    en: "You can attach up to {count} files",
  },
  /** A file that is not a picture, dropped in a mode with no machine to put
   * it in (code mode): the tools work on the user's own folders, so there is
   * nowhere for the bytes to go. */
  "chat.composer.attach.imageOnly": {
    ja: "「{name}」は添付できません。このモードで添付できるのは画像だけです。",
    en: '"{name}" cannot be attached: only pictures can be attached in this mode',
  },
  /** A file is moving through the upload queue. The chip shows the percent;
   * these two name the phases the percentage does not cover. */
  "chat.composer.attach.copying": {
    ja: "準備中",
    en: "Preparing",
  },
  "chat.composer.attach.failed": {
    ja: "失敗",
    en: "Failed",
  },
  /** The transfer finished but the machine could not keep the file. The
   * server's own reason travels as the detail. */
  "chat.composer.attach.copyFailed": {
    ja: "ファイルを機械に保存できませんでした",
    en: "Could not store the file in the machine",
  },
  /** The composer was closed, or another conversation was opened, while a
   * transfer was still running. Nothing resumes it, so the chip says so. */
  "chat.composer.attach.interrupted": {
    ja: "アップロードが中断されました。添付し直してください。",
    en: "The upload was interrupted. Attach the file again.",
  },
  /** The composer was given a file but no way to transfer it: a wiring bug,
   * said as a refusal rather than a chip that never moves. */
  "chat.composer.attach.uploadUnavailable": {
    ja: "この画面ではファイルを送信できません",
    en: "This screen cannot send files",
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
    ja: "プロバイダー「{provider}」が未設定のため送信できません。設定画面でAPIキーを登録するか、モデルを切り替えてください。",
    en: 'This session\'s provider "{provider}" is not configured, so nothing can be sent. Register an API key in the settings, or switch to another model.',
  },
  "chat.composer.stop": { ja: "処理を停止", en: "Stop" },

  // --- new session ---------------------------------------------------------
  "chat.newSession.title": { ja: "新しいセッション", en: "New session" },
  "chat.newSession.workspace": { ja: "ワークスペース", en: "Workspace" },
  "chat.newSession.defaultModelError": {
    ja: "既定のモデルを取得できませんでした:",
    en: "Could not fetch the default model:",
  },
  "chat.newSession.defaultModelSaveFailed": {
    ja: "選んだモデルを既定として保存できませんでした:",
    en: "Could not save the chosen model as the default:",
  },
  "chat.newSession.noProvider": {
    ja: "プロバイダーが未設定のため、モデルを選べません。設定画面でAPIキーを登録してください。",
    en: "No provider is configured, so no model can be selected. Register an API key in the settings.",
  },
  "chat.newSession.placeholder": {
    ja: "メッセージを入力…",
    en: "Type a message…",
  },
  "chat.newSession.submitCreating": { ja: "作成中…", en: "Creating…" },
  "chat.newSession.submitStart": { ja: "開始", en: "Start" },
  "chat.newSession.recentTitle": {
    ja: "最近使ったセッション",
    en: "Recent sessions",
  },
  "chat.newSession.chatName": {
    ja: "ワークスペースなしのチャット",
    en: "Chat without a workspace",
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
    ja: "図が大きすぎます。上限は{limit}です。",
    en: "Diagram is too large. The limit is {limit}.",
  },
  "chat.visual.error.source": { ja: "ソースを表示", en: "Show source" },

  // --- attachments (files the agent sends to the user) --------------------
  "chat.attach.download": { ja: "ダウンロード", en: "Download" },
  /** The card's own check failed before the browser could save anything.
   * "Gone" is a different sentence (chat.stella.fileGone): this one says the
   * attempt did not reach the file, so the card stays and can be tried
   * again. */
  "chat.attach.downloadFailed": {
    ja: "ダウンロードできませんでした",
    en: "Could not download",
  },
  /** A file an agent handed over is no longer in the session's store. The
   * prompt files' own sentence is different because those live in the
   * machine (chat.stella.fileGone). */
  "chat.attach.gone": {
    ja: "このファイルはもうありません",
    en: "This file is no longer available",
  },
  /** A code-mode prompt's picture is carried by the message itself, so a
   * failed decode is a broken image, not a deleted file. */
  "chat.attach.imageFailed": {
    ja: "この画像は表示できません",
    en: "This image cannot be displayed",
  },

  // --- the modes' names ---------------------------------------------------
  // The reader meets the modes by their product names, not by the names this
  // code uses. stella stays the internal name of the main mode (URLs, files,
  // types); the screen calls it Lumisca, and code mode Lumisca code. These
  // two entries are the only place the names are written: the app menu's
  // "switch to" entry and the settings nav both read them.
  "chat.modeSelect.code.title": { ja: "Lumisca code", en: "Lumisca code" },
  "chat.modeSelect.stella.title": { ja: "Lumisca", en: "Lumisca" },

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
    ja: "初回セットアップを行っています。数分かかります…",
    en: "Preparing the machine for the first time. This takes a few minutes…",
  },
  /** The conversation header's back button on a phone, where the list and
   * the conversation are two screens rather than two columns. */
  "chat.stella.backToList": {
    ja: "エージェント一覧に戻る",
    en: "Back to the agents",
  },
  /** An address named Lumisca on a server whose machine cannot run. The mode
   * is refused rather than shown degraded (see App.tsx): the sentence
   * explains why the reader landed on Lumisca code instead. */
  "chat.stella.refused": {
    ja: "Lumiscaモードはこのサーバーで使えません: {reason}",
    en: "Lumisca mode cannot run on this server: {reason}",
  },
  "chat.stella.unavailable.podmanMissing": {
    ja: "Lumiscaモードにはpodmanが必要です。podmanを入れてLumiscaを再起動するか、Lumisca codeを使ってください。",
    en: "Lumisca mode needs podman. Install podman and restart Lumisca, or use Lumisca code.",
  },
  "chat.stella.unavailable.podmanUnusable": {
    ja: "この環境ではコンテナを起動できません。Lumisca codeを使ってください。",
    en: "This environment cannot start a container. Use Lumisca code.",
  },
  "chat.stella.unavailable.vmNotSetUp": {
    ja: "Lumiscaモードの仮想マシンがこのインストールに設定されていません。",
    en: "Lumisca mode's virtual machine is not set up for this installation.",
  },
  "chat.stella.agents.new": { ja: "新しいエージェント", en: "New agent" },
  "chat.stella.agents.name": { ja: "名前", en: "Name" },
  /** Both fields are optional, and the form has to say so: a field that looks
   * required next to a disabled button is the wall this removed. */
  "chat.stella.agents.nameHint": {
    ja: "空のままにすると自動で付けます",
    en: "Leave it empty and one is picked for you",
  },
  /** The create dialog's one required answer: the job, in the user's words.
   * It becomes the agent's role (its system prompt); how it works is asked
   * by the agent itself, in the conversation (see stella/onboarding.ts). */
  "chat.stella.agents.role": {
    ja: "役割",
    en: "Role",
  },
  /** The examples under the wish field. A click writes the sentence into the
   * field: the preset IS the role, and the user can edit it first. */
  "chat.stella.agents.presets": {
    ja: "例から選ぶ",
    en: "Start from an example",
  },
  "chat.stella.agents.preset.secretary": { ja: "秘書", en: "Secretary" },
  "chat.stella.agents.preset.secretaryText": {
    ja: "毎朝の予定と未読メールをまとめて、返信が必要なものだけ知らせてください。予定の調整や下調べもお願いします。",
    en: "Summarize my morning schedule and unread mail, and tell me only what needs a reply. Help me move appointments and look things up.",
  },
  "chat.stella.agents.preset.bookkeeping": { ja: "家計", en: "Money" },
  "chat.stella.agents.preset.bookkeepingText": {
    ja: "家計の記録を手伝ってください。レシートや明細の内容を整理して、月ごとの支出をまとめて知らせてください。",
    en: "Help me keep track of household money: sort receipts and statements, and summarize each month's spending.",
  },
  "chat.stella.agents.preset.research": { ja: "調べもの", en: "Research" },
  "chat.stella.agents.preset.researchText": {
    ja: "調べものを手伝ってください。気になったことを伝えるので、複数の情報源を比べて、要点と注意点を短くまとめてください。",
    en: "Help me look things up: when I mention something, compare several sources and give me the key points and the caveats, briefly.",
  },
  "chat.stella.agents.preset.travel": { ja: "旅行", en: "Travel" },
  "chat.stella.agents.preset.travelText": {
    ja: "旅行の計画を手伝ってください。行き先の候補、移動、宿、予算を整理して、比べられる形で出してください。",
    en: "Help me plan trips: organize destinations, transport, places to stay and budget in a form I can compare.",
  },
  "chat.stella.agents.create": { ja: "作成", en: "Create" },
  "chat.stella.agents.creating": { ja: "作成中…", en: "Creating…" },
  /** The dialog a row's menu opens. What can be changed is what the user
   * chose: the label, the picture and the model. The role is fixed at
   * creation (it is the agent's working instruction), so this dialog
   * deliberately has no field for it. */
  "chat.stella.agents.edit": {
    ja: "名前・アイコン・モデルを編集",
    en: "Edit name, icon and model",
  },
  /** The row menu's way into the agent's schedule. Routines belong to one
   * agent, so they open from its row rather than from the app's settings. */
  "chat.stella.agents.routines": { ja: "ルーチン", en: "Routines" },
  /** The row menu's switch. Off is a state of the agent, not of a session:
   * a disabled agent keeps its history readable and does nothing else. */
  "chat.stella.agents.disable": { ja: "無効化", en: "Disable" },
  "chat.stella.agents.enable": { ja: "有効化", en: "Enable" },
  /** The fold at the bottom of the list. The count sits beside it, so the
   * label stays a name and not a sentence. */
  "chat.stella.agents.disabledGroup": {
    ja: "無効化されたエージェント",
    en: "Disabled agents",
  },
  "chat.stella.agents.routinesTitle": {
    ja: "「{name}」のルーチン",
    en: 'Routines of "{name}"',
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
    ja: "既定に戻す",
    en: "Reset to default",
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
    ja: "このエージェントで使用するモデルを設定します。",
    en: "Sets the model this agent uses.",
  },
  "chat.stella.agents.deleteTitle": {
    ja: "「{name}」を削除しますか？",
    en: 'Delete "{name}"?',
  },
  "chat.stella.agents.deleteBody": {
    ja: "このエージェントとの会話履歴もすべて削除されます。この操作は取り消せません。",
    en: "Its whole conversation is deleted too. This cannot be undone.",
  },
  "chat.stella.agents.empty": {
    ja: "エージェントがいません。",
    en: "No agent yet.",
  },
  /** The starter agent the server creates on a fresh installation, so the
   * sidebar is never empty (LumiscaCore.ensureStellaAgent). The role is the
   * instruction the agent works from, so it stays a plain sentence about the
   * machine it lives in. */
  "chat.stella.agents.starterName": { ja: "アシスタント", en: "Assistant" },
  "chat.stella.agents.starterRole": {
    ja: "毎日の予定やメール、調べものを手伝う秘書。わからないことは短く聞き、小さなことは自分で進めて、結果だけを報告します。",
    en: "A secretary who helps with the day's schedule, mail and research: asks briefly when unsure, does small things on its own, and reports only the result.",
  },
  "chat.stella.conversationError": {
    ja: "会話を開けませんでした: {error}",
    en: "Could not open the conversation: {error}",
  },
  /** The composer's place on a disabled agent's conversation. It says what
   * still works and what does not, because a screen with no field and a
   * button would otherwise read as a bug. */
  "chat.stella.disabledNotice": {
    ja: "このエージェントは無効化されています。会話は読めますが、新しいメッセージは送れません。",
    en: "This agent is disabled. Its conversation can be read, but no new messages can be sent.",
  },
  "chat.stella.placeholder": {
    ja: "メッセージを入力…",
    en: "Type a message…",
  },
  /** A file a prompt brought into the machine that the machine no longer
   * has (the agent moved or deleted it): the conversation says so rather
   * than showing a copy that exists nowhere else. */
  "chat.stella.fileGone": {
    ja: "このファイルはマシンから削除されました",
    en: "This file was deleted from the machine",
  },
  "chat.stella.working": { ja: "作業中…", en: "Working…" },
  "chat.stella.activity.thinking": { ja: "考え中…", en: "Thinking…" },
  "chat.stella.activity.browsing": {
    ja: "画面を確認中…",
    en: "Checking the screen…",
  },
  "chat.stella.activity.searching": { ja: "検索中…", en: "Searching…" },
  "chat.stella.activity.files": {
    ja: "ファイルを確認中…",
    en: "Checking files…",
  },
  "chat.stella.search.open": { ja: "会話を検索", en: "Search conversation" },
  "chat.stella.search.placeholder": {
    ja: "メッセージを検索…",
    en: "Search messages…",
  },
  "chat.stella.search.empty": {
    ja: "一致するメッセージがありません",
    en: "No matching messages",
  },
  "chat.stella.search.count": { ja: "{count}件", en: "{count} results" },
  "chat.stella.search.you": { ja: "あなた", en: "You" },
  "chat.stella.search.failed": {
    ja: "検索できませんでした",
    en: "Search failed",
  },
  /** The second line of an agent's row: what the conversation last said.
   * Words are shown as they are; a message that carried no words is
   * described, because "3 files" is a caption rather than something the user
   * wrote. */
  "chat.stella.agents.preview.files": {
    ja: "ファイル{count}件",
    en: "{count} files",
  },
  "chat.stella.agents.preview.card": { ja: "カード", en: "Card" },
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
    ja: "情報を表示",
    en: "Show info",
  },
  "chat.stella.machine.hideScreen": {
    ja: "情報を隠す",
    en: "Hide info",
  },
  "chat.stella.machine.screenConnecting": {
    ja: "画面に接続しています…",
    en: "Connecting to the screen…",
  },
  /** The machine was stopped because nobody used it (see VM_IDLE_SLEEP_MS).
   * The pane says so instead of drawing the disconnect as a failure; the
   * button beside it brings the machine back. */
  "chat.stella.machine.asleep": {
    ja: "しばらく使われていないため、マシンは休止しています。",
    en: "The machine is asleep because it has not been used for a while.",
  },
  "chat.stella.machine.wake": { ja: "起動する", en: "Wake" },
  "chat.stella.machine.waking": { ja: "起動しています…", en: "Waking…" },
  /** The right-hand panel's name for assistive technology. The panel carries
   * no visible title: its two sections (the screen and the lent folders) name
   * themselves. */
  "chat.stella.machine.info": { ja: "情報", en: "Info" },
  "chat.stella.share.open": {
    ja: "フォルダーで共同作業",
    en: "Share a folder",
  },
  "chat.stella.share.title": {
    ja: "このパソコンで共同作業",
    en: "Work together on this computer",
  },
  "chat.stella.share.hint": {
    ja: "このPCのフォルダーを、この会話のエージェントが使えるようにします。",
    en: "Let this conversation's agent use a folder on this computer.",
  },
  /** The whole machine as one loan: every drive on Windows, the root on
   * macOS and Linux. The shell enumerates the places; this is the heading of
   * the list it filled. */
  "chat.stella.share.computer.title": {
    ja: "このパソコン",
    en: "This computer",
  },
  "chat.stella.share.computer.hint": {
    ja: "このパソコン全体を、この会話のエージェントが使えるようにします。コマンドもこのユーザーとして実行できます。",
    en: "Let this conversation's agent use this whole computer. It can also run commands as you.",
  },
  "chat.stella.share.computer.lend": {
    ja: "PC全体へのアクセスを共有",
    en: "Share access to this whole PC",
  },
  "chat.stella.share.computer.lending": {
    ja: "接続しています…",
    en: "Sharing…",
  },
  "chat.stella.share.computer.failed": {
    ja: "接続できませんでした: {error}",
    en: "Could not share: {error}",
  },
  "chat.stella.share.computer.disconnectFailed": {
    ja: "切断できませんでした: {error}",
    en: "Could not disconnect: {error}",
  },
  "chat.stella.share.pick": {
    ja: "フォルダーを選ぶ",
    en: "Choose a folder",
  },
  "chat.stella.share.recent": {
    ja: "最近接続したフォルダー",
    en: "Recently shared",
  },
  /** The pair's shared name: the two halves are one choice, and a screen
   * reader announcing them needs to say what is being chosen. */
  "chat.stella.share.terms": {
    ja: "アクセス",
    en: "Access",
  },
  "chat.stella.share.readOnly": {
    ja: "読み取りのみ",
    en: "Read only",
  },
  "chat.stella.share.readWrite": {
    ja: "読み書き",
    en: "Read and write",
  },
  /** The connection's clock is the host's, and the reader chose it in
   * Settings → アプリ: `minutes` is that choice, so the sentence must not
   * repeat a length. The sentence says what ends (the connection), not that
   * something "cuts off". */
  "chat.stella.share.idle": {
    ja: "最後に使ってから{minutes}分で切断されます。",
    en: "Ends {minutes} minutes after the last use.",
  },
  "chat.stella.share.idleNever": {
    ja: "自動では切断されません。使い終わったら切断してください。",
    en: "It does not end on its own. Disconnect it when you are done.",
  },
  "chat.stella.share.lend": { ja: "接続", en: "Share" },
  "chat.stella.share.lending": {
    ja: "接続しています…",
    en: "Sharing…",
  },
  "chat.stella.share.pickFailed": {
    ja: "フォルダーを選べませんでした: {error}",
    en: "Could not choose a folder: {error}",
  },
  "chat.stella.share.lendFailed": {
    ja: "接続できませんでした: {error}",
    en: "Could not share: {error}",
  },
  "chat.stella.share.panel": {
    ja: "共有フォルダー",
    en: "Shared folders",
  },
  "chat.stella.share.disconnect": {
    ja: "切断",
    en: "Disconnect",
  },
  "chat.stella.share.disconnectFailed": {
    ja: "切断できませんでした: {error}",
    en: "Could not disconnect: {error}",
  },
  /** How many folders the conversation can reach right now, in the line
   * above the composer. Two keys because English needs the singular and
   * Japanese does not. */
  "chat.stella.share.active": {
    ja: "{count}個のフォルダーを共有中",
    en: "Sharing {count} folders",
  },
  "chat.stella.share.activeOne": {
    ja: "1個のフォルダーを共有中",
    en: "Sharing 1 folder",
  },
  /** The card `share_request` puts in the conversation. Its title names what
   * is being asked for; the sentence under it is the agent's own reason, so
   * there is no key for that. */
  "chat.stella.share.request.title": {
    ja: "フォルダーの共有",
    en: "Folder sharing",
  },
  "chat.stella.share.request.hint": {
    ja: "このPCのフォルダーを選ぶと、この会話のエージェントが使えるようになります。",
    en: "Choose a folder on this computer and this conversation's agent can use it.",
  },
  /** Refusing to lend a folder. A card has no close button, so this is the
   * only way to say "no" — and the run continues without one. */
  "chat.stella.share.request.decline": {
    ja: "共有しない",
    en: "Not now",
  },
  /** When the wait ends (the same shape as the environment-variable card's
   * line: the time alone, no explanation). */
  "chat.stella.share.request.deadline": {
    ja: "{time}まで",
    en: "Until {time}",
  },
  /** A browser tab has no OS folder picker: the card says so instead of
   * offering a button that cannot work. */
  "chat.stella.share.request.browserOnly": {
    ja: "この画面からはフォルダーを選べません。デスクトップアプリで開いてください。",
    en: "A folder cannot be chosen from this page. Open the desktop app.",
  },
  /** What a screen reader hears when the card appears (the card cannot
   * announce itself the way a dialog does). */
  "chat.stella.share.request.announce": {
    ja: "エージェントがフォルダーの共有を求めています。",
    en: "The agent asks you to share a folder.",
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
  /** When the wait ends by itself: saying when keeps a late return from
   * looking like a lost run. */
  "chat.stella.handover.deadline": {
    ja: "この待機は{time}までです",
    en: "This wait ends at {time}.",
  },
  /** The card `vm_env` puts in the conversation: the user types a secret
   * that goes into the machine and never into the conversation. The card is
   * small, so every line earns its place: the title names the kind, the
   * sentence names the variable and asks once, the hint keeps the one
   * promise a secret needs (the agent never sees it). */
  "chat.stella.env.title": {
    ja: "環境変数",
    en: "Environment variable",
  },
  "chat.stella.env.request": {
    ja: "{name}の値を入力してください。",
    en: "Enter the value of {name}.",
  },
  "chat.stella.env.existing": {
    ja: "設定済みの値を置き換えます。",
    en: "Replaces the stored value.",
  },
  /** The input's accessible name only: the visible caption was a third name
   * for what the placeholder already says. */
  "chat.stella.env.value": { ja: "値", en: "Value" },
  "chat.stella.env.placeholder": {
    ja: "値を入力",
    en: "Enter the value",
  },
  "chat.stella.env.hint": {
    ja: "マシンに保存され、エージェントには渡りません。",
    en: "Stored in the machine; the agent never sees it.",
  },
  /** The button is the generic save (common.save); only the busy state is
   * this card's own. */
  "chat.stella.env.saving": { ja: "保存中…", en: "Saving…" },
  /** Refusing to give the value. A card has no close button, so this is the
   * only way to say "no". Short: it sits beside the save, and the row has
   * two words in it already. It says what the user does, not what the card
   * lacks: "入れない" read as a judgement of the value. */
  "chat.stella.env.decline": {
    ja: "入力しない",
    en: "Skip",
  },
  /** When the wait ends. The card says nothing about what happens after it:
   * a parenthetical explanation made the line the longest one on a card that
   * has to stay small. */
  "chat.stella.env.deadline": {
    ja: "{time}まで",
    en: "Until {time}",
  },
  /** The clipboard the user and the machine share while the user drives the
   * screen. Two words in the hand-over bar: what worked is visible on its own
   * (the text appears where it was pasted, or on this PC's clipboard), so the
   * rest are short failures. */
  "chat.stella.handover.clipboard.copy": { ja: "コピー", en: "Copy" },
  "chat.stella.handover.clipboard.paste": { ja: "ペースト", en: "Paste" },
  "chat.stella.handover.clipboard.copyHint": {
    ja: "画面のコピーをこのPCへ",
    en: "Copy the screen's text to this PC",
  },
  "chat.stella.handover.clipboard.pasteHint": {
    ja: "このPCのコピーを画面へ",
    en: "Paste this PC's copy into the screen",
  },
  "chat.stella.handover.clipboard.copied": {
    ja: "コピーしました",
    en: "Copied",
  },
  "chat.stella.handover.clipboard.copyNothing": {
    ja: "画面ではまだ何もコピーされていません",
    en: "Nothing has been copied on the screen yet",
  },
  "chat.stella.handover.clipboard.copyFailed": {
    ja: "このPCにコピーできませんでした",
    en: "Could not copy it to this PC",
  },
  "chat.stella.handover.clipboard.copyError": {
    ja: "画面のコピーを読めませんでした: {reason}",
    en: "Could not read the screen's copy: {reason}",
  },
  "chat.stella.handover.clipboard.pasteEmpty": {
    ja: "このPCのコピーは空でした",
    en: "This PC's clipboard was empty",
  },
  "chat.stella.handover.clipboard.pasteReadFailed": {
    ja: "このPCのコピーを読めませんでした",
    en: "Could not read this PC's clipboard",
  },
  "chat.stella.handover.clipboard.pasteFailed": {
    ja: "画面へ貼り付けられませんでした: {reason}",
    en: "Could not paste it into the screen: {reason}",
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
  "chat.transcript.scrollToBottom": {
    ja: "最新のメッセージへ",
    en: "Scroll to latest",
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
