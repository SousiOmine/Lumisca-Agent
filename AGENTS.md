# AGENTS.md

Lumisca-Agent は、LLM を用いて開発や日常作業を支援するエージェントアプリケーションです。
Web サーバーおよびデスクトップアプリとして動作し、Bun、Tauri v2、Preact、Vercel AI SDK（`ai`、`@ai-sdk/*`）、models.dev（`@opencode-ai/models`）で構築されています。

この文書は作業者向けの手引きであり、変更手順、コマンド、実装上の制約と落とし穴だけを扱います。
設計の背景や不採用とした選択肢の理由は `ARCHITECTURE.md` を参照してください。

## 1. 開発フローと検証コマンド

### 作業前後の Git 確認

上流ブランチは頻繁に進むため、編集を始める前と push の前に必ず最新状態を確認します。

```bash
git fetch
git status
git log --oneline HEAD..origin/master
```

上流に進みがある場合は rebase で取り込み、検証をやり直してから push してください。

### ビルドと検証

コードを編集したあとは、変更範囲に応じて型検査、フォーマット、テストを実行します。

- `bun run check` / `bun run check:tests`：本体およびテストの型検査
- `bun run check:arch`：パッケージ間の依存境界検査（`scripts/check-architecture.ts`）
- `bun run fmt:check` / `bun run fmt`：Biome によるコード整形の確認と適用
- `bun run check:i18n` / `bun run check:ja`：翻訳キーの網羅性と日本語 UI 文言の検査
- `bun run check:versions`：マニフェスト間のバージョン一致検査（`scripts/check-versions.ts`）
- `bun run test`：単体テスト（`test:unit`）と結合テスト（`test:integration`）の一括実行
- `bun run build:server` / `bun run smoke:server`：単体サーバーのビルド（`scripts/build-server.ts`）とスモークテスト
- `bun run dev` / `bun run dev:desktop`：Web 開発サーバー、または Tauri デスクトップアプリの開発起動

### 手動確認スクリプト

CI では実行しない実機確認用スクリプトです（引数の詳細は各ファイル先頭のコメントを参照）。

- `bun run demo`：faux プロバイダーで動くデモサーバー（`scripts/demo-server.ts`）
- `bun run seed:history <sessionId> [nPairs]`：長い会話履歴の投入（`scripts/seed-test-history.ts`）
- `bun run probe:token`：認証トークン保護の確認（`scripts/token-probe.ts`）
- `bun run probe:computer`：Computer Use の動作確認（`scripts/probe-computer.ts`）
- `bun run probe:stella`：stella モードの動作確認（`scripts/probe-stella.ts`）
- `bun run probe:share --url <url> --session <id> --folder <path>`：ローカルフォルダー共有の確認（`scripts/probe-share.ts`）

### 依存関係の更新と障害調査

依存パッケージのバージョンは直接編集せず、公開から 24 時間以上経過した版をコマンドで更新します。
`packages/desktop` はワークスペース外にあるため個別に確認します。

```bash
bun update --latest
cargo update --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo update --manifest-path packages/browser-rpc/Cargo.toml
npm outdated # packages/desktop 内で実行
```

サーバー停止時の原因調査（クラッシュ、強制終了 `[shell] Stopping`、ヘルスチェック無応答）にはデータ領域の `server.log` を確認します。

- Windows：`%APPDATA%\com.lumisca.agent\server.log`
- macOS：`~/Library/Application Support/com.lumisca.agent/server.log`
- Linux：`$XDG_DATA_HOME/com.lumisca.agent/server.log`（systemd 常駐時は `journalctl --user -u lumisca -n 100`）

調査や再起動の際、`bun` や `lumisca-server` をプロセス名で一括終了しないでください。
作業中のエージェント自身を巻き込むため、必ず個別の PID を指定します。

## 2. コーディング規約とパッケージ境界

### コードコメント

コードを読めば分かる説明は書かず、コードから読み取れない判断理由や制約だけを残します。

