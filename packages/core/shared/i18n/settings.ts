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
  "settings.dialog.title": { ja: "設定", en: "Settings" },
  "settings.nav.general": { ja: "一般", en: "General" },
  "settings.nav.appearance": { ja: "外観", en: "Appearance" },
  "settings.nav.personalize": { ja: "カスタマイズ", en: "Personalization" },
  "settings.nav.servers": { ja: "接続先サーバー", en: "Servers" },
  "settings.nav.providers": { ja: "APIプロバイダー", en: "API providers" },
  "settings.nav.models": { ja: "モデル設定", en: "Models" },
  "settings.nav.mcp": { ja: "MCPサーバー", en: "MCP servers" },
  "settings.nav.security": { ja: "セキュリティ", en: "Security" },

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
    ja: "画面の表示言語と、新しいセッションが回答する言語を切り替えます。",
    en: "Switch the display language and the language new sessions answer in.",
  },
  "settings.language.note": {
    ja:
      "変更は新しいセッションから反映されます。開始済みのセッションは、開始時の言語のままです。",
    en:
      "The change applies to new sessions. Sessions already started keep the language they began in.",
  },
  "settings.language.option.ja": { ja: "日本語", en: "Japanese" },
  "settings.language.option.en": { ja: "English", en: "English" },
  "settings.language.saveFailed": {
    ja: "言語設定を保存できませんでした: {error}",
    en: "Could not save the language setting: {error}",
  },

  // --- general panel --------------------------------------------------------
  "settings.general.autoUpdateUnavailable": {
    ja:
      "この環境では自動アップデートを利用できません。デスクトップアプリまたは正規パッケージからご利用ください。",
    en:
      "Auto-update is not available in this environment. Please use the desktop app or an official package.",
  },
  "settings.general.checkingUpdate": {
    ja: "アップデートを確認中…",
    en: "Checking for updates…",
  },
  "settings.general.appliedRestartDesktop": {
    ja: "v{version} を適用しました。再起動すると有効になります。",
    en: "v{version} applied. It will take effect after a restart.",
  },
  "settings.general.appliedRestartSystemd": {
    ja:
      "v{version} を適用しました。再起動すると有効になります（systemd が新しいバージョンで起動します）。",
    en:
      "v{version} applied. It will take effect after a restart (systemd will start the new version).",
  },
  "settings.general.appliedNextStart": {
    ja: "v{version} を適用しました。次回の起動で有効になります。",
    en: "v{version} applied. It will take effect on the next start.",
  },
  "settings.general.readyToInstall": {
    ja: "v{version} のアップデートの準備ができました。",
    en: "Update to v{version} is ready to install.",
  },
  "settings.general.readyToInstallServer": {
    ja: "v{version} のアップデートをインストールできます。",
    en: "Update to v{version} is ready to install on the server.",
  },
  "settings.general.versionAvailable": {
    ja: "v{version} が利用可能です。",
    en: "v{version} is available.",
  },
  "settings.general.latestVersion": {
    ja: "最新バージョンです。",
    en: "You are on the latest version.",
  },
  "settings.general.serverInfo": { ja: "サーバー情報", en: "Server info" },
  "settings.general.appInfo": { ja: "アプリ情報", en: "App info" },
  "settings.general.autoUpdate": { ja: "自動アップデート", en: "Auto-update" },
  "settings.general.autoUpdateDesc": {
    ja:
      "アプリ起動時および定期的に更新を確認し、バックグラウンドで最新版をダウンロードします。",
    en:
      "Checks for updates on launch and periodically, downloading the latest version in the background.",
  },
  "settings.general.autoUpdateDescServer": {
    ja:
      "アプリ起動時および定期的に更新を確認し、バックグラウンドで最新版をダウンロードします。次回起動時に自動適用されます。",
    en:
      "Checks for updates on launch and periodically, downloading the latest version in the background. Applied automatically on the next restart.",
  },
  "settings.general.autoRestart": {
    ja: "適用時に自動で再起動",
    en: "Auto-restart on apply",
  },
  "settings.general.autoRestartDesc": {
    ja:
      "常時稼働サーバー向けの設定です。無効にした場合は次回起動時に反映されます（※再起動時は実行中のセッションが停止します）。",
    en:
      "For always-on servers. When disabled, changes take effect on the next start (running sessions will be interrupted on restart).",
  },
  "settings.general.downloading": { ja: "ダウンロード中", en: "Downloading" },
  "settings.general.checkForUpdate": {
    ja: "アップデートを確認",
    en: "Check for updates",
  },
  "settings.general.restart": { ja: "再起動", en: "Restart" },
  "settings.general.install": { ja: "インストール", en: "Install" },
  "settings.general.download": { ja: "ダウンロード", en: "Download" },
  "settings.general.installNote": {
    ja: "インストールするとアプリが再起動します。",
    en: "The app will restart after installation.",
  },
  "settings.general.installNoteServer": {
    ja: "インストールすると、次回の起動で新しいバージョンが有効になります。",
    en:
      "After installation, the new version will take effect on the next start.",
  },
  "settings.general.autoRestartDisabled": {
    ja:
      "このサーバーは自動再起動が無効です（LUMISCA_UPDATE_RESTART=none）。監視側で再起動してください。",
    en:
      "Auto-restart is disabled on this server (LUMISCA_UPDATE_RESTART=none). Please restart from the supervisor.",
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

  // --- personalize panel ----------------------------------------------------
  "settings.personalize.customInstructions": {
    ja: "カスタム指示",
    en: "Custom instructions",
  },
  "settings.personalize.customInstructionsPlaceholder": {
    ja:
      "例:\n- 回答は日本語で記述してください。\n- 変更後は必ずテストを実行してください。",
    en:
      "Example:\n- Write your responses in English.\n- Always run tests after making changes.",
  },
  "settings.personalize.saving": { ja: "保存中…", en: "Saving…" },
  "settings.personalize.saved": { ja: "保存しました", en: "Saved" },
  "settings.personalize.savedPrompts": {
    ja: "保存済みプロンプト",
    en: "Saved prompts",
  },
  "settings.personalize.add": { ja: "追加", en: "Add" },
  "settings.personalize.savedPromptsDesc": {
    ja: "コマンドで素早く呼び出せる定型文（プロンプト）を登録します。",
    en:
      "Register prompt snippets that can be quickly recalled with the /prompt command.",
  },
  "settings.personalize.promptsLoadFailed": {
    ja: "プロンプトを読み込めませんでした: {error}",
    en: "Could not load prompts: {error}",
  },
  "settings.personalize.noPrompts": {
    ja:
      "保存されたプロンプトはありません。右上の「追加」ボタンから登録してください。",
    en: 'No saved prompts. Use the "Add" button to register one.',
  },
  "settings.personalize.promptDeleteConfirm": {
    ja: 'プロンプト "{name}" を削除しますか？',
    en: 'Delete prompt "{name}"?',
  },
  "settings.personalize.idLabel": { ja: "識別子", en: "ID" },
  "settings.personalize.idPlaceholder": {
    ja: "例: translate",
    en: "e.g. translate",
  },
  "settings.personalize.idEmpty": {
    ja: "識別子を入力してください",
    en: "Enter an ID",
  },
  "settings.personalize.idInvalidChars": {
    ja: "識別子に使用できる文字は半角英数字および記号「.」「_」「-」のみです",
    en:
      'The ID may only contain ASCII letters, digits, and the symbols ".", "_", "-"',
  },
  "settings.personalize.displayLabel": { ja: "表示名", en: "Display name" },
  "settings.personalize.displayPlaceholder": {
    ja: "例: 翻訳",
    en: "e.g. Translate",
  },
  "settings.personalize.displayEmpty": {
    ja: "表示名を入力してください",
    en: "Enter a display name",
  },
  "settings.personalize.promptLabel": { ja: "プロンプト文", en: "Prompt text" },
  "settings.personalize.promptPlaceholder": {
    ja: "例: 次のテキストを日本語に翻訳してください:\n\n{ここにテキスト}",
    en: "e.g. Translate the following text into English:\n\n{text here}",
  },
  "settings.personalize.promptEmpty": {
    ja: "プロンプト文を入力してください",
    en: "Enter prompt text",
  },
  "settings.personalize.update": { ja: "更新", en: "Update" },

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
    ja:
      "登録されたプロバイダーがありません。「プロバイダーを追加」ボタンから設定してください。",
    en: 'No providers registered. Use the "Add provider" button to set one up.',
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
    ja: "OAuth ログイン（サブスクリプション契約）",
    en: "OAuth login (subscription)",
  },
  "settings.provider.logout": { ja: "ログアウト", en: "Logout" },
  "settings.provider.login": { ja: "ログイン", en: "Login" },
  "settings.provider.relogin": { ja: "再ログイン", en: "Re-login" },
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
    ja:
      "表示された認証画面で上記の確認コードを入力し、連携を承認してください。",
    en:
      "Enter the verification code shown above in the authentication screen and approve the connection.",
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
    ja: 'プロバイダー "{name}" を削除しますか？',
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
    ja: "カスタム OpenAI 互換プロバイダーを追加",
    en: "Add custom OpenAI-compatible provider",
  },
  "settings.provider.send": { ja: "送信", en: "Send" },
  "settings.provider.edit": { ja: "編集", en: "Edit" },
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
    ja: "例: 自宅 vLLM",
    en: "e.g. Home vLLM",
  },
  "settings.userProvider.idLabel": { ja: "プロバイダーID", en: "Provider ID" },
  "settings.userProvider.idPlaceholder": {
    ja: "例: home-vllm",
    en: "e.g. home-vllm",
  },
  "settings.userProvider.idHint": {
    ja: "モデル指定で使う識別子（例: home-vllm/gpt-4o）。英数字・. _ - のみ",
    en:
      "Identifier for model references (e.g. home-vllm/gpt-4o). Alphanumeric, . _ - only",
  },
  "settings.userProvider.idHintEdit": {
    ja: "編集時は変更できません",
    en: "Cannot be changed while editing",
  },
  "settings.userProvider.baseUrlLabel": { ja: "Base URL", en: "Base URL" },
  "settings.userProvider.baseUrlHint": {
    ja: "OpenAI 互換エンドポイントの基底 URL（通常は /v1 まで）",
    en: "Base URL for the OpenAI-compatible endpoint (usually up to /v1)",
  },
  "settings.userProvider.apiDefaultHint": {
    ja: "モデルが未指定の場合の既定 API",
    en: "Default API when no model specifies one",
  },
  "settings.userProvider.apiKeyLabel": { ja: "APIキー", en: "API key" },
  "settings.userProvider.apiKeyKeepBlank": {
    ja: "（空白で維持）",
    en: "(leave blank to keep)",
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
  "settings.model.searchPlaceholder": {
    ja: "モデルを検索…",
    en: "Search models…",
  },
  "settings.model.noProviders": {
    ja:
      "利用可能なプロバイダーが未設定です。「APIプロバイダー」からAPIキーを登録してください。",
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
  "settings.model.fastModel": { ja: "高速モデル", en: "Fast model" },
  "settings.model.fastModelDesc": {
    ja:
      "タスク本体とは別に、高速・低コストな補助処理（要約・サブタスクなど）で使用するモデルです。",
    en:
      "A fast, low-cost model used for auxiliary tasks (summarization, sub-tasks, etc.), separate from the main task.",
  },
  "settings.model.imageAnalysisModel": {
    ja: "画像分析モデル",
    en: "Image analysis model",
  },
  "settings.model.imageAnalysisModelDesc": {
    ja:
      "メインモデルが画像認識に未対応の場合に、代替として画像の解析・読み取りを担当するモデルです。",
    en:
      "When the main model does not support image recognition, this model handles image analysis as a fallback.",
  },
  "settings.model.loadFailed": {
    ja: "設定の読み込みに失敗しました: {error}",
    en: "Failed to load settings: {error}",
  },
  "settings.model.unset": { ja: "未設定", en: "Not set" },

  // --- mcp list -------------------------------------------------------------
  "settings.mcp.configConflict": {
    ja:
      "MCPの設定ファイルが外部で更新されています。現在の内容で上書き保存してもよろしいですか？",
    en:
      "The MCP config file has been updated externally. Overwrite with the current contents?",
  },
  "settings.mcp.deleteConfirm": {
    ja: "MCPサーバー「{name}」を削除しますか？",
    en: 'Delete MCP server "{name}"?',
  },
  "settings.mcp.noServers": {
    ja:
      "MCPサーバーが登録されていません。下の「サーバーを追加」から設定してください。",
    en: 'No MCP servers registered. Use "Add server" below to set one up.',
  },
  "settings.mcp.error": { ja: "エラー", en: "Error" },
  "settings.mcp.notStarted": { ja: "未起動", en: "Not started" },
  "settings.mcp.enabled": { ja: "有効", en: "Enabled" },
  "settings.mcp.addServer": { ja: "サーバーを追加", en: "Add server" },

  // --- mcp detail -----------------------------------------------------------
  "settings.mcp.editTitle": { ja: "編集: {name}", en: "Edit: {name}" },
  "settings.mcp.addTitle": { ja: "サーバーを追加", en: "Add server" },
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
  "settings.mcp.urlEmpty": { ja: "URL を入力してください", en: "Enter a URL" },
  "settings.mcp.envLabel": {
    ja: "環境変数（key=value、1行に1つ、{var} 展開可）",
    en:
      "Environment variables (key=value, one per line, {var} expansion supported)",
  },
  "settings.mcp.httpHeadersLabel": {
    ja: "HTTPヘッダー（key=value、1行に1つ）",
    en: "HTTP headers (key=value, one per line)",
  },
  "settings.mcp.exampleArgs": {
    ja: "例:\n-y\n@modelcontextprotocol/server-filesystem\n.",
    en: "Example:\n-y\n@modelcontextprotocol/server-filesystem\n.",
  },
  "settings.mcp.exampleEnv": {
    ja: "例:\nTOKEN=abc123",
    en: "Example:\nTOKEN=abc123",
  },
  "settings.mcp.exampleHeaders": {
    ja: "例:\nAuthorization=Bearer x",
    en: "Example:\nAuthorization=Bearer x",
  },

  // --- connection list -------------------------------------------------------
  /** Panel heading (the settings nav reuses `settings.nav.servers`). */
  "settings.connection.title": { ja: "接続先サーバー", en: "Servers" },
  "settings.connection.addServer": { ja: "サーバーを追加", en: "Add server" },
  "settings.connection.test": { ja: "テスト", en: "Test" },
  "settings.connection.currentDisplay": {
    ja: "現在の表示:",
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
    ja: "ローカル（このPC）で稼働しているサーバーに接続します",
    en: "Connect to the server running locally on this PC",
  },
  "settings.connection.view": { ja: "表示", en: "View" },
  "settings.connection.activeTag": { ja: "表示中", en: "Viewing" },
  "settings.connection.deleteConfirm": {
    ja: "このサーバーを削除しますか？",
    en: "Delete this server?",
  },
  "settings.connection.testSuccess": {
    ja: "疎通確認に成功しました（認証トークンは接続時に検証されます）",
    en: "Connection test succeeded (auth token is verified on connect)",
  },
  "settings.connection.unreachable": {
    ja: "サーバーに到達できません: {url}",
    en: "Cannot reach server: {url}",
  },
  "settings.connection.testOk": { ja: "接続OK", en: "Connection OK" },
  "settings.connection.serverNameLabel": { ja: "名前", en: "Name" },
  "settings.connection.serverNamePlaceholder": {
    ja: "例: 自宅サーバー",
    en: "e.g. Home server",
  },
  "settings.connection.tokenLabel": {
    ja: "トークン（LUMISCA_TOKEN と同じ値）",
    en: "Token (same value as LUMISCA_TOKEN)",
  },
  "settings.connection.unnamed": { ja: "（無名）", en: "(unnamed)" },

  // --- command safety panel --------------------------------------------------
  "settings.security.title": {
    ja: "コマンド安全チェック",
    en: "Command safety check",
  },
  "settings.security.description": {
    ja: "bash / eval / async_bash を実行するたびに高速モデルで判定します。",
    en:
      "Evaluates each bash / eval / async_bash command with the fast model before execution.",
  },
  "settings.security.tooltip": {
    ja:
      "シェルコマンド（bash等）の実行前に、AIが危険な操作を含んでいないか安全性を自動で検証します。安全と判定されたコマンドは承認リストに記録され、次回からは判定なしで実行されます。危険と判定されたコマンドのほか、判定できなかったコマンド（判定が失敗・タイムアウトした場合）も実行されず、停止理由がエージェントに返されます。",
    en:
      "Before executing shell commands (bash etc.), the AI automatically checks whether they contain dangerous operations. Commands judged safe are recorded in the approval list and run without checking next time. Commands judged dangerous, as well as those that could not be judged (failure, timeout), are blocked and the reason is reported to the agent.",
  },
  "settings.security.fastModelMissing": {
    ja:
      "【重要】高速モデルが未設定です。このまま有効にすると、すべてのコマンドが安全確認不可として実行拒否されます。先に「モデル設定」より「高速モデル」を指定してください。",
    en:
      '[Important] No fast model is set. If enabled without one, all commands will be blocked as unverifiable. Set a "Fast model" in "Models" first.',
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
} satisfies Record<string, LocalizedText>;
