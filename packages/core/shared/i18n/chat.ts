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

  // --- chat view -----------------------------------------------------------
  "chat.empty.workspace": {
    ja: "作業内容（タスク）を入力してください。ワークスペース内のファイル操作やコマンド実行をAIが自律的に進めます。",
    en: "Enter a task. The AI will autonomously operate files and run commands in your workspace.",
  },
  "chat.empty.chat": {
    ja: "メッセージを入力してください。フォルダー連携を行わないシンプルなチャットです。",
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
    en: '"{name}" cannot be attached: only pictures can be attached in this mode',
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
    ja: "デフォルトのモデルを取得できませんでした:",
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
    ja: "図が大きすぎます。上限は {limit} です。",
    en: "Diagram is too large. The limit is {limit}.",
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
    ja: "初回セットアップを行っています。数分かかります…",
    en: "Preparing the machine for the first time. This takes a few minutes…",
  },
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
  /** The create dialog's one required answer: the job, in the user's words.
   * It becomes the agent's role (its system prompt); how it works is asked
   * by the agent itself, in the conversation (see stella/onboarding.ts). */
  "chat.stella.agents.role": {
    ja: "どんなことをしてほしいですか？",
    en: "What should it do for you?",
  },
  "chat.stella.agents.roleHint": {
    ja: "例）毎朝の予定と未読メールをまとめて、返信が必要なものだけ知らせてください",
    en: "e.g. Summarize my morning schedule and unread mail, and tell me only what needs a reply",
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
  "chat.stella.agents.routinesTitle": {
    ja: "「{name}」のルーチン",
    en: 'Routines of "{name}"',
  },
  /** The row menu's redo: the agent asks how it should work, again. */
  "chat.stella.agents.onboarding": {
    ja: "設定をやり直す",
    en: "Set up again",
  },
  "chat.stella.agents.onboardingBusy": {
    ja: "いま作業中です。終わってからやり直してください。",
    en: "It is working right now. Try again when it finishes.",
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
    ja: "このエージェントの会話が使うモデルです。未設定なら既定のモデルを使います。",
    en: "The model this agent's conversation runs on. Unset means the app's default model.",
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
    ja: "登録されているエージェントがありません。「新しいエージェント」から作成してください。",
    en: "No agent yet. Create one.",
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
  "chat.stella.machine.screenEmpty": {
    ja: "マシンが起動すると、ここに画面が表示されます。",
    en: "The machine's screen appears here once it runs.",
  },
  "chat.stella.machine.screenConnecting": {
    ja: "画面に接続しています…",
    en: "Connecting to the screen…",
  },
  /** The right-hand panel, which holds what is true about the conversation
   * beyond its text: the folders lent from this computer and the machine's
   * screen. */
  "chat.stella.machine.info": { ja: "情報", en: "Info" },
  "chat.stella.share.open": {
    ja: "フォルダで共同作業",
    en: "Share a folder",
  },
  "chat.stella.share.title": {
    ja: "フォルダで共同作業",
    en: "Share a folder",
  },
  "chat.stella.share.hint": {
    ja: "この PC のフォルダを、この会話のエージェントが使えるようにします。",
    en: "Let this conversation's agent use a folder on this computer.",
  },
  "chat.stella.share.pick": {
    ja: "フォルダを選ぶ",
    en: "Choose a folder",
  },
  "chat.stella.share.recent": {
    ja: "最近貸したフォルダ",
    en: "Recently shared",
  },
  "chat.stella.share.readOnly": {
    ja: "読み取りのみ",
    en: "Read only",
  },
  "chat.stella.share.readWrite": {
    ja: "読み書き",
    en: "Read and write",
  },
  /** The loan's clock is the lender's: keep the sentence in step with
   * SHARE_IDLE_MS in packages/server/share-host.ts. */
  "chat.stella.share.idle": {
    ja: "最後に使ってから30分で切れます。",
    en: "Ends 30 minutes after the last use.",
  },
  "chat.stella.share.lend": { ja: "貸す", en: "Share" },
  "chat.stella.share.lending": {
    ja: "貸しています…",
    en: "Sharing…",
  },
  "chat.stella.share.pickFailed": {
    ja: "フォルダを選べませんでした: {error}",
    en: "Could not choose a folder: {error}",
  },
  "chat.stella.share.lendFailed": {
    ja: "貸せませんでした: {error}",
    en: "Could not share: {error}",
  },
  "chat.stella.share.panel": {
    ja: "共有フォルダ",
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
    ja: "この待機は {time} までです",
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
    ja: "{name} の値を入力してください。",
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
    ja: "{time} まで",
    en: "Until {time}",
  },
  /** The clipboard the user and the machine share while the user drives the
   * screen. Two words in the hand-over bar: what worked is visible on its own
   * (the text appears where it was pasted, or on this PC's clipboard), so the
   * rest are short failures. */
  "chat.stella.handover.clipboard.copy": { ja: "コピー", en: "Copy" },
  "chat.stella.handover.clipboard.paste": { ja: "ペースト", en: "Paste" },
  "chat.stella.handover.clipboard.copyHint": {
    ja: "画面のコピーをこの PC へ",
    en: "Copy the screen's text to this PC",
  },
  "chat.stella.handover.clipboard.pasteHint": {
    ja: "この PC のコピーを画面へ",
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
    ja: "この PC にコピーできませんでした",
    en: "Could not copy it to this PC",
  },
  "chat.stella.handover.clipboard.copyError": {
    ja: "画面のコピーを読めませんでした: {reason}",
    en: "Could not read the screen's copy: {reason}",
  },
  "chat.stella.handover.clipboard.pasteEmpty": {
    ja: "この PC のコピーは空でした",
    en: "This PC's clipboard was empty",
  },
  "chat.stella.handover.clipboard.pasteReadFailed": {
    ja: "この PC のコピーを読めませんでした",
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