- `.ts`、`.tsx`、`.rs`、`.css` のコメントは英語で記述します（画面文言やログ文字列の引用のみ日本語可）。
- **書く対象**：他の実装を選ばなかった理由、外部仕様や業務上の制約、タイムアウトや上限値の根拠、一見不要に見える処理の必要性、回帰テストが固定している不具合。
- **書かない対象**：処理内容の言い換え、識別子で表現できる説明、変更履歴（`git log` に委ねる）、コメントアウトしたコード、追跡先のない TODO。
- doc コメントには名前の言い換えではなく契約（単位、値域、省略時の挙動、事前条件）を書きます。
- TODO は `// TODO(issue #123): ...` の形式に限定します。

### パッケージ間の依存制約

- **`packages/desktop` の分離**：ルートの `package.json` には `workspaces` を定義しません（`src-tauri/target` がサーバーバイナリのビルド入力に混入するのを防ぐため）。
  `packages/desktop` から読み込むモジュールでは `@lumisca/*` の bare specifier を解決できないため、`packages/server/startup-env.ts` のように依存のないモジュールへ分離し、`packages/server/startup.ts` から再エクスポートします。
- **`@lumisca/core` の公開面**：`packages/server` から `packages/core` への相対パス import は禁止です。
  公開エントリは `packages/core/package.json` の `exports`、ルート `tsconfig.json` の `paths`、`scripts/check-architecture.ts` の 3 箇所で一致させます。
  また `packages/core/mod.ts` に未使用のエクスポートを残さないでください（`packages/core/repo_hygiene_test.ts` が検査します）。
- **`packages/web` のバンドル境界**：`web` が実行時に `core` から取り込めるのは、`packages/core/browser-entries.ts` に列挙された純粋関数モジュールだけです（`packages/web/src/boundaries_test.ts` が検証）。
  `@lumisca/core` 本体は `import type` のみ許可されます。

## 3. UI 文言と多言語対応

表示文言は `packages/core/shared/i18n/` に日英の対で定義し、コンポーネントからは `const t = useT();`（`packages/web/src/i18n.ts`）で `<area>.<surface>.<element>` 形式のキーを引きます。
システムプロンプトとツール定義の英文は翻訳せず、モデルの回答言語はセッションのコンテキストで指定します。

画面上のモード名は、stella mode を「Lumisca」、code mode を「Lumisca code」と表記します。
`stella` は内部識別子（URL、ファイル名、型名、変数名）にのみ使います。

### 日本語 UI 文言の原則

文言を変更したら `bun run check:ja` と `bun test packages/core/shared/i18n_test.ts` を実行します（`bun run check:ja --list <prefix>` で対象画面の日英対訳を一覧できます）。

- **ボタンと項目名**：名詞または動詞の終止形とし、句点を付けません（「保存する」ではなく「保存」）。
- **説明文**：ですます調で文末に句点を付けます。
  丸括弧での補足は避け、別の文に分けてください（括弧は「新しいAPIキー（上書き）」のような短いラベルに限定）。
- **用語の統一**：フォルダー、サーバー、ユーザー、プロバイダー、ブラウザ、既定（「デフォルト」は不可）に統一します。
  フォルダー共有は「貸す／切れる」ではなく「接続／切断」と表現します。
- **字間**：英数字と日本語の間、数字と助数詞の間に半角スペースを入れません（例：`AIが`、`APIキー`、`Web検索`、`1件`、`30分`）。
- **簡潔さと具体性**：翻訳調の冗長表現（「〜することができます」「〜を行う」「に関して」「の際」）や、見出しの反復になる説明文を省きます。
  空状態には待機メッセージではなく次の操作を書き、エラーには原因と対処を書きます。
- **内部用語と重複の排除**：環境変数名、`systemd`、`Reasoning`、`stella` を画面に出しません。
  タッチ端末で読めないツールチップに説明を逃がさず、可視の 1 文にまとめます（「Lumiscaにようこそ！」の感嘆符のみ `scripts/check-ui-japanese.ts` の例外登録）。

## 4. Web フロントエンドとデスクトップシェル

### ルーティングと履歴（`packages/web/src/route.ts`）

