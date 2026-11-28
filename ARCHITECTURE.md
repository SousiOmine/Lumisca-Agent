# Lumisca-Agent アーキテクチャ概要

この文書は Lumisca-Agent の全体構成と設計判断の根拠を記録します。
各機構をなぜ現在の形にしたか、代わりにどの選択肢を退けたかを扱います。
日常の開発手順、コマンド、変更時の細かな注意点は `AGENTS.md` を参照してください。

## 概要と動作モード

Lumisca-Agent は、画面上で **Lumisca**（内部名 `stella`、URL `/agents`）と **Lumisca code**（内部名 `code`、URL `/code`）の 2 つのモードを提供します。

| 項目 | Lumisca（stella mode） | Lumisca code（code mode） |
| --- | --- | --- |
| 会話の単位 | エージェント（相手）ごとに 1 本の継続的な会話 | ワークスペースに対する複数セッション（タブ、履歴） |
| 作業環境 | rootless podman による専用コンテナ（仮想デスクトップ付き） | ホストマシン上のワークスペースフォルダー |
| 主な画面要素 | ユーザーとエージェントの発言、生成 UI、必要に応じた VM 画面ペイン | 発言、ツール実行ログ、差分、進捗パネル |

- **既定モードと切り替え**：初回起動時はメインモードである Lumisca が開きます。
  Lumisca code は実験的機能の設定 `code_mode_enabled` を有効にしたときだけメニューとルーティングに現れます（無効時もサーバー API 自体は稼働します）。
  現在選んでいるモードはサーバー設定ではなく各クライアントの `localStorage`（`lumisca.appMode`）に保持するため、複数端末で同じサーバーを開いても互いの表示モードに干渉しません。
- **機能縮退を行わない方針**：stella mode は Linux と rootless podman を必須とし、利用できない環境では簡易版へフォールバックせず理由を示して選択不可にします。
  ファイル隔離や GUI 操作の前提を欠いたまま動かすと、エージェントが失敗を続けて利用者を混乱させるためです。

## 1. パッケージ構成と依存境界

| パッケージ | 役割 | 内部依存 |
| --- | --- | --- |
| `packages/core/` | エージェント実行、モデルとプロバイダーの管理、MCP、ツール群、SQLite、VM 管理（`core/vm/`）、フォルダー共有（`core/share/`） | なし（外部ライブラリのみ） |
| `packages/server/` | Hono ベースの HTTP / WebSocket サーバー、フェデレーション、アセット配信、自己更新、Web Push | `@lumisca/core` |
| `packages/web/` | Preact SPA フロントエンド、ルーティング、状態ストア、UI コンポーネント | `@lumisca/core` のブラウザ許可エントリのみ |
| `packages/desktop/` | Tauri v2 デスクトップシェル、ローカルサーバー起動管理、ネイティブ機能連携 | `server` を子プロセスとして起動 |
| `packages/browser-rpc/` | デスクトップのブラウザラボ連携用 Rust RPC クレート | なし |

### 依存関係の原則

- **単方向グラフと公開エントリの強制**：`core` は他の内部パッケージを知らず、`core` 内部のモジュールも循環依存のない DAG を保ちます（`packages/core/repo_hygiene_test.ts` が検証）。
  `server` は `@lumisca/core` の公開エントリポイントのみを参照し、相対パスによる内部参照は `scripts/check-architecture.ts` が拒否します。
- **`web` のランタイム隔離**：ブラウザバンドルに含めてよい `core` モジュールは純粋関数（`shared/`、`modes/`、`skills/slash`）に限定し、`packages/core/browser-entries.ts` の単一リストで境界テスト（`packages/web/src/boundaries_test.ts`）と esbuild エイリアス（`packages/server/bundle.ts`）の双方を制御します。
  ドメイン型は `import type` で参照し、バンドル時に消去します。
