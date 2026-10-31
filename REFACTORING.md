# リファクタリング記録と計画

このドキュメントは、リポジトリ全体を対象にしたリファクタリング調査の結果と、
そのうち実施済みの変更、および残っている課題を記録します。

- 調査日: 2026-11-01
- 対象: `packages/core` / `packages/server` / `packages/web` / `packages/desktop` / `packages/browser-rpc` / `scripts`
- 規模（テストを除く）: core 約 50,300 行 / web 約 24,400 行 / server 約 10,100 行

## 1. 方針

判断の基準は次の 3 つです。

1. **同じ知識は 1 箇所に置く**（DRY）。とくに「同じ値・同じ規則が 2 つの層に書かれている」ものは、
   片方だけ直すと静かに食い違うため、機械的に 1 箇所へ寄せる。
2. **変更理由が 1 つになる単位で分ける**（SRP）。巨大なファイルは、行数ではなく
   「どんな修正で触るか」が複数あるかどうかで分割する。
3. **抽象を介して依存させる**（DIP）。とくに core のツール層が具体的なホスト実装を
   直接参照していた箇所は、インターフェース側へ定数を移した。

後方互換のためのシムや別名は残していません。古い呼び出し元はすべて新しい定義へ
置き換え、使われなくなった拡張点は削除しました。

## 2. 実施した変更

### 2.1 共通プリミティブの一本化（DRY）

| 追加した 1 箇所 | 統合した重複 | 効果 |
|---|---|---|
| `packages/core/bytes.ts`（`concatBytes` / `crc32`） | VM コンテナ・PNG エンコーダ・`podman exec` の出力結合・ページ取得・アップデータの zip フィクスチャの 5 実装 | バイト結合の意味が 1 つになり、`crypto.subtle` に渡せる `ArrayBuffer` 所有が保証される |
| `packages/core/shared/misc.ts` の `sleep` / `sleepAbortable` / `withTimeoutError` | computer-use 各ホスト・ルーチンスケジューラ・VM ポーリング・プロセス終了待ち・安全チェック・ゴール判定・eval ツールの 8 実装 | タイマーの後片付けと中断の意味が 1 箇所に |
| `packages/core/vm/quote.ts` の `shellQuote` | `vm/fs.ts` と `vm/shell.ts` の完全同一実装 2 つ | シェルのクォートという「正しさが全部に効く」1 行が 1 つに |
| `packages/core/shared/mime.ts` | `tools/filesystem.ts` / `shared/visual.ts` / `shared/attachments.ts` / `shared/agent-avatar.ts` の画像 MIME 表 4 つ | SVG を許すかどうかという**方針の差**が、表の複製ではなく理由付きの 1 箇所で表現される |
| `packages/core/tools/file-backend.ts` の `MAX_GREP_FILE_SIZE` | ホスト実装と VM 実装の 2 定義（かつツール層がホスト実装を直接 import していた） | 上限がインターフェース側に載り、「両バックエンドが同じファイルを飛ばす」ことが型で読める |

### 2.2 実バグ・契約ドリフトの修正

- **VM の grep がサイズ上限を無視していた**（`packages/core/vm/fs.ts`）。
  ホスト実装は `maxFileSize` を超えるファイルを飛ばすが、VM は `grep -r` を
  そのまま実行していたため、同じ検索が環境によって違う結果を返していた。
  `find ... -size -<cap+1>c -print0 | xargs -0 grep` に変え、`-H` で
  ファイル名の前置を保つ（1 ファイルのバッチでも `path:` が消えない）。
- **per-session マップのリーク**（`packages/core/core.ts`）。
  `handoverHubs` には削除経路が無く、`sessionRevisions` は `close()` で
  掃除されていなかった。`forgetSession()` を 1 つ作り、close / delete /
  シャットダウンを同じ経路に通した。
- **stella ルートの二重エラーマッピング**（`packages/server/routes/stella.ts`）。
  5 箇所の `try/catch` が `util.ts` の `errorStatus` と同じ変換を再実装し、
  さらに未知例外を 400/503 に落として「未分類は 500」の規約を破っていた。
  `CoreError` をそのまま投げる形にした。
- **Web がサーバーに存在しないエンドポイントを呼んでいた**（`packages/web/src/api-local.ts`）。
  `/api/stella/session`（廃止済み）と `/api/stella/skills`（未実装）を削除。
- **federation の廃止パスパターン**（`packages/server/federation.ts`）。
  存在しないルートへのスローパス指定を削除し、実際に重い `/prompt` を追加。
- **MCP のツールキャッシュが再接続後も残っていた**（`packages/core/mcp/manager.ts`）。
  クライアントを落とすときに `toolsCache` も無効化する。
