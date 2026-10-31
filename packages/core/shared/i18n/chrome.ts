import type { LocalizedText } from "./types.ts";

/**
 * Messages of the app chrome: the title bar and tab bar, the app menu, the
 * banners (update, server down) and the pickers that are opened from them
 * (model, workspace, folder, peer).
 *
 * Keys are `chrome.<surface>.<element>`; the shared actions (close, back,
 * …) live in `common.ts`.
 */
export const chrome = {
  // --- title bar -----------------------------------------------------------
  "chrome.titleBar.minimize": { ja: "最小化", en: "Minimize" },
  "chrome.titleBar.maximize": { ja: "最大化", en: "Maximize" },
  "chrome.titleBar.restore": {
    ja: "元のサイズに戻す",
    en: "Restore",
  },
  "chrome.titleBar.close": { ja: "閉じる", en: "Close" },

  // --- connection picker (which server this window shows) ------------------
  "chrome.connections.local": {
    ja: "ローカルサーバー",
    en: "Local server",
  },
  "chrome.connections.current": {
    ja: "接続先: {name}",
    en: "Connected to: {name}",
  },
  "chrome.connections.empty": {
    ja: "登録された接続先はありません",
    en: "No server is registered",
  },
  "chrome.connections.manage": {
    ja: "接続先を管理",
    en: "Manage servers",
  },
  "chrome.connections.add": {
    ja: "サーバーを追加",
    en: "Add a server",
  },

  // --- tab bar -------------------------------------------------------------
  "chrome.tabBar.label": { ja: "セッションタブ", en: "Session tabs" },
  "chrome.tabBar.newSession": {
    ja: "新しいセッション",
    en: "New session",
  },
  "chrome.tabBar.processing": { ja: "処理中", en: "Processing" },
  "chrome.tabBar.closeTab": { ja: "タブを閉じる", en: "Close tab" },
  "chrome.tabBar.closeTabNamed": {
    ja: "「{name}」を閉じる",
    en: 'Close "{name}"',
  },
  "chrome.tabBar.openNewTab": {
    ja: "新しいタブを開く",
    en: "Open new tab",
  },
  "chrome.tabBar.closeOtherTabs": {
    ja: "他のタブを閉じる",
    en: "Close other tabs",
  },
  "chrome.tabBar.closeAllRight": {
    ja: "右側のタブをすべて閉じる",
    en: "Close all tabs to the right",
  },
  "chrome.tabBar.closeAllLeft": {
    ja: "左側のタブをすべて閉じる",
    en: "Close all tabs to the left",
  },
  "chrome.tabBar.closeAllOthers": {
    ja: "他のタブをすべて閉じる",
    en: "Close all other tabs",
  },

  // --- close confirmation (running tab) ------------------------------------
  "chrome.tabClose.title": {
    ja: "実行中のタブを閉じますか？",
    en: "Close a running tab?",
  },
  "chrome.tabClose.body": {
    ja:
      "「{name}」は実行中です。閉じると実行は中止され、バックグラウンドコマンドとサブエージェントも停止します。",
    en:
      '"{name}" is running. Closing it stops the run, along with its background commands and sub-agents.',
  },
  "chrome.tabClose.bodyMany": {
    ja:
      "対象のタブのうち {count} 件が実行中です。閉じるとそれらの実行は中止され、バックグラウンドコマンドとサブエージェントも停止します。",
    en:
      "The close includes {count} running tabs. Closing stops their runs, their background commands and their sub-agents.",
  },
  "chrome.tabClose.keepRunningNote": {
    ja:
      "「実行を続けて閉じる」を選択した場合、セッションはサーバー側でバックグラウンド実行を継続します（タブは閉じられますが、セッション履歴から再度開くことができます）。",
    en:
      'With "Close and keep running", the running sessions continue on the server (the other tabs still close; reopen them from the session history).',
  },
  "chrome.tabClose.stop": { ja: "中止して閉じる", en: "Stop and close" },
  "chrome.tabClose.keepRunning": {
    ja: "実行を続けて閉じる",
    en: "Close and keep running",
  },

  // --- app menu ------------------------------------------------------------
  "chrome.appMenu.title": {
    ja: "アプリケーションメニュー",
    en: "Application menu",
  },
  "chrome.appMenu.newTab": { ja: "新しいタブ", en: "New tab" },
  "chrome.appMenu.switchMode": {
    ja: "モードを切り替える",
    en: "Switch mode",
  },
  "chrome.appMenu.history": {
    ja: "セッション履歴",
    en: "Session history",
  },
  "chrome.appMenu.quit": { ja: "終了", en: "Quit" },

  // --- update banner -------------------------------------------------------
  "chrome.update.downloaded": {
    ja: "Lumisca v{version} をダウンロードしました。",
    en: "Lumisca v{version} has been downloaded.",
  },
  "chrome.update.ready": {
    ja: "新しいバージョン（v{version}）にアップデートできます。",
    en: "An update to v{version} is available.",
  },
  "chrome.update.restartNote": {
    ja: "再起動すると適用されます（※実行中のセッションは停止します）。",
    en: "Restart to apply (running sessions will be stopped).",
  },
  "chrome.update.systemdNote": {
    ja: "サービスの再起動後に新しいバージョンが適用されます。",
    en: "The service will start with the new version after restarting.",
  },
  "chrome.update.nextStart": {
    ja: "次回の起動時に適用されます。",
    en: "Will apply on the next launch.",
  },
  "chrome.update.installRestart": {
    ja: "インストールするとアプリが再起動します。",
    en: "Installing will restart the app.",
  },
  "chrome.update.restartNow": { ja: "今すぐ再起動", en: "Restart now" },
  "chrome.update.installNow": {
    ja: "今すぐインストール",
    en: "Install now",
  },
  "chrome.update.dismiss": { ja: "閉じる", en: "Dismiss" },

  // --- server down banner --------------------------------------------------
  "chrome.serverDown.crashed": {
    ja: "ローカルサーバーが終了しました（終了コード: {code}）",
    en: "The local server exited (exit code: {code})",
  },
  "chrome.serverDown.crashedNoCode": {
    ja: "ローカルサーバーが終了しました",
    en: "The local server exited",
  },
  "chrome.serverDown.hung": {
    ja: "ローカルサーバーから応答がありません（応答停止の可能性）",
    en: "The local server is not responding (possibly hung)",
  },
  "chrome.serverDown.unreachable": {
    ja: "ローカルサーバーに接続できません",
    en: "The local server is unreachable",
  },
  "chrome.serverDown.note": {
    ja:
      "作業データは保持されています。サーバーを再起動すると作業を再開できます。",
    en: "Your work data is preserved. Restart the server to resume.",
  },
  "chrome.serverDown.restartFailed": {
    ja: "再起動に失敗しました: {error}",
    en: "Restart failed: {error}",
  },
  "chrome.serverDown.noLog": {
    ja: "サーバーログはありません",
    en: "No server log available",
  },
  "chrome.serverDown.restarting": {
    ja: "再起動中…",
    en: "Restarting…",
  },
  "chrome.serverDown.restart": {
    ja: "サーバーを再起動",
    en: "Restart server",
  },
  "chrome.serverDown.showLog": { ja: "ログを表示", en: "Show log" },
  "chrome.serverDown.hideLog": { ja: "ログを非表示", en: "Hide log" },
  "chrome.serverDown.copyLogTitle": {
    ja: "サーバーログをクリップボードにコピー",
    en: "Copy server log to clipboard",
  },
  "chrome.serverDown.copyLog": {
    ja: "ログをクリップボードにコピー",
    en: "Copy log to clipboard",
  },

  // --- model picker --------------------------------------------------------
  "chrome.modelPicker.providersError": {
    ja: "プロバイダー一覧を取得できませんでした（サーバーに接続できません）",
    en: "Could not fetch the provider list (cannot reach the server)",
  },
  "chrome.modelPicker.modelsError": {
    ja: "モデル一覧を取得できませんでした",
    en: "Could not fetch the model list",
  },
  "chrome.modelPicker.noProviders": {
    ja:
      "利用可能なプロバイダーが未設定です。設定画面でAPIキーを登録してください。",
    en: "No providers are configured. Register your API keys in the settings.",
  },
  "chrome.modelPicker.settingsLink": {
    ja: "設定画面",
    en: "Settings",
  },
  "chrome.modelPicker.search": {
    ja: "モデルを検索…",
    en: "Search models…",
  },
  "chrome.modelPicker.reasoning": {
    ja: "推論モデル（Reasoning）",
    en: "Reasoning model",
  },
  "chrome.modelPicker.noImageModels": {
    ja: "画像認識に対応したモデルがありません",
    en: "No models support image input",
  },
  "chrome.modelPicker.noEnabledModels": {
    ja: "利用可能なモデルがありません（設定画面でモデルを有効化してください）",
    en: "No models available (enable models in the settings)",
  },
  "chrome.modelPicker.noMatch": {
    ja: "条件に一致するモデルがありません",
    en: "No models match the criteria",
  },
  "chrome.modelPicker.thinkingStrength": {
    ja: "推論強度（思考レベル）",
    en: "Thinking strength",
  },

  // --- workspace picker ----------------------------------------------------
  "chrome.workspacePicker.select": {
    ja: "ワークスペースの選択",
    en: "Select workspace",
  },
  "chrome.workspacePicker.none": {
    ja: "ワークスペースが登録されていません",
    en: "No workspaces registered",
  },
  "chrome.workspacePicker.chatOnly": {
    ja: "通常チャット（ワークスペースなし）",
    en: "Plain chat (no workspace)",
  },
  "chrome.workspacePicker.folderCount": {
    ja: "{count} 件のフォルダー",
    en: "{count} folders",
  },
  "chrome.workspacePicker.edit": { ja: "編集", en: "Edit" },
  "chrome.workspacePicker.editNamed": {
    ja: "「{name}」を編集",
    en: 'Edit "{name}"',
  },
  "chrome.workspacePicker.delete": { ja: "削除", en: "Delete" },
  "chrome.workspacePicker.deleteNamed": {
    ja: "「{name}」を削除",
    en: 'Delete "{name}"',
  },
  "chrome.workspacePicker.create": {
    ja: "ワークスペースの新規作成",
    en: "Create workspace",
  },

  // --- workspace modal -----------------------------------------------------
  "chrome.workspaceModal.editTitle": {
    ja: "ワークスペースの編集",
    en: "Edit workspace",
  },
  "chrome.workspaceModal.createTitle": {
    ja: "ワークスペースの新規作成",
    en: "Create workspace",
  },
  "chrome.workspaceModal.nameLabel": {
    ja: "ワークスペース名",
    en: "Workspace name",
  },
  "chrome.workspaceModal.namePlaceholder": {
    ja: "例: プロジェクトA",
    en: "e.g. Project A",
  },
  "chrome.workspaceModal.foldersLabel": {
    ja: "対象フォルダー",
    en: "Target folders",
  },
  "chrome.workspaceModal.picking": { ja: "選択中…", en: "Selecting…" },
  "chrome.workspaceModal.selectFolder": {
    ja: "フォルダーを選択",
    en: "Select folder",
  },
  "chrome.workspaceModal.description": {
    ja:
      "関連する複数のフォルダーをまとめて、作業環境（ワークスペース）を作成します。AIによるファイルの読み書きやコマンド実行は、指定したフォルダー内に限定されます。",
    en:
      "Group related folders into a workspace. AI file read/write and command execution are restricted to the specified folders.",
  },
  "chrome.workspaceModal.saving": { ja: "保存中…", en: "Saving…" },
  "chrome.workspaceModal.removeFolder": {
    ja: "削除",
    en: "Remove",
  },
  "chrome.workspaceModal.create": { ja: "作成", en: "Create" },

  // --- folder browser ------------------------------------------------------
  "chrome.folderBrowser.title": {
    ja: "フォルダーの選択",
    en: "Select a folder",
  },
  "chrome.folderBrowser.selectPrompt": {
    ja: "参照先フォルダーを選択してください",
    en: "Select a folder to browse",
  },
  "chrome.folderBrowser.placesLabel": { ja: "場所", en: "Places" },
  "chrome.folderBrowser.place.home": { ja: "ホーム", en: "Home" },
  "chrome.folderBrowser.place.desktop": { ja: "デスクトップ", en: "Desktop" },
  "chrome.folderBrowser.place.documents": {
    ja: "ドキュメント",
    en: "Documents",
  },
  "chrome.folderBrowser.place.downloads": {
    ja: "ダウンロード",
    en: "Downloads",
  },
  "chrome.folderBrowser.noPlaces": {
    ja: "参照可能な場所が見つかりません",
    en: "No places to browse",
  },
  "chrome.folderBrowser.chooseStart": {
    ja: "左の一覧からフォルダーを選択してください",
    en: "Choose a folder from the places on the left",
  },
  "chrome.folderBrowser.emptyFolder": {
    ja: "このフォルダーには項目がありません",
    en: "This folder is empty",
  },
  "chrome.folderBrowser.hiddenOnly": {
    ja: "隠し項目のみが存在します",
    en: "Only hidden items are here",
  },
  "chrome.folderBrowser.goUp": { ja: "上の階層へ", en: "Go up" },
  "chrome.folderBrowser.showHidden": {
    ja: "隠し項目を表示",
    en: "Show hidden items",
  },
  "chrome.folderBrowser.hideHidden": {
    ja: "隠し項目を非表示",
    en: "Hide hidden items",
  },
  "chrome.folderBrowser.selectThis": {
    ja: "このフォルダーを選択",
    en: "Select this folder",
  },
  "chrome.folderBrowser.selectNamed": {
    ja: "「{name}」を選択",
    en: 'Select "{name}"',
  },
  "chrome.folderBrowser.fileNotSelectable": {
    ja: "ファイルは選択できません",
    en: "Files cannot be selected",
  },
} satisfies Record<string, LocalizedText>;