- **`packages/desktop` をワークスペース外に置く理由**：ルートに `workspaces` を定義すると、`bun install` や単体バイナリのビルド入力が `src-tauri/target` のビルド成果物を巻き込んで肥大化します。
  ワークスペース外に置く代償として、`desktop` のスクリプトからは `@lumisca/*` を解決できないため、環境変数の読み出しだけを依存ゼロの `packages/server/startup-env.ts` に切り出しています。

### ホストと VM のバックエンド抽象化

Lumisca code と Lumisca の違いを「どこでファイルとコマンドを扱うか」に閉じ込めるため、ツール実装の下に 3 つのポートを置いています。

| ポート | ホスト実装（`packages/core/tools/host/`） | VM 実装（`packages/core/vm/`） |
| --- | --- | --- |
| `FileBackend`（`packages/core/ports/file-backend.ts`） | `HostFileBackend`（`files.ts`） | `VmFileBackend`（`fs.ts`：`podman exec` と base64 転送） |
| `CommandRunner`（`packages/core/ports/command-backend.ts`） | `HostCommandRunner`（`command-runner.ts`） | `VmCommandRunner`（`shell.ts`：`bash -lc`） |
| `BackgroundSpawner`（`packages/core/ports/background-backend.ts`） | `HostBackgroundSpawner`（`background.ts`） | `VmBackgroundSpawner`（`shell.ts`：`setsid` とログ追跡） |

`read`、`write`、`edit`、`list_dir`、`bash`、`pdf_read_pages`、および長大出力のファイル退避（`tools/truncate.ts`）はすべてこのポート越しに共通コードで動作します。
一方、サーバープロセス内で JavaScript を動かす `eval` は VM 隔離を破るため stella（およびそのサブエージェント）には渡しません。

## 2. エージェント実行基盤（`packages/core`）

### サービス構成とエージェント単位のメッセージ管理

- **コンポジションルート**：リポジトリ、ストア、イベントハブ（`packages/core/events/hub.ts`）からのサービス構築は `packages/core/bootstrap.ts` の `createCoreServices` に集約し、`LumiscaCore` はファサードとして委譲のみを担います。
  セッション関連の処理は `services/sessions.ts`（および `session-lifecycle.ts`、`session-transcript.ts`、`session-assets.ts`、`session-skills.ts`、`session-runs.ts`）に分割しています。
  「`agent_end` 後に保留中のモデル変更を適用する」といったイベント駆動の後続処理は、配信経路に埋め込まず `EventHub` の購読者として登録します。
- **メッセージの所有者は `agents` テーブル**：`sessions` は入れ物であり、各セッションは `kind = 'main'` の行を 1 つ持ち、サブエージェントは `parent_id` を持つ `subagent` 行として同じ `agents` テーブル（`session/agents.ts`、`session/repo.ts`）に並びます。
  `messages.agent_id` が `agents.id` のみを参照することで、ページング、圧縮チェックポイント、履歴縮小、トークン集計の実装をメインとサブエージェントで二重に持たずに済みます。
  なお stella の対話相手を指す列は混同を避けるため `sessions.persona_id` としています。
  プロセス再起動時に `running` のまま残っていたサブエージェントは、セッションを開いた時点で `aborted` に遷移させます（`tools/subagent-restore.ts`）。
- **ツールレジストリの分離（`tools/registries.ts`）**：セッションは `main` と `subagent` の 2 つの `ToolRegistry` 実体を持ちます。
  MCP や `pdf_read_pages` などの共有ツールは両方に入れ、`identity`、`agent_create`、`routine_*`、`mcp_*` のようにセッション外や親の状態を書き換えるツールは `main` のみに登録します。
  単一レジストリのフィルタリングにしなかったのは、MCP の非同期ディスカバリがメイン側と `TaskHub` 側に独立して届く際の初期化競合を防ぐためです。

### システムプロンプトと動的コンテキスト

- **決定的なシステムプロンプトの再導出（`agent/session-prompt.ts`）**：システムプロンプトはモード、ワークスペース、stella の `role`、生成 UI 設定のみから決定的に導出し、セッションを開くたびに再計算して差分があるときだけ保存値を更新します。
  作成時スナップショットに固定すると、長期間使い続ける stella の会話にプロンプト改善が届かなくなり、逆に毎回変わる値を入れるとプロバイダーのキャッシュ済みプレフィックスを毎ターン破棄してしまうためです。
