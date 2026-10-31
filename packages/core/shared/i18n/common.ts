import type { LocalizedText } from "./types.ts";

/**
 * App-wide messages: generic actions shared by several surfaces, plus the
 * text the CORE generates into the transcript (compaction checkpoints, goal
 * notices, desktop notifications). Surfaces with their own vocabulary live
 * in `chrome.ts`, `settings.ts`, `chat.ts` and `panels.ts`.
 */
export const common = {
  // --- generic actions ------------------------------------------------------
  "common.close": { ja: "閉じる", en: "Close" },
  "common.back": { ja: "戻る", en: "Back" },
  "common.cancel": { ja: "キャンセル", en: "Cancel" },
  "common.save": { ja: "保存", en: "Save" },
  /** Busy state of any form that persists on its own (a debounced field, a
   * dialog's save button). One wording for every such form: two surfaces
   * that save the same way must not read differently. */
  "common.saving": { ja: "保存中…", en: "Saving…" },
  /** Success line a form shows after it persisted. */
  "common.saved": { ja: "保存しました", en: "Saved" },
  /** Failure line a form shows; `{error}` is the server's own message. */
  "common.saveFailed": {
    ja: "保存できませんでした: {error}",
    en: "Could not save: {error}",
  },
  /** The heading/button that opens "add one more item" in a list whose items
   * are servers, providers or connections — the same act, so the same text. */
  "common.addServer": { ja: "サーバーを追加", en: "Add server" },
  "common.delete": { ja: "削除", en: "Delete" },
  "common.edit": { ja: "編集", en: "Edit" },
  "common.reload": { ja: "更新", en: "Refresh" },
  "common.loading": { ja: "読み込み中…", en: "Loading…" },
  "common.expandPanel": { ja: "パネルを展開", en: "Expand panel" },
  "common.settings": { ja: "設定", en: "Settings" },
  "common.justNow": { ja: "たった今", en: "just now" },
  /** Status word on a failed tool call or notification line. */
  "common.error": { ja: "エラー", en: "Error" },
  /** The page could not reach its own server (App's top-level error). */
  "common.serverUnreachable": {
    ja: "サーバーに接続できません: {error}",
    en: "Cannot reach the server: {error}",
  },
  /** Confirmation before deleting a workspace (the shared delete flow in
   * hooks/useWorkspaces.ts). */
  "common.workspaceDeleteConfirm": {
    ja: "ワークスペース「{name}」を削除してもよろしいですか？",
    en: 'Delete the workspace "{name}"?',
  },

  // --- token-required page (server/render.ts) -------------------------------
  /** The page a browser without a valid token lands on (401). Served
   * before the app loads, so it renders in the language the server resolved
   * for that request. */
  "common.tokenRequired.title": {
    ja: "トークンが必要です",
    en: "A token is required",
  },
  "common.tokenRequired.why": {
    ja:
      "このサーバーはトークン認証が有効です。ブラウザにトークンが保存されていない、または保存されたトークンが一致しないため、このページを表示できません。",
    en:
      "This server requires a token. The page is not shown because the browser has no token stored, or the stored one does not match.",
  },
  "common.tokenRequired.how": {
    ja:
      "次の形式の URL を一度だけ開いてください。2 回目以降はトークン無しの URL で開けます。",
    en:
      "Open a URL of the form below once. After that, the URL without the token works.",
  },
  "common.tokenRequired.example": {
    ja: "http://<ホスト>:<ポート>/?token=<トークン>",
    en: "http://<host>:<port>/?token=<token>",
  },
  "common.tokenRequired.note": {
    ja:
      "トークンの値はサーバーの設定を確認してください。ブラウザで Cookie が無効になっている場合にもこの画面が表示されます。",
    en:
      "Check your server configuration for the token value. This screen also appears when the browser rejects cookies.",
  },

  // --- MCP OAuth callback page (server/render.ts) ---------------------------
  /** The page the browser lands on after the authorization server redirects
   * it back (see server/routes/mcp.ts). Served without the app, so it
   * renders in the language the server resolved for that request. */
  "common.mcpAuth.title": { ja: "MCP の認証", en: "MCP sign-in" },
  "common.mcpAuth.done": {
    ja: "認証が完了しました。このタブを閉じて Lumisca に戻ってください。",
    en: "Signed in. Close this tab and return to Lumisca.",
  },
  "common.mcpAuth.failed": {
    ja: "認証に失敗しました: {error}",
    en: "Sign-in failed: {error}",
  },
  "common.mcpAuth.missing": {
    ja:
      "この認証リクエストは見つかりませんでした（期限切れか、すでに完了しています）。Lumisca に戻り、もう一度お試しください。",
    en:
      "This sign-in request was not found (it expired or already finished). Return to Lumisca and try again.",
  },

  // --- core-generated transcript text --------------------------------------
  /** Provisional name of a session, before the title generator names it
   * (see shared/misc.ts formatSessionName). */
  "common.sessionName": { ja: "セッション {date}", en: "Session {date}" },
  /** Head line of a compaction checkpoint (see ai/context-compaction.ts).
   * It is stored with the message, so a checkpoint keeps the language it was
   * generated in. */
  "checkpoint.title": {
    ja: "履歴 {count} 件を要約しました（約 {tokens} トークン）",
    en: "Summarized {count} messages (~{tokens} tokens)",
  },
  /** Why the autonomous goal loop stopped without reaching the goal. */
  "goal.cancelledByUser": {
    ja: "ユーザー操作により処理を中止しました",
    en: "Stopped by the user",
  },
  "goal.cancelledByRewind": {
    ja: "操作の取り消し（巻き戻し）が行われたため、処理を中断しました",
    en: "Stopped: the goal declaration was rewound",
  },
  "goal.maxIterations": {
    ja:
      "反復実行の上限回数（{max}回）に達したため、安全のため処理を停止しました",
    en: "Stopped after reaching the iteration limit ({max})",
  },
  "goal.judgeFailed": {
    ja: "ゴールの判定に失敗したため停止しました: {message}",
    en: "Stopped: the goal judgement failed: {message}",
  },
  /** Short form of the same failure, shown as the goal's stop reason. */
  "goal.judgeError": {
    ja: "判定エラー: {message}",
    en: "Judgement error: {message}",
  },
  "goal.judgeUnparsable": {
    ja: "高速モデルの応答を解釈できませんでした",
    en: "The fast model's reply could not be read",
  },
  /** Why a run ended without doing anything: the model answered with
   * neither text nor a tool call, and the vacant-response retries ran
   * out (see ai/retry-policy.ts). Without this the turn just stopped,
   * which reads as the agent ignoring the prompt. */
  "session.vacantResponse": {
    ja:
      "モデルの応答が空でした（本文もツール呼び出しもありません）。{count} 回まで自動で再試行しましたが回復しませんでした。もう一度送信してください。",
    en: "The model answered with neither text nor a tool call. Retried " +
      "automatically {count} times without recovering. Send the message " +
      "again to continue.",
  },
  /** Why a run ended on a rate-limit/error budget that had been retried. */
  "session.retryExhausted": {
    ja: "自動再試行の上限（{count} 回）に達したため停止しました: {message}",
    en: "Stopped after {count} automatic retries: {message}",
  },

  // --- desktop notifications (web/src/notify.ts) ----------------------------
  /** Name used for a session without a title in a notification. */
  "notify.sessionName": { ja: "セッション", en: "Session" },
  "notify.agentFinished": {
    ja: "「{name}」の処理が完了しました",
    en: '"{name}" has finished',
  },
  "notify.question": {
    ja: "「{name}」から質問があります{detail}",
    en: '"{name}" has a question{detail}',
  },
  "notify.questionDetail": { ja: "：{gist}", en: ": {gist}" },
  /** Reasoning-effort level names (the composer's badge, the model picker's
   * slider and the model-preference rows). The ids stay the wire values
   * (core/shared/providers.ts), only the labels are translated. */
  "common.thinking.off": { ja: "オフ", en: "Off" },
  "common.thinking.minimal": { ja: "最小", en: "Minimal" },
  "common.thinking.low": { ja: "低", en: "Low" },
  "common.thinking.medium": { ja: "中", en: "Medium" },
  "common.thinking.high": { ja: "高", en: "High" },
  "common.thinking.xhigh": { ja: "最高", en: "Extra high" },
  "common.thinking.max": { ja: "最大", en: "Max" },
} satisfies Record<string, LocalizedText>;