すべての画面状態は URL で一意に表します。
`route.ts` は DOM に触れない純粋関数（`parseUrl` / `urlOf`）のみを持ち、`history` 操作は `packages/web/src/hooks/useRoute.ts` に集約します。

| 画面 | URL |
| --- | --- |
| エントリ（保存済みモードへ `replace`。未選択時は `/agents`） | `/` |
| 初期セットアップ（未完了時のみ `/` から遷移） | `/setup` |
| Lumisca code（新規 / ローカル / ピア） | `/code`、`/code/s/<sessionId>`、`/code/p/<peerId>/s/<sessionId>` |
| Lumisca（エージェント一覧 / 会話） | `/agents`、`/agents/<agentId>` |
| 設定モーダル | `<画面>/settings`、`<画面>/settings/<category>` |

- 設定は開いた画面の配下に載せ、閉じるときは設定内で積んだカテゴリ遷移の深さ（`packages/web/src/history-entry.ts` の `history.state`）をまとめて巻き戻します。
  `replace` で別画面へ移るときは深さを 0 にリセットしてください。
- 削除済みセッション、存在しないエージェント、未知の設定カテゴリは 404 を出さず、各モードのトップへフォールバックします。
- stella 非対応サーバーで `/agents` を開いた場合は理由を表示して `/code` へ戻し、`localStorage`（`lumisca.appMode`）は上書きしません。

### タブ保持、アニメーション、ストリーミング描画

CSS トークン、角丸、色相ルール、モーション曲線の詳細は `packages/web/src/styles/README.md` を参照してください（`packages/web/src/styles_test.ts` が検査します）。

- **タブの DOM 保持**：`packages/web/src/components/SessionPane.tsx` は開いているタブをアンマウントせず `hidden` 属性で隠します。
  `.chat` の `display: flex` に優先させるため `.chat[hidden] { display: none }` が必須です。
  非アクティブ時は自動スクロール（`useTranscriptScroll.ts`）、入力欄伸縮（`useAutoGrow.ts`）、一覧ポーリング（`useRecentSessions.ts`）を停止します。
  面が保持されるため、送信中フラグなどの要求単位の state は成否を問わず完了時に必ずリセットしてください（`packages/web/src/draftStart.ts`）。
- **画面遷移（View Transitions）**：`packages/web/src/screen-transition.ts` は階層移動（stella の一覧と会話、設定の一覧とカテゴリ）にのみ遷移を適用し、広い画面の 2 ペイン stella では無効化します。
  コールバック内で `flushSync` を呼び、内側要素には `view-transition-name` を付けないでください（`position: fixed` の包含ブロックが壊れます）。
  一覧へ戻る操作には `router.dismiss` を使います。
- **開閉アニメーション**：進捗行、ツール行、通知行、作業ログは `{open && ...}` でアンマウントせず、常時マウントした `.collapse`（`data-open`）と `.collapse-inner`（`overflow: hidden`）で `grid-template-rows: 0fr` と `1fr` を切り替えます（`packages/web/src/styles/motion.css`）。
- **実行中ツール行と質問カード**：実行中のツール表示は `SessionView.liveTools` が `tool_start` で追加し `message_end` で消去します（faux プロバイダー対策として既存履歴に同一 ID があれば追加しません）。
  `ask` ツールの質問カードは、`execute` 内の入れ子呼び出しでも閉じられるよう `tool_end` ではなく `question_end` で閉じます（`packages/core/tools/ask.ts`、`packages/web/src/events/reducer.ts`）。

### 設定画面と初期セットアップ

- **カテゴリの分類**：`packages/web/src/components/settings/categories.ts` で「この端末（アプリ、通知、接続先サーバー）」と「サーバー（概要、プロバイダー、モデル設定、MCPサーバー、カスタマイズ、セキュリティ、実験的機能、保存済みプロンプト）」の 2 群に分けます。
  個別エージェントの名前、アイコン、モデル、ルーチンは設定画面に置かず、エージェント一覧の行メニューから編集します。