- **変化する情報の context メッセージ化**：現在日付（`agent/date-context.ts`）、モデル名（`agent/model-context.ts`）、回答言語（`agent/language-context.ts`）、`AGENTS.md` の指示（`packages/core/memory/instructions.ts`、上限 32 KiB で `packages/core/memory/agents-md.ts` が探索）、利用可能スキル一覧（`skills/catalog.ts`）、共有フォルダー一覧はすべて会話内の `context` メッセージとして注入します。
  またシステムプロンプトに汎用ガイドライン節は置かず、1 回の呼び出し契約は各ツールの `description` に持たせます。

### コンテキスト圧縮、出力上限調整、ランタイム制御

- **チェックポイント方式のコンテキスト圧縮（`ai/context-compaction.ts`）**：入力上限（models.dev の `limit.input`）から出力予約分（`reserveTokens`）を引いたしきい値に達すると、過去の行を削除せず `checkpoint` メッセージを挿入します。
  モデルとメモリ（`MessageRepo.listModelView`）には最新チェックポイント以降だけを載せ、画面での過去遡りは `session/transcript-pager.ts` が SQLite からページ単位で取得します。
  要約形式は code mode では作業ログ、stella では会話記録と連続ツール呼び出しの件数行（`agent/stella-compaction.ts`、作業履歴が完全に消えるとモデルが同じ作業を再実行するため）とします。
- **アイドル時圧縮と履歴縮小**：stella では最後のメッセージから 10 分経過かつコンテキストが 50k トークン以上のとき、次回応答の待ち時間とコストを抑えるためバックグラウンドで全文を圧縮します（`agent/factory.ts` の `STELLA_IDLE_COMPACTION`、圧縮中に会話が動けば破棄）。
  チェックポイントより前の行は既定ですべて保持し、設定「圧縮した区間も残す」をオフにしたときだけ非表示ペイロードを削ります（`session/prune.ts`）。
  空き領域の回収は終了時にマーカーを置き、次回起動時に `VACUUM INTO` とファイル置換で行います（`db/vacuum.ts`）。
- **出力上限の予約と自動回復（`ai/budget.ts`、`ai/output-cap-recovery.ts`）**：プロバイダーは「入力トークンと最大出力トークンの合計」でコンテキスト上限を判定するため、リクエストの完了上限は圧縮予約枠と残り余地の小さい方に絞ります。
  見積もり誤差で上限超過エラーが返った場合は、エラーメッセージから収まる出力上限を再計算し、履歴を汚さず最大 2 回まで自動再送します。
- **即時停止とリトライ（`ai/agent.ts`、`ai/retry-policy.ts`）**：ループ検知時は脱出を促す通知を挟み、空応答が続いた場合は無言終了させず `session_error` を出します。
  `abort()` は停止信号を守らないツールがあってもその場で run を閉じ、後から返った結果を `abandonedRunId` で破棄して次のプロンプトや巻き戻しを妨げません。
  HTTP 429 は指数バックオフで再試行し、MCP 呼び出し（上限 120 秒、`mcp/client.ts`、`mcp/manager.ts`）はトランスポート切断時のみ再接続して再送します。

### Scripting tool call（`execute`）

実験的機能の `code_execution_enabled` を有効にすると、モデルに渡すツールを `execute`（`tools/execute.ts`）1 つに集約します。
プリロード済みツールとオンデマンドレジストリの双方を `tools/catalog.ts` の `ToolCatalog` が単一の `tools.*` 名前空間として公開し、プリロード分の TypeScript 型宣言（上限 12,000 文字、`tools/sdk.ts`）をシステムプロンプト末尾に付加します。

