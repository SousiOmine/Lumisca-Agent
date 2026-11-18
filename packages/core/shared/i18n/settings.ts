import type { LocalizedText } from "./types.ts";

/**
 * Messages of the settings dialog (packages/web/src/components/settings/):
 * the panel navigation, the general/update panel, providers, models, MCP,
 * connections, personalization, appearance and the security panel. The
 * language panel that picks between these catalogues is here too.
 *
 * Keys are `settings.<surface>.<element>`; the shared actions (close, back,
 * …) live in `common.ts`.
 */
export const settings = {
  // --- dialog chrome (SettingsModal) ----------------------------------------
  /** The two owners: where a value lives. */
  "settings.owner.device": { ja: "この端末", en: "This device" },
  "settings.owner.server": { ja: "サーバー", en: "Server" },
  "settings.nav.notifications": { ja: "通知", en: "Notifications" },
  "settings.nav.app": { ja: "アプリ", en: "App" },
  "settings.nav.overview": { ja: "概要", en: "Overview" },
  "settings.nav.appearance": { ja: "外観", en: "Appearance" },
  "settings.nav.personalize": { ja: "カスタマイズ", en: "Personalization" },
  "settings.nav.peers": { ja: "接続先サーバー", en: "Servers" },
  "settings.nav.providers": { ja: "プロバイダー", en: "Providers" },
  "settings.nav.models": { ja: "モデル設定", en: "Models" },
  "settings.nav.mcp": { ja: "MCPサーバー", en: "MCP servers" },
  "settings.nav.prompts": { ja: "保存済みプロンプト", en: "Saved prompts" },
  "settings.nav.computerUse": { ja: "画面操作", en: "Screen control" },
  "settings.nav.security": { ja: "セキュリティ", en: "Security" },
  "settings.nav.experimental": { ja: "実験的機能", en: "Experimental" },
  /** The badge on a page whose values only code mode's sessions use. */
  "settings.scope.codeOnly": {
    ja: "Lumisca codeのみ",
    en: "Lumisca code only",
  },
  /** One sentence at the top of a page: what its values act on. */
  "settings.scope.device.notifications": {
    ja: "この端末で受け取る通知を決めます。",
    en: "Chooses the notifications this device receives.",
  },
  "settings.scope.device.app": {
    ja: "この端末のデスクトップアプリを更新します。",
    en: "Updates the desktop app on this device.",
  },
  "settings.scope.server.overview": {
    ja: "このサーバーのプログラムと、すべての会話に適用されます。",
    en: "Applies to this server's program and all of its conversations.",
  },
  "settings.scope.server.appearance": {
    ja: "このサーバーに保存され、この端末の表示に使います。",
    en: "Stored on this server and used for this device's display.",
  },
  "settings.scope.server.providers": {
    ja: "このサーバーのすべての会話が使うプロバイダーです。",
    en: "Providers every conversation on this server uses.",
  },
  "settings.scope.server.models": {
    ja: "このサーバーのすべての会話が使うモデルです。",
    en: "Models every conversation on this server uses.",
  },
  "settings.scope.server.mcp": {
    ja: "このサーバーのすべての会話が使うMCPサーバーです。",
    en: "MCP servers every conversation on this server uses.",
  },
  "settings.scope.server.personalize": {
    ja: "このサーバーのすべての会話が読む指示です。",
    en: "Instructions every conversation on this server reads.",
  },
  "settings.scope.server.prompts": {
    ja: "Lumisca codeの入力欄から呼び出します。",
    en: "Recalled from Lumisca code's composer.",
  },
  "settings.scope.server.security": {
    ja: "このサーバーで動くコマンドの確認を決めます。",
    en: "Decides the check on commands this server runs.",
  },
  "settings.scope.server.computerUse": {
    ja: "このサーバーが動いているマシンの画面を操作します。",
    en: "Drives the screen of the machine this server runs on.",
  },
  "settings.scope.server.peers": {
    ja: "このサーバーが連携しているサーバーです。表示するサーバーの切り替えもここから行います。",
    en: "Servers this server federates with. The switch for the displayed server is here too.",
  },
  "settings.scope.server.experimental": {
    ja: "このサーバーのすべての会話に適用される試験中の機能です。",
    en: "Features under test that affect every conversation on this server.",
  },
  /** The current server, as the settings navigation's heading. */
  "settings.serverCard.viewing": { ja: "表示中", en: "Viewing" },
  "settings.notifications.none": {
    ja: "この端末で使える通知はありません。",
    en: "No notification channels are available on this device.",
  },
  "settings.serverCard.browser": {
    ja: "このページの配信元",
    en: "Serving this page",
  },
  "settings.serverCard.switch": { ja: "切り替え", en: "Switch" },
  "settings.serverCard.manage": { ja: "接続先を管理", en: "Manage servers" },
  // --- appearance panel -----------------------------------------------------
  "settings.appearance.theme.label": { ja: "テーマ設定", en: "Theme" },
  "settings.appearance.theme.light": { ja: "ライト", en: "Light" },
  "settings.appearance.theme.dark": { ja: "ダーク", en: "Dark" },
  "settings.appearance.theme.system": {
    ja: "システム設定に連動",
    en: "Match system",
  },
  "settings.appearance.saveFailed": {
    ja: "テーマ設定を保存できませんでした: {error}",
    en: "Could not save the theme: {error}",
  },

  // `settings.language.*` keys below are read by the general panel (the
  // language is a general preference, not a settings category of its own).
  "settings.language.label": { ja: "言語", en: "Language" },
  "settings.language.description": {
    ja: "新しい会話の回答に使います。画面の表示言語も切り替わります。",
    en: "Used for new conversations' answers. Also changes the screen language.",
  },
  "settings.language.option.ja": { ja: "日本語", en: "Japanese" },
  "settings.language.option.en": { ja: "English", en: "English" },
  "settings.language.saveFailed": {
    ja: "言語設定を保存できませんでした: {error}",
    en: "Could not save the language setting: {error}",
  },

  // --- general panel --------------------------------------------------------
  "settings.general.serverAddress": { ja: "接続先", en: "Server" },
  /** The server overview when the desktop shell owns the running program. */
  "settings.overview.managedByApp": {
    ja: "このサーバーはデスクトップアプリが管理しています。更新は「アプリ」で行います。",
    en: "The desktop app manages this server. Updates are on the App page.",
  },
  "settings.app.noShell": {
    ja: "デスクトップアプリの更新を読み込めませんでした。",
    en: "Could not read the desktop app's updater.",
  },
  "settings.general.updateNoUpdater": {
    ja: "このサーバーには更新機能がありません。開発実行か、デスクトップアプリが管理するサーバーです。",
    en: "This server has no updater. It is a development run, or a server the desktop app manages.",
  },
  "settings.general.updateUnauthorized": {
    ja: "サーバーの認証が切れています。このページを読み込み直して、もう一度お試しください。",
    en: "The server refused this page's credential. Reload the page and try again.",
  },
  "settings.general.updateUnreachable": {
    ja: "サーバーに接続できないため、更新状態を取得できませんでした。",
    en: "Could not read the update state: the server could not be reached.",
  },
  "settings.general.updateReadFailed": {
    ja: "サーバーの更新状態を取得できませんでした: {error}",
    en: "Could not read the server's update state: {error}",
  },
  "settings.general.checkingUpdate": {
    ja: "アップデートを確認中…",
    en: "Checking for updates…",
  },
  "settings.general.appliedRestartDesktop": {
    ja: "v{version}を適用しました。再起動すると有効になります。",
    en: "v{version} applied. It will take effect after a restart.",
  },
  "settings.general.appliedRestartSystemd": {
    ja: "v{version}を適用しました。サービスの再起動後に有効になります。",
    en: "v{version} applied. It will take effect after the service restarts.",
  },
  "settings.general.appliedNextStart": {
    ja: "v{version}を適用しました。次回の起動で有効になります。",
    en: "v{version} applied. It will take effect on the next start.",
  },
  "settings.general.readyToInstall": {
    ja: "v{version}のアップデートの準備ができました。",
    en: "Update to v{version} is ready to install.",
  },
  "settings.general.readyToInstallServer": {
    ja: "v{version}のアップデートをインストールできます。",
    en: "Update to v{version} is ready to install on the server.",
  },
  "settings.general.versionAvailable": {
    ja: "v{version}が利用可能です。",
    en: "v{version} is available.",
  },
  "settings.general.latestVersion": {
    ja: "最新バージョンです。",
    en: "You are on the latest version.",
  },
  "settings.general.serverInfo": { ja: "サーバー情報", en: "Server info" },
  "settings.general.appInfo": { ja: "アプリ情報", en: "App info" },
  "settings.general.autoUpdate": { ja: "自動アップデート", en: "Auto-update" },
  "settings.general.autoRestart": {
    ja: "適用時に自動で再起動",
    en: "Auto-restart on apply",
  },
  "settings.general.autoRestartDesc": {
    ja: "常時稼働サーバー向けの設定です。無効にした場合は次回起動時に反映されます。再起動すると実行中のセッションは停止します。",
    en: "For always-on servers. When disabled, changes take effect on the next start. Restarting stops running sessions.",
  },
  "settings.general.downloading": { ja: "ダウンロード中", en: "Downloading" },
  "settings.general.checkForUpdate": {
    ja: "アップデートを確認",
    en: "Check for updates",
  },
  "settings.general.restart": { ja: "再起動", en: "Restart" },
  "settings.general.install": { ja: "インストール", en: "Install" },
  "settings.general.installing": { ja: "インストール中…", en: "Installing…" },
  "settings.general.download": { ja: "ダウンロード", en: "Download" },
  "settings.general.installNote": {
    ja: "インストールするとアプリが再起動します。",
    en: "The app will restart after installation.",
  },
  "settings.general.installNoteServer": {
    ja: "インストールすると、次回の起動で新しいバージョンが有効になります。",
    en: "After installation, the new version will take effect on the next start.",
  },
  "settings.general.autoRestartDisabled": {
    ja: "自動再起動が無効に設定されています。手動または監視サービスから再起動してください。",
    en: "Auto-restart is disabled. Please restart manually or from your supervisor service.",
  },
  "settings.general.autoUpdateNotAvailable": {
    ja: "このサーバーでは自動アップデートを利用できません",
    en: "Auto-update is not available on this server",
  },
  "settings.general.shellUnreachable": {
    ja: "デスクトップシェルと通信できません: ",
    en: "Cannot communicate with the desktop shell: ",
  },
  "settings.general.bgNotification": {
    ja: "バックグラウンド通知",
    en: "Background notifications",
  },
  /** Web Push: agent events delivered to an installed PWA through the
   * browser's push service, so they arrive with the app closed. */
  "settings.general.pushNotifications": {
    ja: "PWA通知",
    en: "PWA notifications",
  },
  "settings.general.pushNotificationsDesc": {
    ja: "インストールしたPWAに、実行完了・質問・エラーをOSの通知で届けます。アプリを閉じていても届きます。iPhone / iPadではホーム画面に追加したPWAでだけ使えます。",
    en: "Deliver completion, question and error alerts to the installed PWA through your OS, even with the app closed. On iPhone / iPad this works only in a PWA added to the home screen.",
  },
  "settings.general.pushDenied": {
    ja: "このサイトの通知がブラウザでブロックされています。ブラウザのサイト設定から許可してください。",
    en: "Notifications are blocked for this site. Allow them in your browser's site settings.",
  },
  "settings.general.pushFailed": {
    ja: "通知を有効にできませんでした: {error}",
    en: "Could not enable notifications: {error}",
  },
  "settings.general.pushTest": { ja: "テスト通知を送る", en: "Send a test" },
  "settings.general.pushTestSent": {
    ja: "テスト通知を送信しました",
    en: "Test notification sent",
  },

  // --- personalize panel ----------------------------------------------------
  "settings.personalize.customInstructions": {
    ja: "カスタム指示",
    en: "Custom instructions",
  },
  "settings.personalize.customInstructionsPlaceholder": {
    ja: "例:\n- 回答は日本語で記述してください。\n- 変更後は必ずテストを実行してください。",
    en: "Example:\n- Write your responses in English.\n- Always run tests after making changes.",
  },
  /** The path the editor writes to, shown under it: the text is a file on
   * this machine, not a value in a database. */
  "settings.personalize.appliesTo": {
    ja: "このマシンで動くすべてのエージェントに適用されます。開始済みのセッションにも、次の発言から反映されます。",
    en: "Applies to every agent on this machine, including sessions already running (from their next message).",
  },

  // --- saved prompts (their own category) -----------------------------------
  "settings.prompts.loadFailed": {
    ja: "プロンプトを読み込めませんでした: {error}",
    en: "Could not load prompts: {error}",
  },
  "settings.prompts.empty": {
    ja: "まだ登録されていません。「追加」から、よく使う指示を登録できます。",
    en: 'None yet. Use "Add" above to register a request you repeat.',
  },
  "settings.prompts.deleteConfirm": {
    ja: "プロンプト「{name}」を削除しますか？",
    en: 'Delete prompt "{name}"?',
  },
  "settings.prompts.idLabel": { ja: "識別子", en: "ID" },
  "settings.prompts.idPlaceholder": {
    ja: "例: translate",
    en: "e.g. translate",
  },
  "settings.prompts.idEmpty": {
    ja: "識別子を入力してください",
    en: "Enter an ID",
  },
  "settings.prompts.idInvalidChars": {
    ja: "識別子に使用できる文字は半角英数字および記号「.」「_」「-」のみです",
    en: 'The ID may only contain ASCII letters, digits, and the symbols ".", "_", "-"',
  },
  "settings.prompts.displayLabel": { ja: "表示名", en: "Display name" },
  "settings.prompts.displayPlaceholder": {
    ja: "例: 翻訳",
    en: "e.g. Translate",
  },
  "settings.prompts.displayEmpty": {
    ja: "表示名を入力してください",
    en: "Enter a display name",
  },
  "settings.prompts.promptLabel": { ja: "プロンプト文", en: "Prompt text" },
  "settings.prompts.promptPlaceholder": {
    ja: "例: 次のテキストを日本語に翻訳してください:\n\n{ここにテキスト}",
    en: "e.g. Translate the following text into English:\n\n{text here}",
  },
  "settings.prompts.promptEmpty": {
    ja: "プロンプト文を入力してください",
    en: "Enter prompt text",
  },

  // --- provider list --------------------------------------------------------
  "settings.provider.catalogStatus": {
    ja: "モデルカタログ:",
    en: "Model catalog:",
  },
  "settings.provider.catalogChecking": { ja: "確認中…", en: "Checking…" },
  "settings.provider.catalogSourceLatest": { ja: "最新", en: "Latest" },
  "settings.provider.catalogSourceCache": { ja: "キャッシュ", en: "Cache" },
  "settings.provider.catalogSourceSnapshot": { ja: "同梱版", en: "Bundled" },
  "settings.provider.refreshing": { ja: "更新中…", en: "Refreshing…" },
  "settings.provider.refreshToLatest": {
    ja: "最新に更新",
    en: "Update to latest",
  },
  "settings.provider.refreshFailed": {
    ja: "更新できませんでした: {error}",
    en: "Could not refresh: {error}",
  },
  "settings.provider.noProviders": {
    ja: "登録されたプロバイダーがありません。「追加」ボタンから設定してください。",
    en: 'No providers registered. Use the "Add" button to set one up.',
  },
  /** One-line explanation under the AI provider heading, mirroring the
   * search section's own description: the two sections are one list of
   * services, so each says what it is for and nothing else. */
  "settings.provider.aiDescription": {
    ja: "エージェントが応答の生成に使用するAIプロバイダーです。",
    en: "The AI providers the agent uses to generate replies.",
  },
  "settings.provider.configured": { ja: "設定済み", en: "Configured" },
  "settings.provider.notConfigured": { ja: "未設定", en: "Not configured" },
  "settings.provider.addProvider": {
    ja: "プロバイダーを追加",
    en: "Add provider",
  },

  // --- provider detail ------------------------------------------------------
  "settings.provider.loginStatus": { ja: "ログイン済み", en: "Logged in" },
  "settings.provider.oauthDescription": {
    ja: "OAuthログイン（サブスクリプション契約）",
    en: "OAuth login (subscription)",
  },
  "settings.provider.logout": { ja: "ログアウト", en: "Logout" },
  "settings.provider.login": { ja: "ログイン", en: "Login" },
  "settings.provider.loginWithBrowser": {
    ja: "ブラウザでログイン",
    en: "Sign in with browser",
  },
  "settings.provider.loginWithDeviceCode": {
    ja: "デバイスコードでログイン",
    en: "Sign in with a device code",
  },
  "settings.provider.loginHint": {
    ja: "サブスクリプションのアカウントでログインします。",
    en: "Sign in with your subscription account.",
  },
  "settings.provider.loginRemoteHint": {
    ja: "ブラウザでのログインは、このサーバーと同じマシンで開いたページでのみ使えます。リモート接続ではデバイスコードを使ってください。",
    en: "Browser sign-in works only on a page opened on the server machine. Use a device code when connecting remotely.",
  },
  "settings.provider.authWaiting": {
    ja: "認証を待機中…",
    en: "Waiting for authentication…",
  },
  "settings.provider.deviceCodeLabel": {
    ja: "確認コード",
    en: "Verification code",
  },
  "settings.provider.copy": { ja: "コピー", en: "Copy" },
  "settings.provider.openLoginScreen": {
    ja: "ログイン画面を開く",
    en: "Open login screen",
  },
  "settings.provider.deviceCodeHint": {
    ja: "表示された認証画面で上記の確認コードを入力し、連携を承認してください。",
    en: "Enter the verification code shown above in the authentication screen and approve the connection.",
  },
  "settings.provider.loginInBrowser": {
    ja: "ブラウザでログイン",
    en: "Log in in browser",
  },
  "settings.provider.loginDone": { ja: "ログインしました", en: "Logged in" },
  "settings.provider.loginCancelled": {
    ja: "キャンセルしました",
    en: "Cancelled",
  },
  "settings.provider.loginFailed": {
    ja: "ログインに失敗しました",
    en: "Login failed",
  },
  "settings.provider.loginCancelledNotice": {
    ja: "ログインをキャンセルしました",
    en: "Login cancelled",
  },
  "settings.provider.logoutDone": {
    ja: "ログアウトしました",
    en: "Logged out",
  },
  "settings.provider.copyDone": { ja: "コピーしました", en: "Copied" },
  "settings.provider.copyFailed": {
    ja: "コピーに失敗しました",
    en: "Failed to copy",
  },
  "settings.provider.apiKeyLabel": { ja: "APIキー", en: "API key" },
  "settings.provider.apiKeyPlaceholderNew": {
    ja: "APIキーを入力",
    en: "Enter your API key",
  },
  "settings.provider.apiKeyPlaceholderOverwrite": {
    ja: "新しいAPIキー（上書き）",
    en: "New API key (overwrite)",
  },
  "settings.provider.apiKeySaved": {
    ja: "APIキーを保存しました",
    en: "API key saved",
  },
  "settings.provider.deleteConfirm": {
    ja: "プロバイダー「{name}」を削除しますか？",
    en: 'Delete provider "{name}"?',
  },
  "settings.provider.duplicateHeader": {
    ja: "重複するヘッダー名: {name}",
    en: "Duplicate header name: {name}",
  },

  // --- add provider flow ----------------------------------------------------
  "settings.provider.selectToAdd": {
    ja: "追加するプロバイダーを選択してください",
    en: "Select a provider to add",
  },
  "settings.provider.searchPlaceholder": {
    ja: "プロバイダーを検索…",
    en: "Search providers…",
  },
  "settings.provider.noMatch": {
    ja: "該当するプロバイダーがありません",
    en: "No matching providers",
  },
  "settings.provider.notInList": {
    ja: "一覧にないプロバイダー",
    en: "Provider not in the list",
  },
  "settings.provider.addCustomOpenAI": {
    ja: "カスタムOpenAI互換プロバイダーを追加",
    en: "Add custom OpenAI-compatible provider",
  },
  "settings.provider.send": { ja: "送信", en: "Send" },
  "settings.provider.done": { ja: "完了", en: "Done" },

  // --- user provider form ---------------------------------------------------
  "settings.userProvider.createTitle": {
    ja: "カスタムプロバイダーを追加",
    en: "Add custom provider",
  },
  "settings.userProvider.editTitle": {
    ja: "カスタムプロバイダーを編集",
    en: "Edit custom provider",
  },
  "settings.userProvider.displayNameLabel": {
    ja: "表示名",
    en: "Display name",
  },
  "settings.userProvider.displayNamePlaceholder": {
    ja: "例: 自宅vLLM",
    en: "e.g. Home vLLM",
  },
  "settings.userProvider.idLabel": { ja: "プロバイダーID", en: "Provider ID" },
  "settings.userProvider.idPlaceholder": {
    ja: "例: home-vllm",
    en: "e.g. home-vllm",
  },
  "settings.userProvider.idHint": {
    ja: "モデル指定で使う識別子。例: home-vllm/gpt-4o。英数字と . _ - のみ使えます。",
    en: "Identifier for model references. Example: home-vllm/gpt-4o. Alphanumeric and . _ - only.",
  },
  "settings.userProvider.idHintEdit": {
    ja: "編集時は変更できません",
    en: "Cannot be changed while editing",
  },
  "settings.userProvider.baseUrlLabel": { ja: "Base URL", en: "Base URL" },
  "settings.userProvider.apiLabel": { ja: "API", en: "API" },
  "settings.userProvider.baseUrlHint": {
    ja: "OpenAI互換エンドポイントの基底URL。通常は /v1までです。",
    en: "Base URL for the OpenAI-compatible endpoint. Usually up to /v1.",
  },
  "settings.userProvider.apiDefaultHint": {
    ja: "モデルが未指定の場合の既定API",
    en: "Default API when no model specifies one",
  },
  "settings.userProvider.apiKeyLabel": { ja: "APIキー", en: "API key" },
  "settings.userProvider.apiKeyKeepBlank": {
    ja: "空欄なら現在の設定を維持",
    en: "Leave blank to keep the current value",
  },
  "settings.userProvider.apiKeyPlaceholderSet": {
    ja: "設定済み（上書き）",
    en: "Set (overwrite)",
  },
  "settings.userProvider.apiKeyPlaceholder": { ja: "APIキー", en: "API key" },
  "settings.userProvider.customHeaders": {
    ja: "カスタムヘッダー（任意）",
    en: "Custom headers (optional)",
  },
  "settings.userProvider.addHeader": { ja: "ヘッダーを追加", en: "Add header" },
  /** The trash icons in the editor: several identical buttons sit on one
   * page, so each names what it removes instead of reading as "button". */
  "settings.userProvider.removeModel": {
    ja: "このモデルを削除",
    en: "Remove this model",
  },
  "settings.userProvider.removeHeader": {
    ja: "このヘッダーを削除",
    en: "Remove this header",
  },
  "settings.userProvider.modelsLabel": {
    ja: "モデル（1つ以上）",
    en: "Models (one or more)",
  },
  "settings.userProvider.modelIdPlaceholder": {
    ja: "モデルID（例: gpt-4o）",
    en: "Model ID (e.g. gpt-4o)",
  },
  "settings.userProvider.modelNamePlaceholder": {
    ja: "表示名（任意）",
    en: "Display name (optional)",
  },
  "settings.userProvider.reasoningSupport": {
    ja: "推論モード対応",
    en: "Reasoning mode support",
  },
  "settings.userProvider.imageInputSupport": {
    ja: "画像入力対応",
    en: "Image input support",
  },
  "settings.userProvider.contextWindowPlaceholder": {
    ja: "コンテキストウィンドウ（トークン）",
    en: "Context window (tokens)",
  },
  "settings.userProvider.maxOutputPlaceholder": {
    ja: "最大出力（トークン）",
    en: "Max output (tokens)",
  },
  "settings.userProvider.addModel": { ja: "モデルを追加", en: "Add model" },
  "settings.userProvider.headerNamePlaceholder": {
    ja: "ヘッダー名",
    en: "Header name",
  },
  "settings.userProvider.headerValuePlaceholder": { ja: "値", en: "Value" },

  // --- model list -----------------------------------------------------------
  "settings.model.listTitle": { ja: "利用するモデル", en: "Available models" },
  "settings.model.listDescription": {
    ja: "ここで有効にしたモデルが、セッションの切り替え候補に出ます。",
    en: "Models enabled here are the ones you can switch a session to.",
  },
  "settings.model.searchPlaceholder": {
    ja: "モデルを検索…",
    en: "Search models…",
  },
  "settings.model.noProviders": {
    ja: "利用可能なプロバイダーが未設定です。「APIプロバイダー」からAPIキーを登録してください。",
    en: 'No providers configured. Register an API key in "API providers".',
  },
  "settings.model.noMatch": {
    ja: "該当するモデルがありません",
    en: "No matching models",
  },
  "settings.model.saveFailed": {
    ja: "保存に失敗しました: {error}",
    en: "Failed to save: {error}",
  },

  // --- model preference panel -----------------------------------------------
  "settings.model.defaultModel": {
    ja: "既定のモデル",
    en: "Default model",
  },
  "settings.model.defaultModelDesc": {
    ja: "新しい会話を始めるときに選ばれるモデル。",
    en: "The model chosen when a new conversation starts.",
  },
  "settings.model.fastModel": {
    ja: "サブタスクで使用するモデル",
    en: "Model for sub-tasks",
  },
  "settings.model.fastModelDesc": {
    ja: "タスク本体とは別に、要約やサブタスクなどの補助処理に使う高速・低コストなモデル。",
    en: "A fast, low-cost model for auxiliary work such as summaries and sub-tasks, separate from the main task.",
  },
  "settings.model.imageAnalysisModel": {
    ja: "画像分析モデル",
    en: "Image analysis model",
  },
  "settings.model.imageAnalysisModelDesc": {
    ja: "メインモデルが画像認識に未対応の場合に、代替として画像の解析・読み取りを担当するモデル。",
    en: "The model that analyzes and reads images when the main model cannot.",
  },
  /** The disclosure on the models page that holds everything besides the
   * default model: the auxiliary model rows and the compaction tuning. */
  "settings.model.details": { ja: "詳細", en: "Details" },
  // --- context compaction ---------------------------------------------------
  /** Heading of the compaction group in the settings dialog's model
   * section. */
  "settings.compaction.title": {
    ja: "コンテキスト圧縮",
    en: "Context compaction",
  },
  "settings.compaction.enabled": {
    ja: "自動圧縮",
    en: "Automatic compaction",
  },
  "settings.compaction.reservePercent": {
    ja: "出力時の予約コンテキスト長（ウィンドウ比 %）",
    en: "Context reserved for output (% of window)",
  },
  "settings.compaction.keepFullLog": {
    ja: "圧縮されたログを保持する",
    en: "Keep the compacted log",
  },
  "settings.compaction.keepFullLogDesc": {
    ja: "コンテキストが圧縮されたあとも、モデルへの入出力をデータベースに保持します。追加のストレージ容量を必要とします。",
    en: "Keeps the model's input and output in the database after the context is compacted. It needs extra storage.",
  },
  "settings.compaction.saveFailed": {
    ja: "圧縮の設定を保存できませんでした: {error}",
    en: "Failed to save the compaction settings: {error}",
  },
  "settings.compaction.invalidNumber": {
    ja: "0から100までの整数を入力してください。",
    en: "Enter a whole number between 0 and 100.",
  },

  "settings.model.loadFailed": {
    ja: "設定の読み込みに失敗しました: {error}",
    en: "Failed to load settings: {error}",
  },
  "settings.model.unset": { ja: "未設定", en: "Not set" },
  "settings.model.changeNamed": {
    ja: "「{name}」を変更",
    en: 'Change "{name}"',
  },
  "settings.model.clear": { ja: "解除", en: "Clear" },

  // --- mcp list -------------------------------------------------------------
  "settings.mcp.configConflict": {
    ja: "MCPの設定ファイルが外部で更新されています。現在の内容で上書き保存してもよろしいですか？",
    en: "The MCP config file has been updated externally. Overwrite with the current contents?",
  },
  "settings.mcp.deleteConfirm": {
    ja: "MCPサーバー「{name}」を削除しますか？",
    en: 'Delete MCP server "{name}"?',
  },
  "settings.mcp.noServers": {
    ja: "MCPサーバーが登録されていません。「サーバーを追加」から設定してください。",
    en: 'No MCP servers registered. Use "Add server" above to set one up.',
  },
  "settings.mcp.notStarted": { ja: "未起動", en: "Not started" },
  "settings.mcp.enabled": { ja: "有効", en: "Enabled" },

  // --- mcp detail -----------------------------------------------------------
  "settings.mcp.editTitle": { ja: "編集: {name}", en: "Edit: {name}" },
  "settings.mcp.nameLabel": { ja: "名前", en: "Name" },
  "settings.mcp.namePlaceholder": {
    ja: "例: filesystem",
    en: "e.g. filesystem",
  },
  "settings.mcp.nameEmpty": {
    ja: "名前を入力してください",
    en: "Enter a name",
  },
  "settings.mcp.nameExists": {
    ja: "サーバー「{name}」は既に存在します",
    en: 'Server "{name}" already exists',
  },
  "settings.mcp.typeLabel": { ja: "種類", en: "Type" },
  "settings.mcp.typeStdio": {
    ja: "stdio（子プロセス）",
    en: "stdio (child process)",
  },
  "settings.mcp.typeHttp": { ja: "HTTP (streamable)", en: "HTTP (streamable)" },
  "settings.mcp.commandLabel": { ja: "コマンド", en: "Command" },
  "settings.mcp.commandPlaceholder": { ja: "例: npx", en: "e.g. npx" },
  "settings.mcp.commandEmpty": {
    ja: "コマンドを入力してください",
    en: "Enter a command",
  },
  "settings.mcp.argsLabel": {
    ja: "引数（1行に1つ）",
    en: "Arguments (one per line)",
  },
  "settings.mcp.argsPlaceholder": {
    ja: "例:\n-y\n@modelcontextprotocol/server-filesystem\n.",
    en: "e.g.\n-y\n@modelcontextprotocol/server-filesystem\n.",
  },
  "settings.mcp.envPlaceholder": {
    ja: "例:\nTOKEN=abc123",
    en: "e.g.\nTOKEN=abc123",
  },
  "settings.mcp.headersPlaceholder": {
    ja: "例:\nAuthorization=Bearer x",
    en: "e.g.\nAuthorization=Bearer x",
  },
  "settings.mcp.cwdLabel": {
    ja: "作業ディレクトリ（省略可）",
    en: "Working directory (optional)",
  },
  "settings.mcp.cwdPlaceholder": {
    ja: "ワークスペース基準の相対パス",
    en: "Relative path from workspace root",
  },
  "settings.mcp.urlLabel": { ja: "URL", en: "URL" },
  "settings.mcp.urlEmpty": { ja: "URLを入力してください", en: "Enter a URL" },
  "settings.mcp.envLabel": {
    ja: "環境変数（key=value、1行に1つ、{var}展開可）",
    en: "Environment variables (key=value, one per line, {var} expansion supported)",
  },
  "settings.mcp.httpHeadersLabel": {
    ja: "HTTPヘッダー（key=value、1行に1つ）",
    en: "HTTP headers (key=value, one per line)",
  },

  // --- mcp connection test --------------------------------------------------
  "settings.mcp.test": { ja: "テスト", en: "Test" },
  "settings.mcp.testing": { ja: "テスト中…", en: "Testing…" },
  "settings.mcp.testRequired": {
    ja: "テストが成功すると追加できます",
    en: "Test the server to unlock adding",
  },
  "settings.mcp.testOk": {
    ja: "ツールを{count}件取得しました",
    en: "Fetched {count} tools",
  },
  "settings.mcp.testNoTools": {
    ja: "接続に成功しました。公開されているツールはありません。",
    en: "Connected. The server exposes no tools",
  },
  "settings.mcp.testFailed": {
    ja: "テストに失敗しました: {error}",
    en: "Test failed: {error}",
  },
  "settings.mcp.testStale": {
    ja: "内容が変更されています",
    en: "The form has changed",
  },
  "settings.mcp.testTools": { ja: "ツール一覧", en: "Tools" },

  // --- mcp OAuth sign-in ----------------------------------------------------
  /** Shown in place of a failure when the server asked for a sign-in. */
  "settings.mcp.authRequired": {
    ja: "このサーバーにはOAuth認証が必要です",
    en: "This server requires an OAuth sign-in",
  },
  "settings.mcp.authStart": {
    ja: "ブラウザで認証する",
    en: "Sign in with browser",
  },
  "settings.mcp.authWaiting": {
    ja: "ブラウザでの認証を待機中…",
    en: "Waiting for the browser sign-in…",
  },
  "settings.mcp.authStartFailed": {
    ja: "認証を開始できませんでした",
    en: "Could not start the sign-in",
  },
  "settings.mcp.authNeeded": {
    ja: "要認証",
    en: "Sign-in",
  },
  "settings.mcp.authHint": {
    ja: "ブラウザでツールを認証",
    en: "Authorize tools in your browser",
  },
  /** For WebViews that cannot open a window (the desktop app): the user
   * copies the sign-in URL and opens it in their own browser. */
  "settings.mcp.authCopyUrl": {
    ja: "認証URLをコピー",
    en: "Copy the sign-in URL",
  },
  "settings.mcp.authCopied": {
    ja: "コピーしました",
    en: "Copied",
  },

  // --- connection list -------------------------------------------------------
  "settings.connection.test": { ja: "テスト", en: "Test" },
  "settings.connection.currentDisplay": {
    ja: "表示中のサーバー:",
    en: "Currently showing:",
  },
  "settings.connection.localServer": {
    ja: "ローカルサーバー",
    en: "Local server",
  },
  "settings.connection.thisServer": {
    ja: "このサーバー（{origin}）",
    en: "This server ({origin})",
  },
  "settings.connection.localServerDesc": {
    ja: "このPCで稼働しているサーバーに接続します",
    en: "Connect to the server running locally on this PC",
  },
  "settings.connection.view": { ja: "表示", en: "View" },
  "settings.connection.activeTag": { ja: "表示中", en: "Viewing" },
  "settings.connection.deleteConfirm": {
    ja: "このサーバーを削除しますか？",
    en: "Delete this server?",
  },
  "settings.connection.testSuccess": {
    ja: "サーバーへの接続に成功しました",
    en: "Connection succeeded",
  },
  "settings.connection.unreachable": {
    ja: "サーバーに到達できません: {url}",
    en: "Cannot reach server: {url}",
  },
  "settings.connection.testOk": { ja: "接続OK", en: "Connection OK" },
  /** The address field of a connection. The setup's connection screen uses
   * the same label, so one word is not spelled twice. */
  "settings.connection.urlLabel": { ja: "URL", en: "URL" },
  "settings.connection.serverNameLabel": { ja: "名前", en: "Name" },
  "settings.connection.serverNamePlaceholder": {
    ja: "例: 自宅サーバー",
    en: "e.g. Home server",
  },
  "settings.connection.tokenLabel": {
    ja: "認証トークン",
    en: "Auth token",
  },
  /** Scheme rule of the URL field. The desktop shell can only connect to
   * http:// (a LAN/Tailscale address served directly) and https:// (a
   * TLS-terminating front end such as `tailscale serve`); anything else is
   * refused before a request leaves the app. */
  "settings.connection.badUrl": {
    ja: "URLはhttp:// またはhttps:// で始まる必要があります",
    en: "The URL must start with http:// or https://",
  },
  "settings.connection.urlHint": {
    ja: "接続先サーバーのURLを入力してください。http:// かhttps:// で始まるもの。",
    en: "Enter the server URL, starting with http:// or https://.",
  },
  "settings.connection.unnamed": { ja: "（無名）", en: "(unnamed)" },
  /** The row of a registry entry is the way into its fields: the first opens
   * them, the second folds them back. */
  "settings.connection.editEntry": {
    ja: "この接続先を編集",
    en: "Edit this server",
  },
  "settings.connection.foldEntry": {
    ja: "入力を閉じる",
    en: "Hide the fields",
  },
  /** Desktop only: the choice here is written to the shell's settings and
   * restored on the next launch. */
  "settings.connection.persistedNote": {
    ja: "次回の起動時もこの接続先を使います。",
    en: "This server is used on the next launch too.",
  },

  // --- command safety panel --------------------------------------------------
  "settings.security.title": {
    ja: "コマンド安全チェック",
    en: "Command safety check",
  },
  "settings.security.description": {
    ja: "コマンドを実行する前に、危険な操作が含まれていないか安全性を自動で確認します。",
    en: "Automatically checks commands for dangerous operations before execution.",
  },
  "settings.security.tooltip": {
    ja: "コマンド実行前に安全性を自動で検証します。一度承認されたコマンドは次回以降そのまま実行され、危険と判定されたコマンドは実行がブロックされます。",
    en: "Automatically verifies the safety of commands before execution. Approved commands run automatically next time, while dangerous commands are blocked.",
  },
  "settings.security.fastModelMissing": {
    ja: "サブタスクで使用するモデルが未設定です。有効にするには「モデル設定」で「サブタスクで使用するモデル」を指定してください。",
    en: 'No model for sub-tasks is configured. Set "Model for sub-tasks" in "Models" to enable this.',
  },
  "settings.security.approvedCommands": {
    ja: "承認済みコマンド",
    en: "Approved commands",
  },
  "settings.security.approvedNone": {
    ja: "承認済みのコマンドはありません",
    en: "No approved commands",
  },
  "settings.security.deleteAll": { ja: "すべて削除", en: "Delete all" },
  "settings.security.operationFailed": {
    ja: "操作に失敗しました: {error}",
    en: "Operation failed: {error}",
  },
  "settings.security.deleteApprovalAria": {
    ja: "承認を削除",
    en: "Remove approval",
  },

  // --- web search panel ------------------------------------------------------
  /** A section heading under the プロバイダー category (not a category of its
   * own: the nav key `settings.nav.providers` names the category). */
  "settings.webSearch.title": { ja: "Web検索", en: "Web search" },
  "settings.webSearch.description": {
    ja: "エージェントがWeb検索やページの閲覧に使用する検索プロバイダーを設定します。",
    en: "Configure the search provider used by the agent for web searches and fetching pages.",
  },
  "settings.webSearch.empty": {
    ja: "検索プロバイダーが登録されていません。",
    en: "No search provider is configured yet.",
  },
  "settings.webSearch.makeDefault": { ja: "既定にする", en: "Make default" },
  "settings.webSearch.defaultBadge": { ja: "既定", en: "Default" },
  "settings.webSearch.noDefault": {
    ja: "既定のプロバイダーが未設定です。エージェントはWeb検索ツールを使用できません。",
    en: "No default provider: the agent has no web tools.",
  },
  "settings.webSearch.useFetchApi": {
    ja: "ページ取得: プロバイダーのAPI",
    en: "Page fetch: provider API",
  },
  "settings.webSearch.useFetchDirect": {
    ja: "ページ取得: 直接取得",
    en: "Page fetch: direct fetch",
  },
  "settings.webSearch.keySet": { ja: "APIキー登録済み", en: "API key set" },
  "settings.webSearch.keyUnset": { ja: "APIキー未登録", en: "No API key" },
  "settings.webSearch.remove": { ja: "削除", en: "Remove" },
  "settings.webSearch.removeConfirm": {
    ja: "「{name}」を削除しますか？",
    en: "Remove {name}?",
  },
  "settings.webSearch.loadFailed": {
    ja: "Web検索の設定を読み込めませんでした: {error}",
    en: "Could not load the web-search setting: {error}",
  },

  // --- web search dialog -----------------------------------------------------
  "settings.webSearch.form.addTitle": {
    ja: "検索プロバイダーを追加",
    en: "Add a search provider",
  },
  "settings.webSearch.form.editTitle": {
    ja: "APIキーを変更",
    en: "Change the API key",
  },
  "settings.webSearch.form.add": {
    ja: "検索プロバイダーを追加",
    en: "Add the search provider",
  },
  "settings.webSearch.form.provider": { ja: "プロバイダー", en: "Provider" },
  "settings.webSearch.form.apiKey": { ja: "APIキー", en: "API key" },
  "settings.webSearch.form.apiKeyKeep": {
    ja: "空欄のまま保存すると、登録済みのAPIキーを維持します。",
    en: "Leave it empty to keep the stored key.",
  },
  "settings.webSearch.form.check": { ja: "接続を確認", en: "Check" },
  "settings.webSearch.form.checking": { ja: "確認中…", en: "Checking…" },
  "settings.webSearch.form.checked": {
    ja: "検索に成功しました。{count}件見つかりました。追加できます。",
    en: "Search worked. {count} result(s) found. You can add it now.",
  },
  "settings.webSearch.form.failed": {
    ja: "検索に失敗しました: {detail}",
    en: "The search failed: {detail}",
  },
  "settings.webSearch.form.needKey": {
    ja: "追加する前に、「接続を確認」で検索できることを確認してください。",
    en: "Check that this key searches before adding it.",
  },
  "settings.webSearch.form.noProviders": {
    ja: "追加できるプロバイダーがありません。",
    en: "Every provider is already configured.",
  },

  // --- computer use panel ----------------------------------------------------
  /** The switch's own label. The page above it already names the feature,
   * so this says what the switch does rather than repeating the title. */
  "settings.computerUse.title": {
    ja: "このマシンの画面を操作させる",
    en: "Let the agent use this machine's screen",
  },
  "settings.computerUse.description": {
    ja: "エージェントが画面を見て操作できるようにします。",
    en: "Lets the agent see and control the screen.",
  },
  "settings.computerUse.tooltip": {
    ja: "Computer Use: エージェントが実画面を撮影し、クリックや入力を行います。既定は無効です。",
    en: "Computer use: the agent captures the real screen and clicks or types on it. Disabled by default.",
  },
  "settings.computerUse.operationFailed": {
    ja: "変更に失敗しました: {error}",
    en: "Failed to change: {error}",
  },
  // --- experimental panel ----------------------------------------------------
  /** The page's own note, above its rows. It is the one thing a reader must
   * know before flipping anything here. */
  "settings.experimental.description": {
    ja: "試験中の機能です。予告なく変わるか、無くなる場合があります。",
    en: "Features under test. They may change or disappear without notice.",
  },
  /** The switch that turns the scripting tool call feature on: the model gets
   * one tool and calls every other tool from inside a short script. */
  "settings.experimental.codeExecution.title": {
    ja: "Scripting tool call",
    en: "Scripting tool call",
  },
  "settings.experimental.codeExecution.description": {
    ja: "モデルに渡すツールを1つにまとめ、ファイルやシェル、MCPのツールを短いスクリプトから呼ばせます。初期ツールの型はプロンプトに載せ、残りは検索で見つけます。",
    en: "Gives the model one tool and lets a short script call files, the shell and MCP tools. Initial tools are declared in the prompt; the rest are found by search.",
  },
  "settings.experimental.codeExecution.tooltip": {
    ja: "Scripting tool call: モデルがJavaScriptを書き、その中からツールを呼びます。既定は無効です。",
    en: "Scripting tool call: the model writes JavaScript and calls tools from it. Disabled by default.",
  },
  "settings.experimental.codeExecution.operationFailed": {
    ja: "変更に失敗しました: {error}",
    en: "Failed to change: {error}",
  },
  "settings.mcp.toolCount": { ja: "{count}個のツール", en: "{count} tools" },
  "settings.provider.oauth": { ja: "OAuth連携", en: "OAuth" },
  /** Section heading of the AI providers inside the プロバイダー category
   * (the web-search providers are listed under it on the same screen). */
  "settings.provider.aiTitle": {
    ja: "AIプロバイダー",
    en: "AI providers",
  },
} satisfies Record<string, LocalizedText>;