- **画像解析キャッシュが無制限**（`packages/core/agent/image-analysis.ts`）。
  挿入順で 64 件に制限（古いものから落とす）。
- **死んだ拡張点の削除**：`SessionAgent.subscribeToRun`（呼び出し元ゼロ）、
  `security.ts` の `safePageHost` 重複定義、`pages.ts` の `unguardedPath`
  重複（`export` されているが参照ゼロ）、`cache.ts` の二重ヘッダー。

### 2.3 WebSocket ハンドラの統合（server）

`/ws`（全セッション＋フェデレーション中継）と
`/stella/conversations/:agentId/events`（1 会話の投影）は、
差分のバッチ・ハートビート・後片付けの 3 点が同一の 100 行強を 2 本書いていました。
`packages/server/routes/ws-stream.ts` の `createEventStream()` に
「何を通すか」だけを差し替える形で統合しました。

- バッチのキーは `/ws` がセッション id、stella が会話 id（1 ソケット 1 会話）。
- 非 delta フレームは必ずバッチを flush してから書く（順序が意味を持つため）。
- 終了時は interval → batch → subscription の順で畳む。

### 2.4 API 型の一元化（server ↔ web）

`FsPlace` / `FsEntry` / `FsBreadcrumb` / `FsBrowse` / `PeerStatus` /
`StellaStatus` / `RoutineView` / `StellaAvailability` は、サーバーのルートと
Web のクライアントが**それぞれ独立に**宣言していました。片方のフィールド名を
変えても型検査は通ります。`packages/core/shared/wire.ts` に定義を移し、
両側が同じ定義を import するようにしました。

### 2.5 i18n カタログの重複検出と統合

`messages` は 5 つのエリア表のスプレッドなので、同じキーが 2 ファイルにあると
後勝ちで静かに消えます。テストを 2 つ追加しました。

- `catalogue: no key is defined in two area files` — キーの衝突を検出。
- `catalogue: a generic action is not redefined per surface` — 汎用の動詞
  （閉じる・保存・削除・編集・更新・読み込み中・キャンセル）が別の面で
  書き直されていないかを検出。

後者で見つかった 6 組（`chrome.titleBar.close`, `chrome.workspacePicker.edit`,
`chrome.workspacePicker.delete`, `settings.provider.edit`,
`settings.webSearch.form.save`, `chat.composer.mention.loading`）を
`common.*` へ統合しました。加えて、保存中・保存しました・保存できませんでした・
サーバーを追加・エラー・設定ダイアログの見出しの重複も `common.*` に寄せています。

### 2.6 Web の状態管理の統一

`ARCHITECTURE.md` の「画面をまたぐ値はモジュールスコープのストア」という規約は
あったものの、実装は 4 通りに分かれていました。

| 値 | 以前 | 現在 |
|---|---|---|
| 設定 | `SettingsStore` クラス | 変更なし（基準） |
| モデルカタログ | `ModelCatalog` クラス | 変更なし（基準） |
| 言語 | `let current` + 手書き通知 | `i18n.ts` のまま（描画即時性のため） |
| 保存プロンプト | `CustomEvent` で再取得を扇動 | `createStore` による共有ストア |
| 接続レジストリ | `CustomEvent` で再取得を扇動 | `createStore` による共有ストア |
| ユーザー定義プロバイダー | 2 画面が各自 `useState` | `createStore` による共有ストア |

`packages/web/src/store.ts` の `createStore` が唯一の実装です。
イベントバス（`globalThis.dispatchEvent`）は Web から全廃しました。

あわせて:

- `useSavedNotice` / `useDebouncedWrite` が存在するのに 4 箇所で手書きされて
  いたため、共有フックへ寄せた（`useDebouncedWrite` はジェネリック化し、
  `flush` / `cancel` を持つ）。
- `theme` / `language` の書き込みを `api.setSetting` 直呼びから
  `settingsStore.set` に変えた（設定画面が同じキーを読んでいるため）。
- `useAsyncData` を追加し、`fetch + loading + error + stale ガード` の
  定型を 1 箇所に（`ProviderList` のカタログ状態から適用）。

### 2.7 そのほかの整理

- `core/mod.ts` の公開 API が `createCodingTools` / `createChatTools` を出し
  `createStellaTools` を落としていた非対称を解消。
- `vm/container.ts` の `createVmExec` / `createVmExecBytes` が 25 行の
  オプション展開を完全に重複させていたため、`execArgv` / `execOptions` に抽出。
- `errorMessage` を手書きで再実装していた 11 箇所を共有実装へ。
- `PACKAGES/deno.json` に `./bytes` エクスポートを追加（アップデータの
  テストフィクスチャが共有 `crc32` を使うため）。