- **隔離された実行環境**：code mode ではサーバー内の JS サンドボックス（`tools/js-sandbox.ts`）、stella ではコンテナ内の `node`（`packages/core/code-execution/vm.ts`）でスクリプトを走らせます。
  stella でのツール呼び出しに HTTP 折り返しを使わず `podman exec` の標準入出力（`vm/channel.ts`）を使うのは、コンテナからホストへの待ち受けポートを開かずに隔離を維持し、実行終了とともにプロセスを確実に閉じるためです。
- **セッションストア**：スクリプト間で値を受け渡す `store(key, value)` / `load(key)` は、コンテナ再作成でも失われないようホスト側 SQLite の `code_store` テーブルにトランザクション保存します（`packages/core/code-execution/store.ts`）。

### スキル、Web 検索、アセット、資格情報と認証

- **スキル（`skills/`）**：専用の作成ツールは設けず、通常のファイル操作ツールと組み込みスキル `skill-authoring`（`packages/core/skills/builtin/skill-authoring.ts`）で `SKILL.md` を読み書きします。
  Lumisca 用スキルフォルダーは `Sandbox` の `extraRoots` に絶対パス専用で追加し、ワークスペース内の同名ディレクトリとの衝突を避けます。
- **Web 検索（`websearch/`、`tools/web.ts`）**：Exa、Tavily、Brave、Perplexity、TinyFish に対応し、保存前の疎通確認を通ったプロバイダーのみ登録できます。
  直接フェッチ（`websearch/direct-fetch.ts`）では SSRF 防止のためリダイレクト先を含めて `localhost` とプライベート IP を拒否します。
- **アセットと画像保存（`session/asset-dir.ts`、`packages/core/media/stored-image.ts`）**：DB のメッセージ履歴に入る画像は容量肥大化を防ぐため長辺 1568px、1 MiB 以下に縮小して保存し、ユーザーへ渡す添付ファイル（`tools/attach.ts`：1 件 4 MiB、1 回 10 件、合計 16 MiB 上限、累計上限なし）や `visual` 画像は専用ディレクトリへ原寸のまま複製します。
  stella への大容量プロンプト添付（最大 1 ファイル 2 GiB、合計 4 GiB）は 8 MiB チャンクと SHA-256 検証で一時領域へ受け、コンテナの stdin へストリーム書き込みします（`packages/web/src/prompt-upload.ts`、`packages/server/routes/prompt-uploads.ts`、`packages/core/vm/uploads.ts`）。
- **資格情報の暗号化（`packages/core/settings/secrets.ts`）**：設定ファイル内の API キー、OAuth トークン、MCP 設定、接続先情報、Web Push 鍵などは、バックアップ流出に備えて設定キー名を AAD とする AES-256-GCM（`enc.v1.<base64url>`）で暗号化します。
  マスターキーは環境変数、systemd クレデンシャル、`secret.key`（0600）、またはデスクトップ版の OS キーチェーンから供給します。
- **ChatGPT OAuth（`models/chatgpt/`）**：Sign in with ChatGPT のトークン共有フローにより、サブスクリプション枠で OpenAI Responses API（`ai/stream.ts`）を利用します。
  動的クライアント登録、PKCE、JWKS による ID トークン検証、ログイン時の利用可能モデル一覧取得を行い、ローテーションされるリフレッシュトークンは期限 60 秒前に単一フライトで更新します。

## 3. 仮想マシンと stella モード（`core/vm`、`share`、`routine`）

### エージェント単位コンテナと省電力制御

1 台のコンテナ内に複数の仮想デスクトップ枠を共有する方式では枠の枯渇や他会話のブラウザ強制終了が起きるため、エージェントごとに独立したコンテナ `lumisca-stella-<agentId>`（X サーバー `:99`、ウィンドウマネージャ、D-Bus、専用プロファイルの Chromium、x11vnc）を持つ構成としています。

