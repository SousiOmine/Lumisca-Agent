# ARCHITECTURE.md — Lumisca-Agent アーキテクチャ概要

## 1. パッケージ構成

| パッケージ | 主な役割 | 依存関係 |
|---|---|---|
| `core/` | 基盤機能：SessionAgent、SessionPool（AgentFactory）、ModelManager、MCP、ツール群、SQLite、スキル／プラグイン管理 | 外部ライブラリのみ |
| `server/` | Honoベースのバックエンド：REST API、WebSocket、フェデレーションプロキシ、esbuildによるバンドル、自己アップデート機能 | `core` |
| `web/` | PreactによるSPA（`api-client`、`api-local`、`api-federation`、`api-routing` に責務を分離） | `core/shared` および `core/modes` のみ |
| `desktop/` | Tauri v2ベースのデスクトップシェル（npmとDenoを併用） | `server` を子プロセスとして起動 |
| `browser-rpc/` | Rust製ブラウザ連携用RPC：プローブ抽出、URLポリシー制御、HTTPサーバー機能 | なし |

### 依存関係の原則
- `core` は他の内部パッケージに依存しません。
- `web` が `core` から直接取り込むモジュールは**純粋関数のみ**に限定されています（フロントエンドで安全に実行できるヘルパー群である `shared/`、およびプロンプト生成を担う `modes/`）。これらはビルド時（`server/bundle.ts` の esbuild、および `web/vite.config.ts` の Vite）のエイリアス設定によって適切に解決されます。
- 型定義のみをインポートしている `@lumisca/core` の参照はコンパイル時に除去されるため、実行時のオーバーヘッドはありません。

---

## 2. web パッケージの設計方針

- **`modelCatalog.ts`（モデルカタログの共有ストア）**  
  接続先（ピア）ごとのプロバイダーおよびモデル情報を一元管理する共有ストアです。設定ダイアログのプロバイダー／モデル一覧、モデルピッカー、チャットビューなどの全UIコンポーネントは、このストアを一貫して参照します。設定画面の開き直しやタブの切り替えなどで再マウントされても再フェッチは行われません。  
  そのため、**モデルの変更操作は必ず本ストアへ書き戻す必要があります**（内部的には `applyModelEnabled` を使用し、トグルUIからは `providers.ts` の `setModelEnabled` を経由して実行します）。状態をコンポーネント内のローカルステートに持たせてしまうと、画面遷移やアンマウント時に変更内容が消失するためご注意ください。

---

## 3. core パッケージの設計方針

- **`LumiscaCore`**  
  薄いファサード（Facade）かつコンポジションルート（Composition Root）として機能します。コンストラクタで協調動作する各コンポーネントをバインドしており、テスト時には容易にモックやスタブへ差し替えることができます。
- **`agent/`**  
  `SessionAgent`（プロンプト生成・タイトル付与・MCP・通知処理）、`RetryManager`（空応答や429エラーのリトライ制御）、`GoalRunner`（自律的なゴール達成ループ）、`AgentFactory`（配線処理）、`SessionPool`（エージェントのライフサイクル管理）で構成されます。  
  なお、`agent/context-providers.ts` で扱う**動的コンテキスト**（スキルカタログや `AGENTS.md`）は、プロンプトに直書きせず `context` メッセージとして履歴スタックに追加し、値に変更があった場合のみ再送する設計です（DSHにおける `PromptContext` と同様のアプローチです）。
- **`ai/rate-limit.ts`**  
  HTTP 429（レート制限）の判定、指数バックオフ、リトライループを担う唯一の実装です。通信トランスポート、セッション、サブエージェントの間で共有されています。`agent/llm-retry.ts` は本モジュールへ処理を委譲する形で assistant メッセージのリトライを行います。
- **`goal/loop.ts`**  
  自律ループを実行する `runGoalLoop` と、終了処理を共通化する `finishGoal` を提供し、ゴール達成・失敗・中断を含むすべての終了パスを統一してハンドリングします。