- **UI 部品と既定モデル**：ページ枠は `SettingsPage.tsx` と `SettingsSubHeader.tsx`、プロバイダー一覧は `SettingsSection.tsx` と `ProviderRow.tsx`、ドロップダウンは `components/Select.tsx`（`hooks/useSelectPlacement.ts`）を使います。
  新規セッション画面のモデル選択は `packages/web/src/defaultModel.ts` の `rememberDefaultModel` で `model_default` に保存します（未読上書きを防ぐため、保存前に必ずストアを読み込みます）。
  接続先サーバーの切り替えはタイトルバーの `components/ConnectionPicker.tsx` のみに置きます。
- **設定変更のセッション反映**：プロンプトやツール構成を変える設定は `SessionPool.applyAgentBuildChange` を通し、実行中のセッションは run 終了後に再構築します（`SessionLifecycle.deferRebuild`）。
  Computer Use などの能力フラグは `SessionPool.applyCapabilityChange` で即時反映し、能力値は getter で渡します。
- **初期セットアップ（`/setup`）**：完了判定は `$XDG_CONFIG_HOME/lumisca-agent/setup-complete` の有無のみで行い、`settings.jsonc` の内容からは推測しません（`packages/core/settings/setup.ts`）。
  `/` へのアクセス時のみ未完了なら `/setup` へ `replace` します。
  デスクトップ版のみ先頭に接続先サーバー選択ステップ（`components/setup/ServerStep.tsx`）を出し、リモートへ切り替える前にローカル側の完了マーカーも記録します。

### デスクトップシェルブリッジとウィンドウ制御

- **通信経路**：シェル操作は loopback HTTP（`packages/desktop/src-tauri/src/bridge_server.rs`、`packages/server/render.ts` の CSP で許可）へ送り、HTTPS リモートページで**通信自体が失敗したときだけ** Tauri IPC へ退避します（`packages/web/src/shell.ts` の `shellCall`）。
  HTTP エラー応答で退避すると操作が二重実行されます。
- **タイトルバー**：描画有無は非同期の `state` ではなく初期化スクリプトの `__LUMISCA_PLATFORM__` と `inDesktopShell()` で決めます。
  macOS は overlay タイトルバーの 28pt 余白下に帯を置き、左 78px を空けて `.macos-titlebar-drag` を配置します。
  Windows と Linux はフレームレス（`decorations: false`）で、移動ループによるマウス捕捉を避けるため 2 回目の押下（`detail === 2`）で最大化を判定します（`packages/web/src/titlebar-press.ts`、`packages/desktop/frontend/splash.js`）。
  帯内の要素には `flex: 1; min-width: 0` を指定し、右端の `.titlebar-controls` を押し出す `width: 100%` を書かないでください。
- **ファイルドロップと外部リンク**：HTML5 D&D をコンポーザへ届けるため `packages/desktop/src-tauri/tauri.conf.json` の main ウィンドウは `dragDropEnabled: false` に固定し、対象外へのドロップによる画面遷移は `packages/web/src/drop-guard.ts` で防ぎます。
  新規ウィンドウ要求は `packages/desktop/src-tauri/src/window.rs` の `open_externally` で遮断し、`http(s)` と `mailto` のみを OS の既定ブラウザで開きます。

## 5. サーバーの運用と配布

### ストリーム配信、フェデレーション、Origin 判定

- **WebSocket バッチ配信**：`/ws` と stella のイベントストリームは、セッション単位で delta を 16ms ごとに 1 フレームへ束ねます（`packages/core/shared/ws-batch.ts`）。
  `rev` はイベント数のまま維持し、フレーム内の `events` 件数で欠落判定（`revisionGap`）を行います。
  非 delta イベントの送信前およびクライアント側の rAF 反映前に必ず保留分を flush してください。
- **キャッシュとプロキシ**：全応答を gzip 圧縮し、ヘッダー規則は `packages/server/app-file-headers.ts` に集約します。
  フェデレーション（`packages/server/federation.ts`）は `/api/health` の `instanceId` で自己接続を避け、中継済みフレームの再中継を禁止します。