- **共有ホームと個別領域の分離**：全コンテナが単一ボリューム `lumisca-stella-home` を `/home/agent` にマウントし、ファイル、スキル、環境変数を共有します。
  一方、作業ディレクトリ（`/home/agent/agents/<id>`）、ブラウザプロファイル、`XDG_CACHE_HOME`（AT-SPI ソケットの衝突防止）はエージェントごとに分けます。
  旧版の単一コンテナが残っていた場合は、初回起動時にホームデータをボリュームへ移行したうえで削除します。
- **遅延起動、アイドルスリープ、リソース制限**：サイドバーで会話を閲覧するだけではコンテナを起動せず、5 分の無操作で自動停止します（noVNC のフレーム要求は操作に含めず、実際の入力イベントのみを計測）。
  コンテナ内の暴走がホストの OOM killer を誘発しないよう、cgroup でメモリ 3 GiB、スワップなし、PID 上限 2048 を課し、不一致のコンテナは次回起動時に再作成します。
  状態確認は 3 秒ごとのポーリング負荷を抑えるため 1 回の `inspect` にまとめ、契約検証の成功結果を 30 秒キャッシュします。
  コンテナ内では Chromium サンドボックスを有効に保つため非 root ユーザー `agent` を既定としつつ、パッケージ導入用にパスワードなし `sudo` を許可します（`--userns keep-id` によりホスト側では非特権のまま隔離）。
- **エージェントごとの MCP サーバー（`mcp/machine.ts`、`vm/mcp-runner.ts`）**：MCP の一覧は 2 つに分かれます。
  アプリ全体の一覧はホスト側で動き、全エージェントと code mode が使います。
  エージェント専用の一覧は設定キー `mcp_servers:agent:<id>` に暗号化して保存し、そのプロセスはエージェントのマシンの中で動きます。
  stdio サーバーは `podman exec --interactive` で起動して標準入出力を MCP のパイプにし、HTTP サーバーはホストの `127.0.0.1` で待ち受けて接続ごとにコンテナ内の `node -e` で対象へ中継します。
  接続の前にマシンを起こして作業フォルダを用意し、停止でプロセスが消えた場合は呼び出し失敗時の再接続で起こし直します。
  `command` を持つサーバーはマシンに属するため必ずエージェント専用になり、`url` を持つサーバーは既定でアプリ全体に入ります。
  情報パネルは `GET /api/stella/agents/:id/mcp` を読み、専用の一覧を先に表示し、同名の共通エントリは専用が優先されるため表示しません。

### 対話相手、記憶、会話ストリームと生成 UI

- **`role`、`identity`、`MEMORY.md` の分担**：作成時にユーザーが与える `role` はシステムプロンプトへ固定します。
  対話を通じて決まる振る舞い方針（初回オンボーディング `stella/onboarding.ts` でモデルが最大 5 問の範囲でカード質問して記録）は毎ターン届く `identity` に書き、肥大化する作業メモは必要時にファイルツールで読み書きする `MEMORY.md` に置くことで、毎リクエストのトークン消費を抑えます。
  モデルの選択は会話を開く前でも変更できるよう `stella_agents` 側に持たせ、未設定時はアプリの既定モデルへ委譲します。