- **`tools/prompt-sections.ts`**  
  システムプロンプト内のガイドライン節を定義します。各セクションは `requires` プロパティ（必要なツール名）を保持しており、**現在のセッションで有効化されているツールに対応する節のみ**がプロンプトへレンダリングされます。各ツールの `description` は「1回の呼び出し規約と失敗判定マーカー」に留め、ツール横断的な行動規範や共通ポリシーは本モジュールに集約しています（`tools/system-prompt.ts` はその組み立てのみを担当します）。
- **`tools/gitignore.ts`**  
  `loadCachedGitignore(sandbox)` により、`.gitignore` の構文解析結果をサンドボックス単位でメモリ上にキャッシュします。タイムスタンプが不一致（ファイルの更新を検知）となった場合のみ再読み込みを行います。
- **`shared/`**  
  フロントエンドでも安全に動作する共通ヘルパー群です（esbuild により web バンドルへ取り込まれます）。`misc.ts` はエラー処理、JSON、テキスト操作、モデル定義、ブートストラップ、非同期処理のカテゴリごとに明確に分類されています。
- **`shared/context-usage.ts`**  
  コンテキスト使用量メーターを計算する唯一の共通実装です。`Usage.input` は**キャッシュされていない**プロンプト入力トークン数を表しており、1ターンの総プロンプトトークン数は `input + cacheRead + cacheWrite` として算出されます（`ai/types.ts` の仕様に準拠）。この仕様を取り違えると使用量が本来の倍で見積もられてしまうため、本関数を通じて計算する必要があります。
- **`settings/keys.ts` 相当の機能**  
  **設定キーの信頼できる単一の情報源（SSOT）は `shared/settings-keys.ts` です**（`APP_MCP_SETTINGS_KEY` などの定数もここで定義されています）。テーマなどのUI関連キーから、サーバー単体で動作する自動アップデート設定（`UPDATE_AUTO_KEY` / `UPDATE_AUTO_RESTART_KEY`）まで、すべての設定キーを同ファイルで一元管理しています。

---

## 4. server パッケージの設計方針

- **`systemd/`**  
  ビルド済みサーバーを Linux の systemd **ユーザーユニット**として常駐させる `service` サブコマンド（`install` / `config` / `status` / `uninstall`）を提供します。設定内容は以下の**3層を順に合成**して生成され、その優先順位は `systemd/compose.ts` で一元管理されています。
  1. `systemd/template.ts` に定義されたユニットテンプレート（`deno compile` で単一バイナリにパッケージングするため、テンプレートも TypeScript 定数として保持）
  2. 既存の `<config home>/lumisca-agent/service.env`（パーミッション 0600。認証トークンの引き継ぎ元であり、運用担当者が手動編集可能なレイヤー）
  3. 起動時引数フラグ（`--host` / `--port` / `--db` / `--allowed-hosts` / `--token`）

  `config` コマンドは上記 1〜3 を合成した結果を表示するのみで、ファイル書き込みは行いません（秘匿情報であるトークンはマスクされます）。`install` コマンドは合成結果をファイルに出力し、`systemctl --user enable/restart` の実行および linger 設定の有効化確認までを行います。  
  なお、ループバックアドレス以外（外部ネットワーク等）でリクエストを受け付ける場合は、Host ヘッダーのバリデーションによる 403 エラーを防ぐため、`--allowed-hosts` の指定が必須となります。詳細な運用手順は `AGENTS.md` をご参照ください。
- **`shutdown.ts`**  
  プロセスの正常停止フローを一括管理します。監視プロセス（スーパーバイザー）からの通常停止要求である `SIGTERM` 受信時は終了コード **0**、手動中断の `SIGINT` 受信時は **130** で終了します。未完了処理のドレイン処理（drain）は 5 秒でタイムアウトし、シャットダウン中に2回目のシグナルを受信した場合は即時強制終了します。なお、外側の制御としてユニット定義の `TimeoutStopSec=10` が最大タイムアウト時間となります。
- **`startup.ts`**  
  デフォルトの待受設定（`DEFAULT_HOST`（ループバック）、`DEFAULT_PORT`）、および環境変数 `LUMISCA_UPDATE_RESTART` の動作モード（`self` / `supervisor` / `none`）を定義する単一の情報源です。`parsePortValue` はランチャー起動時と `service --port` の双方で共通のポート検証ロジックとして使用されます。