- **Origin 検証**：リバースプロキシの TLS 終端を通すため、CORS、WebSocket、MCP `redirect_uri` の同一サーバー判定はスキームを除いたホストとポートの一致（`packages/server/security.ts` の `sameServerAuthority`）で行います。

### 自動アップデートとアーカイブ構成

- **署名鍵とメタデータ**：署名鍵を変更する際は `packages/server/update/verify.ts` と `packages/desktop/src-tauri/tauri.conf.json` の両方を更新します。
  配布定義と比較処理は `packages/server/update/release.ts` にあります。
- **アーカイブ制約**：サーバー配布アーカイブの最上位ディレクトリ名はバージョンを含めない `lumisca-server-<platform>` 固定です。
  旧版バイナリからの自己更新互換性を保つため、`stella-container/` などの同梱ファイルは 1 階層までに制限します（`packages/server/update/archive.ts` の `MAX_PACKAGE_DEPTH`）。
  整合性は `scripts/check-server-archive.ts` で検証します。
- **マニフェストと状態管理**：デスクトップ用 `latest.json` の URL は `scripts/rewrite-updater-json.ts`（`.github/workflows/rewrite-updater-json.yml`）で GitHub Releases の直リンクへ書き換えます。
  サーバー自己更新の `installing` 状態は `#fail` と `#patch` で解除し、`apply()` の `finally` では解除しないでください。

### PWA と Web Push 通知

- **Manifest と Service Worker**：`packages/server/manifest.ts` がリクエストごとに manifest を生成します。
  `/manifest.webmanifest`、`/pwa/*`、`/sw.js` は未認証で取得されるため秘密情報を含めません（`packages/server/security.ts`）。
  Service Worker は `https:` 環境でのみ登録し（`packages/web/src/pwa.ts`）、キャッシュ方針を変えたら `CACHE_NAME` を更新します。
  `packages/server/render.ts` と `packages/web/index.html` の viewport 指定は常に一致させてください。
- **ビルド更新検知**：`Assets.buildId()` を `GET /api/build` と `initial-data.js` に載せ、`packages/web/src/hooks/useBuildWatch.ts` で比較します。
  初回算出で esbuild が走るため、3 秒タイムアウトで呼ばれる `/api/health` には載せないでください。
- **Web Push（`packages/server/push.ts`、`packages/core/notify/web-push.ts`）**：外部依存を増やさず WebCrypto のみで実装し、暗号化ペイロード末尾には必ず `0x02` 区切りを付けます。
  公開鍵と秘密鍵が食い違った場合は既存購読の無言失効を防ぐため再生成せずエラーにし、送信失敗時は 404 と 410 のみ購読を削除します。
  ページ表示時に `packages/web/src/hooks/usePush.ts` から再登録し、前面ウィンドウがあるかの判定は Service Worker 側で行います。
  待機中セッションを閉じただけの `abort()` では `agent_end` を発火させないでください（`packages/core/ai/agent.ts`）。

### Linux systemd 常駐（`packages/server/systemd/`）

一般ユーザー権限で `./lumisca-server service config|install|status|uninstall` を実行します（設定先は `<config home>/systemd/user/lumisca.service` と `service.env`）。
外部公開時は `--host` と `--allowed-hosts` を指定し、OS 起動時からの常駐には `loginctl enable-linger <user>` を有効にします。

## 6. stella モードと周辺機能

### コンテナ契約とライフサイクル（`packages/core/vm/`）

Linux 上の rootless podman を前提とし、起動確認（`VM_PROBE_IMAGE`）に通らない環境では無効化します。

- **構成と契約値**：エージェントごとにコンテナ `lumisca-stella-<agentId>` を作り、`/home/agent` ボリューム（`lumisca-stella-home`）を全コンテナで共有します。
  作業フォルダー（`agents/<id>`）、Chromium プロファイル、`XDG_CACHE_HOME`（AT-SPI バスの衝突回避）のみエージェント別に分離します。
  契約値は `packages/core/vm/contract.ts` と `packages/core/vm/container/` で一致させ、ダイジェスト不一致時はイメージを自動再ビルドします。