- **配信境界での射影と生成 UI**：stella の会話 API（`domain/stella-conversation.ts`、`agent/stella-stream.ts`）は、サーバー側の配信境界（`stellaEventsOf` / `stellaEntryOf`）でツール呼び出し前のナレーションや内部イベントを除外し、ユーザー発言と最終応答および `send_chat` だけをクライアントへ届けます。
  インタラクティブ UI は追加のツール往復を省くため応答本文内の ```` ```ui ```` JSON フェンスとして記述させ、`shared/ui-app/` のスキーマ検証とグラフ検証を通過したものだけを描画します。
  不正な JSON UI は保存せず最大 2 回までモデルに自動再生成させます。
  安全境界を保つため HTML や任意スクリプトは仕様に含めず、カードの状態はクライアントメモリのみで完結させます。

### GUI の意味操作、受け渡し、クリップボード、`vm_env`

- **AT-SPI による意味操作（`vm/semantic.ts`、`vm/container/a11y.py`）**：座標クリックは視覚的に似た要素の誤操作や結果確認の曖昧さを招くため、GTK と Chromium のアクセシビリティツリーからロールと名前でウィジェットを特定する `vm_find` / `vm_do` / `vm_wait` を主経路とし、ピクセル操作（`vm_screenshot` / `vm_act`）はキャンバス等に限定します。
- **画面の受け渡し（`vm_ask_user`）とクリップボード**：ログインや CAPTCHA など人手が必要な場面では、`HandoverHub`（`vm/handover.ts`）が run を一時停止して画面ペインの操作権をユーザーへ渡します（ルーチンの詰まりを防ぐため 15 分でタイムアウトし、モデルに代替手段を選ばせます）。
  x11vnc の標準クリップボードは ISO 8859-1 しか扱えず日本語が文字化けするため、文字の受け渡しは HTTP API 経由でコンテナ内の `xclip`（stdin 渡しと読み戻し確認、`vm/clipboard.ts`）を直接読み書きします。
- **秘密の環境変数（`vm_env`）**：API キー等を LLM の履歴や DB に残さないため、エージェントは変数名だけを要求し、ユーザーがダイアログに入力した値を `vm/env-store.ts` がコンテナ内の `.lumisca-env/` へ直接書き込みます。
  エージェント自身がシェルから値を参照できる点は隠さず、「会話ログ、ツール引数、DB に秘密値が残らないこと」を保護境界としています。

### ローカルフォルダー共有（`/lend`）とルーチン

- **名前空間合成によるフォルダー共有（`packages/core/share/`、`packages/server/share-host.ts`）**：デスクトップアプリを開いている PC のフォルダーを、リモートを含むサーバー上のセッションへ `/lend/<name>` として一時マウントします。
  別のツール群を作るのではなく、`MountedFiles` と `MountedRunner` を既存のポート層に挟むことで全ファイルツールを無変更で対応させています。
  サーバーからクライアント PC へは接続できないため、デスクトップシェルが起動する子プロセス（`lumisca-server share`）からサーバーの `/api/share/host` へ単一接続を張り、OS 間のパス差を吸収するため相対セグメントのみで通信します。
  同意状態はデスクトップ側のメモリのみに置き、最終アクセスから 30 分（またはアプリ終了、切断）で自動的に失効させます。
- **ルーチン（`packages/core/routine/`）**：cron 式は複雑さと誤設定を招くため採用せず、`daily`、`weekly`、`every`、`once`、`watch` の 5 種に絞っています。
  `watch` の変化確認は推論コストを払わずサーバー側で実行し、特に `mcp` 監視はコンテナを起動せずにサーバーの MCP 接続（読み取り専用ツールに限定、`mcp/service-checks.ts`）で ID 集合の差分を検知して、新着があったときだけコンテナを起こしてターンを実行します。
  会話実行中のルーチンは最大 1 本、1 時間まで待機し、超過時はスキップ理由を記録します。

## 4. Web クライアントとデスクトップシェル（`web`、`desktop`）

### URL 駆動ルーティング、状態管理、データ同期

- **URL を基準とする画面管理**：開いていたタブ一覧や設定の表示状態を `localStorage` やコンポーネント state に二重保持するとブックマークやブラウザの「戻る」と食い違うため、URL（`packages/web/src/route.ts`）に一本化しています。
  `/` は最後に使ったモード（`hooks/useAppMode.ts`）への解決入口としてのみ機能します。
- **ストア階層と履歴の取得範囲**：複数画面で共有するリソース（言語、モデルカタログ `modelCatalog.ts`、保存プロンプト）は `packages/web/src/store.ts` のモジュールストアに置き、画面固有の状態は `useState` に閉じます。
  再接続時の状態復元（`GET /sessions/:id/messages`）では、長大な会話による通信と描画の停止を防ぐため直近 1 ページ分（`packages/core/session/transcript-window.ts`）のみを取得し、圧縮でずれないメッセージ同一性カーソルで過去分を遅延取得します。
  ターン開始判定（`startsTranscriptTurn`）はサーバーとクライアント（`components/chat/ConversationTurn.tsx`）で単一の定義を共有します。
- **WAN 越しのストリーミング平滑化**：1 トークンごとの細かな WebSocket フレームは Tailscale や WAN 越しでは TCP 確認応答の塊となって飛ぶように描画されるため、送信側で 16ms バッチ化（`packages/core/shared/ws-batch.ts`）し、受信側でも `requestAnimationFrame` 単位で DOM 更新とスクロール追従を間引いています。
- **入力欄とレスポンシブ設計**：コンポーザの自動伸縮（`hooks/useAutoGrow.ts`）は WKWebView の互換性のため CSS `field-sizing` を使わず JS と `ResizeObserver`（`scrollbar-gutter: stable` 併用）で計算し、12 行および画面高 45% を上限とします。
  進捗パネル（`.progress-panels`）はタイトルバー右上の接続先ピッカーと重ならないようコンポーザ直上に配置し、画面幅は 900px（タブレット）と 600px（スマートフォン）の 2 段階で折り返します。

### デスクトップ接続管理とシェルブリッジ

- **ウィンドウ単位の接続先管理（`packages/desktop/src-tauri/src/connection.rs`）**：接続先サーバーの一覧と現在の選択は、サーバーの DB ではなくデスクトップ側の `settings.json` に保持します。
  起動時に前回のリモート接続先が応答しない場合も黙ってローカルへ切り替えず、再試行かローカル起動かを明示的に選ばせます。
  また `connect_epoch` により非同期復元の追い越し上書きを防ぎます。
- **loopback HTTP ブリッジと IPC フォールバック（`bridge_server.rs`、`packages/web/src/shell.ts`）**：配信ページからシェルを操作する経路に独自スキーム（`lumisca://`）を使わないのは、macOS の WKWebView が http(s) ページからの独自スキーム `fetch` を拒否するためです。
  基本は `127.0.0.1` のランダムポート HTTP を使い、HTTPS リモートページで WebKit の混在コンテンツ遮断が起きた場合のみ Tauri IPC へ退避します。
  プラットフォーム種別（`__LUMISCA_PLATFORM__`）を初期化スクリプトで同期注入するのも、通信失敗時にフレームレスウィンドウが操作不能になるのを防ぐためです。