## 3. 残っている課題（優先度順）

以下は**未実施**です。実施するときの判断材料として、調査で確認した事実を残します。

### 高: `packages/core/core.ts`（2,129 行）の分割

`LumiscaCore` は 125 個のメソッドを持ち、次の 5 つの責務が同居しています。

- 設定・認証情報（`settings` / `credentials` / `models`）
- ワークスペースとセッション（`workspaces` / `sessions` / `messages` / `piece`）
- stella の相手とマシン（`stellaAgents` / `stella` / `handoverHubs`）
- ルーチン（`routines` / `routineScheduler`）
- ツールとプロバイダー（`mcp` / `webSearch` / `browserBackend` / `computerHost`）

分割案は「stella 面（`stella/session-service.ts`）」「ルーチン面」
「設定とプロバイダー面」の 3 つを `LumiscaCore` から切り出し、`LumiscaCore` は
合成と配線だけを持つ形です。**ただし呼び出し元が server/web の 60 箇所以上に
あり、API の形を変えると広く波及します**。段階的に行うべきです。

### 高: `packages/core/agent/session-agent.ts`（1,223 行）

実行入口・コンテキスト公開・イベント橋渡し・リトライ配線・圧縮配線が
1 クラスにあります。とくに `handleEvent`（974 行〜）と
`handleTurnEnd`（1,074 行〜）が状態機械の中心で、変更のたびに
「どの実行の話か」を 5 つのフラグから読み解く必要があります。
`ai/agent.ts` の 19 個の可変フィールド（`runningInner` / `runId` /
`abandonedRunId` など）は、明示的な状態 enum と遷移関数に置き換える価値が
あります。**回帰リスクが最も高い領域**なので、既存テストを増やしてから
着手してください。

### 中: `packages/core/tools/task-hub.ts`（805 行）

サブエージェントの spawn・圧縮・レート制限バックオフ・イベント中継・
ライフサイクルが同居し、`setLanguage` / `setBrowserAvailable` /
`setComputerAvailable` / `setWebSearch` / `setMcp` / `setRuntimeResolver` /
`setParentDelivery` の 7 セッタで設定を後から注入しています。
「いつどの設定が有効か」が呼び出し順に依存するため、
`update(config)` 1 本にまとめたうえで、`spawn` の前提を型で表すのが望ましいです。

### 中: レート制限リトライの 3 実装

`ai/rate-limit.ts` の `retryOnRateLimitError`、`agent/retry-manager.ts` の
`resumeOnce`、`tools/task-hub.ts` のサブエージェント再試行が、分類関数は
共有しつつ制御フローを別々に持っています。片方だけ直すと
「メインは再試行するがサブエージェントはしない」という非対称が生まれます。

### 中: `packages/core/ai/stream.ts` と `context-compaction.ts`

前者は `runStream` が 283 行（リクエスト組立・SDK イベント解釈・使用量正規化）、
後者はプロンプト定数だけで約 110 行です。どちらも「プロバイダ差異の修正」と
「圧縮方針の修正」が同じファイルを触るため、並行作業で衝突しやすい。

### 中: `packages/web/src/components/Composer.tsx`（654 行）ほか

`Composer` は画像の DnD/貼り付け、mention ポップオーバー、slash ポップオーバー、
モデルピッカー、コンテキストメーター、送信を持つ。`ProviderDetail`（556 行）の
OAuth ログインフローは `useMcpSignIn` とほぼ同型で、共通フックにできる。
`AddUserProviderForm` は 1 ファイルに 3 コンポーネント入っている。

### 低: `packages/server/app.ts`（396 行）の分割

middleware・ページ・API 14 本・WebSocket・画面リレー・SPA フォールバック・
`startServer` が 1 ファイルにあります。`startServer` が `createApp` の
federation 生成を再実装している点も合わせて解消したい。

### 低: `packages/server/systemd/install.ts` の FS 直結

`systemd/deps.ts` が probe / runner / interfaces を注入しているのに、
書き込み（`Deno.writeTextFile`）と `Deno.listen` だけ実環境直結で、
テストが実 FS に依存しています。

## 4. 検証

このセッションで実行し、通過を確認したもの:

- `deno task fmt:check`
- `deno task lint`
- `deno task check`
- `deno task check:versions`
- `deno task test`（1,793 テスト / 失敗 0）
- `deno task smoke:server`（別途、パッケージ済みサーバーの起動確認）

`packages/desktop`（Tauri）と `packages/browser-rpc`（Rust）は、この環境に
`cargo` のツールチェーンがあるものの WebKitGTK が無いため、Rust 側の
テストは実行していません。変更も加えていません。