- **`update/service.ts`**  
  `supervisor` モード時、自動更新後に後継プロセスを自前で spawn せず、正常シャットダウンを経て `exit(0)` のみを行います（同一 cgroup 内でプロセスを起動すると監視側と競合するため、systemd の `Restart=always` に後続プロセスの立ち上げを委ねる設計です）。
- **`fs.ts`**  
  バックエンド専用のファイル操作ユーティリティ群（`readIfExists` / `resolveGlobalDirs` / `isRecord` / `atomicWriteTextFileSync`）です。`shared/` に Deno 固有のランタイム API を持ち込ませないため、本パッケージ配下に分離して配置しています。
- **`base64.ts`**  
  画像読み込みや PDF レンダリングで共通利用される `bytesToBase64` 変換処理を提供します。

---

## 5. 依存関係および実装上の留意点

- **`sucrase`**  
  eval ツール内での TypeScript から JavaScript へのトランスパイル専用に採用しています。TypeScript 7 では transpile API が外部公開されていないため、esbuild での代替は不可としています。
- **`@napi-rs/canvas`**  
  PDF 描画処理専用モジュールです。動的インポートで読み込まれるため、実行時には `--allow-ffi` 権限が必要です。
- **`preact/compat`**  
  web パッケージ全体における React 互換レイヤーとして利用しており、依存から削除することはできません。
- **`ai/test`**  
  利用箇所が存在しないため、コードベースより削除済みです。
- **`browser-rpc/src/cdp.rs`**  
  デスクトップ版のブラウザラボ機能が使用する CDP（Chrome DevTools Protocol）のパラメータ生成および応答解析を担当します。`browser_lab.rs` の同期呼び出し処理から責務を切り離し、プロトコルの解釈ロジックを一箇所に集約しています。
- **`desktop/src-tauri/src/pane.rs`**  
  ドックペインの配置座標（ジオメトリ）の計算や、OS 固有のウィンドウ配置（Z オーダーの制御、仮想デスクトップへの固定など）を制御します。
- **Rust におけるロックの取得方針**  
  スレッドセーフなロックの取得は、すべて **`lib.rs` の `LockRecover::lock_recover()` を経由して行います**（`Mutex::lock().unwrap_or_else(|e| e.into_inner())` を個別に記述することは禁止します）。Poison 状態となったロックからの復旧ポリシーを一箇所に集約することで、Tauri コマンドがパニックによって無応答となる障害を防止しています。
- **`scripts/lib.ts`**  
  メンテナンス用スクリプト共通のヘルパー関数群（`repoRoot` / `binaryName` / `reportUsage` / `parseOptions` / `createChecker`）を提供します。`repoRoot` のパス解決には `fileURLToPath` を使用しています（`.pathname` の手動変換は、スペースを含むパスで破損するため禁止です）。
- **esbuild（本番環境）と Vite（開発環境）のデュアル構成**  
  本番用配布物のバンドル生成（`deno compile` への内包）は `server/bundle.ts`（esbuild）が担当し、開発時の HMR（Hot Module Replacement）および API プロキシ機能は `packages/web/vite.config.ts`（Vite）が担います。なお、CSS の `@import` 解決順序の仕様は両環境で厳密に一致させています（詳細は `packages/web/src/styles/README.md` を参照）。

---

## 6. バージョン管理

本アプリケーションのバージョン番号は、以下の**8つのマニフェストファイル**で定義されています。

1. `packages/core/deno.json`
2. `packages/server/deno.json`
3. `packages/web/deno.json`
4. `desktop/deno.json`
5. `desktop/package.json`
6. `tauri.conf.json`
7. `Cargo.toml`
8. `packages/server/version.ts`

`packages/server/version.ts` は、`deno compile` によって単一バイナリ化されたサーバーが実行時に自己のバージョンを把握するための定数定義です（コンパイル済みバイナリはリポジトリ内のマニフェストファイルを直接参照できないため、本ファイル値が自動アップデート時の比較基準となります）。

バージョンの整合性検証は `scripts/check-versions.ts` が唯一の実装として担っており、CI ワークフロー（`ci.yml`：コード変更の都度実行）およびリリースパイプライン（`release.yml`：タグ発行時に実行）の双方から呼び出され、不整合の発生を防止しています。