## 5. サーバーの通信、通知、配布（`packages/server`）

- **スキーム非依存の同一サーバー判定（`security.ts`）**：`tailscale serve` やリバースプロキシ配下ではブラウザの `Origin` が `https:`、バックエンドに届くリクエストが `http:` になるため、`sameServerAuthority` はホストとポートの一致のみで検証します。
  認証 Cookie 名もポート番号ごとに分離し（`auth-cookie.ts`）、同一ホスト上の複数インスタンス干渉を防ぎます。
- **PWA 配信と `buildId` による更新誘導（`manifest.ts`、`assets.ts`）**：アドレスバーも再読み込みボタンも持たない PWA ウィンドウが古いクライアントバンドルのまま動き続けるのを防ぐため、`app.js` の ETag を `buildId` として `GET /api/build` で公開し、不一致を検知したら再読み込みバナーを出します（実行中のセッションを切らないよう自動リロードは行いません）。
- **Web Push の役割分担（`push.ts`、`packages/core/notify/web-push.ts`）**：複数端末のフォーカス状態をサーバー側で正確に追跡することはできないため、サーバーは常に暗号化プッシュを送信し、可視ウィンドウが開いているかどうかの抑止判定は端末上の Service Worker に委ねます。
  モバイル通知で視認しやすいよう、タイトルにはエージェント名（またはセッション名）、本文には応答冒頭を載せます（`packages/core/agent/run-reply.ts`）。