- **省電力と上限**：会話を開いた時点ではイメージ準備のみを行い、コンテナ起動は最初のプロンプトやツール実行まで遅延させます（GUI も `screenExec` まで起動しません）。
  メモリ 3 GiB、スワップなし、PID 上限 2048、`--restart=unless-stopped` を付与し、5 分間無操作（`VM_IDLE_SLEEP_MS`）で実行中ジョブがなければ `podman stop` します。
  プロセス終了時はそのサーバープロセスが起動、参照したコンテナのみを停止します（`StellaMachine.stopAll`）。
- **実機テストの隔離**：`packages/core/stella_live_test.ts` は `LUMISCA_STELLA_LIVE=1` 指定時のみ動作し、利用中のコンテナを止めないよう `core.close()` の前に `setStellaVm(undefined)` で切り離します。

### 会話、モデル、記憶、ルーチン

- **エージェントと記憶**：`LumiscaCore.ensureStellaAgent` で最低 1 人のエージェントを維持し、初回表示時に `onboarded_at` を CAS 更新して 1 度だけセットアップターンを開始します（`packages/core/stella/onboarding.ts`）。
  `role` は作成時のみ指定可能で、名前はシステムプロンプトに含めません。
  エージェント自身のメモは `identity` ツール（DB 保存、毎ターン配信）と作業フォルダー内の `MEMORY.md`（`packages/core/vm/agent-memory.ts`、初期化時は既存内容を消さないよう必ず `[ -e ]` で存在確認すること）を使い分けます。