- **正常停止とバージョン整合性**：`shutdown.ts` は `SIGTERM`（終了コード 0）と `SIGINT`（130）で未完了処理を最大 5 秒待機し、2 回目のシグナルで即時終了します。
  バージョン番号は `packages/desktop/package.json`、`packages/desktop/package-lock.json`、`packages/desktop/src-tauri/tauri.conf.json`、`packages/desktop/src-tauri/Cargo.toml`、`packages/server/version.ts` の 5 箇所で管理し、`scripts/check-versions.ts` が一致を保証します。

## 6. 技術選定と採用しなかった選択肢

### 主要依存の位置づけ

- **`bun:sqlite`**：同期 API のためイベントループをブロックしますが、単一ユーザー利用を前提にトランザクションを短く保ち、全行走査を起動時と圧縮時に限定して運用します。
- **`esbuild`（`packages/server/bundle.ts`）**：開発時も本番時も単一のバンドル経路を使い、開発時は `scripts/dev.ts` がファイル変更でキャッシュを破棄します。
- **`sucrase` と `@napi-rs/canvas`**：`sucrase` は `eval` 等での TypeScript 変換専用（遅延 import のため起動コストなし）、`@napi-rs/canvas` は PDF 描画専用として厳密なバージョン固定で管理します。
- **Rust のロック復旧**：デスクトップシェルのスレッド間排他はすべて `packages/desktop/src-tauri/src/lib.rs` の `LockRecover::lock_recover()` を通し、Poison 状態によるデッドロックを防ぎます。

### 検討のうえ採用しなかった選択肢

同じ議論を繰り返さないための記録です。
覆す場合は前提条件の変化を先に確認してください。

- **`node:sqlite` への移行**：Bun の `node:sqlite` は `close()` 時にプリペアドステートメントを解放せず、Windows で DB ファイルが `EBUSY` のまま残り起動時 vacuum やテスト後処理が失敗するため、`bun:sqlite` の `close(true)`（`db/close.ts`）を使います。
- **Hono 以外の HTTP フレームワーク**：ルーティング、圧縮、WebSocket、CORS、フェデレーションプロキシ、セキュリティガードが単一のミドルウェア列で統合されており、置き換える実利がありません。
- **`preact/compat` の廃止や `@preact/signals` の導入**：多数のコンポーネントが `useSyncExternalStore`、`flushSync`、`memo` に依存しており、共有状態も `packages/web/src/store.ts`（重複排除、楽観更新、差分通知を内包）で十分に簡潔なため、フレームワーク層の変更は行いません。
- **`packages/core` の物理パッケージ分割**：ブラウザ境界は `browser-entries.ts`、内部の非循環性は `repo_hygiene_test.ts` の DAG 検査で保証できており、`bun build --compile` の構成を複雑にしてまで物理分割する利点がありません。
- **`LumiscaCore` ファサードの廃止**：実処理は `services/` に分離済みですが、ファサードを無くすと `packages/core/mod.ts` の公開面がルートごとに散らばるため維持しています。
- **`packages/core/shared/i18n/settings.ts` の細分化**：行数（約 1,000 行）は責務の多さではなく純粋な辞書データであり、分割するとキーの検索性と未使用キー検査の見通しが悪化します。
- **`browser-rpc` クレートの `src-tauri` への統合**：独立クレートにしておくことで、TypeScript 側とのプロトコル定数突き合わせテスト（`packages/core/browser/types_test.ts`）が境界検査として機能します。
- **フォルダー共有（`/lend`）の別方式**：Rust 側でのファイルやシェルの再実装（`HostFileBackend` 等との二重実装になる）、サーバー DB への貸出状態保存（アプリ終了後も存在しないパスを指し続ける）、WebView 経由での中継（リロードで切断され大容量転送に向かない）、ローカルサーバー常時起動によるフェデレーション（共有のためだけに DB 付きサーバーを二重起動することになる）はいずれも採らず、`lumisca-server share` サブコマンド方式を採用しています。
- **`AGENTS.md` と `ARCHITECTURE.md` の統合**：作業中に参照する手順や制約と、設計の背景理由では読者と読むタイミングが異なり、統合すると毎回のエージェントコンテキストを圧迫するため分離を維持します。