- **発言と生成 UI**：最終応答本文と `send_chat`（`packages/core/tools/send-chat.ts`）が発言になります（無言終了は `NO_RESPONSE`、`packages/core/agent/silent-reply.ts`）。
  インタラクティブ UI は ```` ```ui ```` コードブロックに JSON 仕様を書きます（`packages/core/shared/chat-ui/segments.ts`、`packages/core/agent/run-events.ts`）。
  巻き戻しは `truncated` イベントと `POST .../rewind` 応答の両方で末尾を落とします（`packages/web/src/stella-state.ts`）。
- **編集ダイアログ**：名前、アイコン、モデル、思考レベルは `packages/web/src/components/stella/AgentEditDialog.tsx` から一括更新し、バリデーション通過後にのみ書き込み、`updated_at` は変更しません。
  アイコンはラスタ画像（512 KiB 以下、SVG 不可）のみ保存します（`packages/core/stella/icons.ts`）。
- **ルーチン、履歴、DB クローズ**：スケジュールは `daily`、`weekly`、`every`、`once`、`watch` の 5 種です（`packages/core/shared/routine.ts`）。
  MCP 監視はサーバー側の読み取り専用ツールのみで判定し、定型プロンプトは会話画面にも一覧プレビュー（`packages/core/shared/stella-preview.ts`）にも表示しません。
  会話の遅延読み込み SQL（`CONVERSATION_ROWS_SQL`）と射影（`stellaEntryOf`）の対象行集合は必ず一致させてください（`packages/core/session/transcript-pager.ts`）。
  SQLite を閉じる際は Windows でのファイルロック残留を防ぐため必ず `packages/core/db/close.ts` の `closeDatabase()` を使い、領域回収は次回起動時の `VACUUM INTO`（`packages/core/db/vacuum.ts`）で行います。

### 画面操作、環境変数、フォルダー共有

- **GUI 操作と受け渡し**：GUI 操作は AT-SPI ベースのセマンティック操作（`packages/core/vm/semantic.ts`）を優先します。
  人手が必要な場面は `vm_ask_user`（`packages/core/vm/handover.ts`、15 分タイムアウト）で待機し、その間だけ画面操作とクリップボード書き込み（`packages/core/vm/clipboard.ts`、`xclip` へ stdin 経由で投入し読み戻し検証を行う）を許可します。
- **秘密の環境変数（`vm_env`）**：モデルの履歴に秘密値を通さないため、`EnvRequestHub`（`packages/core/vm/env-request.ts`）で入力を受け、`.lumisca-env/env.json` と生成物の `env.sh`（0600）へ stdin 経由で保存します。
  `packages/core/vm/shell.ts` の前景と背景の両コマンド先頭で `env.sh` を source し、書き込み成功後にのみ待機を解除します。
- **ローカルフォルダー共有（`/lend`）**：`packages/core/share/`、`packages/server/share-host.ts`、`packages/desktop/src-tauri/src/share.rs` で構成します。
  名前空間の合成は `mountedBackends`（`packages/core/agent/session-location.ts`）の 1 箇所で行い、`MountedFiles` の `roots[0]` は必ずセッション自身のルートにします。
  `/lend` 直下への読み書き拒否、相対パスセグメントでの通信、backend 層での読み取り専用強制、context メッセージのみでの告知、貸し手プロセス側での最終アクセスからの自動切断期限の管理を守ってください。
  自動切断までの時間は設定の「アプリ → フォルダー共有」で選び、シェルが `grants` 行の `idleMs` で貸し手プロセスへ渡します。`null` は自動切断なしを表します。
  コンポーザの共有中枠（`--share`）は `packages/web/src/styles/composer.css` で `:focus-within` より後に定義します。

## 7. ツール、メディア、認証の実装規約

- **保存画像の縮小**：DB に残す画像は必ず `packages/core/media/stored-image.ts` の `prepareStoredImage`（長辺 1568px、1 MiB 上限、プロンプト添付は `packages/server/routes/session-requests.ts` の `preparePromptImages`）を通し、ツール応答の注記には縮小後の寸法と座標倍率を記載します。
  `chat_attach`、`send_chat`、`visual` で配信する元ファイルは加工しません。
- **スキル探索と作成**：スキル一覧は呼び出しごとに再探索し、同一 run 内で作成した `SKILL.md` を即座に読める状態を保ちます。
  テスト時は `LumiscaCore.forTesting` で `appSkillDirs: []` を渡しホスト環境から隔離します。
  サブエージェントには非対応ツールの組み込みスキルを除外して渡します（`packages/core/tools/tool-pieces.ts`、`packages/core/tools/subagent-spawn.ts`）。
- **MCP サーバー管理ツール**：`mcp_add`、`mcp_remove`、`mcp_list`（`packages/core/mcp/manage-tools.ts`）は main レジストリのみに置きます。
  stella の会話では 2 つの一覧を扱います。アプリ全体の一覧はホスト側で動く共有設定、エージェント専用の一覧はそのマシンの中で動く設定です。
  `command` を持つサーバーはマシンに属するため必ず専用に入れ、`command` と `scope: "global"` の組み合わせは拒否します。`url` を持つサーバーは省略時にアプリ全体へ入り、`scope: "agent"` で専用になります。
  追加時は接続確認後（401 は要サインイン状態で保存）に設定 JSON の該当エントリだけを差し替え、他エントリの `${VAR}` 展開値を確定させないようにします。
- **ChatGPT OAuth ログイン（`packages/core/models/chatgpt/`）**：サーバーと同一マシンのブラウザコールバック（`127.0.0.1`）のみ対応します。
  初回は動的クライアント登録を行い、`chatgpt.tokens.use.direct` スコープとモデル一覧取得を検証します。
  推論リクエスト（`packages/core/ai/stream.ts`）では `store: false` と `stream: true` を付与し、`max_output_tokens` を省略します。
  リフレッシュトークンの更新は同時リクエスト間で 1 回に共有します。
- **Scripting tool call（`packages/core/tools/execute.ts`）**：有効時はモデルに `execute` ツールのみを渡し、`packages/core/tools/catalog.ts` の `ToolCatalog`（`execute` と `tool_call` は除外、`tool_search` を含む）をプログラム内の `tools.*` として公開します。
  code mode はサーバー内サンドボックス（`packages/core/tools/js-sandbox.ts`）、stella はコンテナ内 `node`（`packages/core/code-execution/vm.ts`）と標準入出力チャネル（`packages/core/vm/channel.ts`）で実行します。
