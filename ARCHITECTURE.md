# ARCHITECTURE.md — Lumisca-Agent 構成概要

## パッケージ

| パッケージ | 役割 | 依存 |
|---|---|---|
| `core/` | 基盤：SessionAgent／SessionPool(AgentFactory)／ModelManager／MCP／ツール群／SQLite／スキル・プラグイン | 外部のみ |
| `server/` | Hono製バックエンド（REST＋WS＋federationプロキシ＋esbuildバンドル＋自己更新） | `core` |
| `web/` | Preact SPA（`api-client`／`api-local`／`api-federation`／`api-routing` 分割） | `core/shared`＋`core/modes` のみ |
| `desktop/` | Tauri v2シェル（npm＋Deno併用） | `server` を子プロセス起動 |
| `browser-rpc/` | Rust製ブラウザラボRPC（プローブ抽出／URLポリシー／HTTPサーバー） | — |

`core` は他のパッケージに依存しない。`web` が `core` から取るのは
**純関数のみ**（`shared/`＝フロント安全ヘルパー、`modes/`＝プロンプト生成）で、
どちらも esbuild / Vite の alias で解決される（`server/bundle.ts`、
`web/vite.config.ts`）。型だけの `@lumisca/core` import は実行時に消える。

## web内部

- `modelCatalog.ts`：プロバイダー／モデルカタログの**共有ストア**（peer単位）。設定のモデル一覧・モデルピッカー・チャットビューはここだけを読み、再マウント（設定ダイアログの開き直し、タブ切替）でも取り直さない。したがって**変更は必ずストアへ書き戻す**（`applyModelEnabled`。トグルUIは `providers.ts` の `setModelEnabled` を通す）。コンポーネントローカルに持つと、その変更はコンポーネントと共に消える。

## core内部

- `LumiscaCore`：薄いファサード＋コンポジションルート（コンストラクタで全協調者を束縛、テスト時は差替可）。
- `agent/`：`SessionAgent`（プロンプト・タイトル・MCP・通知）＋ `RetryManager`（空応答／429リトライ）＋ `GoalRunner`（自律ゴールループ）＋ `AgentFactory`（配線）＋ `SessionPool`（ライフサイクル）。`agent/context-providers.ts` の**動的コンテキスト**（スキルカタログ・AGENTS.md）はプロンプトではなく `context` メッセージとして履歴に積み、値が変わったときだけ再発行する（DSHの`PromptContext`相当）。
- `ai/rate-limit.ts`：429判定・バックオフ・リトライループの唯一の実装（トランスポート／セッション／サブエージェントが共有）。`agent/llm-retry.ts` はそこへ委譲するassistantメッセージ版。
- `goal/loop.ts`：`runGoalLoop`＋`finishGoal`（全終了パス統一）。
- `tools/prompt-sections.ts`：システムプロンプトのガイドライン節。各節は `requires`（必要なツール名）を持ち、**そのセッションが実際に持つツールの節だけ**が描画される。ツールの `description` は「1コールの契約＋失敗マーカー」、横断的な振る舞い規範はここ、という分担（`tools/system-prompt.ts` は組み立てだけ）。
- `tools/gitignore.ts`：`loadCachedGitignore(sandbox)` が `.gitignore` の解析結果をSandbox単位でキャッシュする（stamp不一致＝ファイル変更で再読込）。
- `shared/`：フロント安全ヘルパー（esbuildでwebバンドルに取込）。`misc.ts` は errors／json／text／models／bootstrap／async の節分け。
- `shared/context-usage.ts`：コンテキストメーターの唯一の計算実装。`Usage.input` は**未キャッシュ**のプロンプト入力で、1ターンのプロンプトは `input + cacheRead + cacheWrite`（`ai/types.ts` の契約。ここを混同するとメーターが2倍に膨らむ）。
- `settings/keys.ts` 相当：**設定キーの単一情報源は `shared/settings-keys.ts`**（`APP_MCP_SETTINGS_KEY` 等もここ）。テーマ等のUIキー、サーバー単体の自動アップデート設定（`UPDATE_AUTO_KEY` / `UPDATE_AUTO_RESTART_KEY`）も同じファイル。

## server内部

- `systemd/`：パッケージ済みサーバーをLinuxの systemd **ユーザーユニット**として常駐させる `service` サブコマンド（`install` / `config` / `status` / `uninstall`）。定義は**3層の合成**で、順序の単一情報源は `systemd/compose.ts`：
  1. `systemd/template.ts` の同梱ユニットテンプレート（`deno compile` が単一バイナリに内包するためテンプレートもTS定数）
  2. 設置済みの `<config home>/lumisca-agent/service.env`（0600。トークンの引き継ぎ元で、運用者が編集してよい層）
  3. 起動時フラグ（`--host` / `--port` / `--db` / `--allowed-hosts` / `--token`）

  `config` は 1+2+3 を表示するだけで何も書かない（トークンは伏せる）。`install` は同じ合成結果を書いて `systemctl --user enable/restart` し、linger まで確認する。非ループバックで待ち受けるには `--allowed-hosts` が必須（Hostガードが伝えられていないホスト名を403にするため）。詳細な使い方は `AGENTS.md`。
- `shutdown.ts`：停止契約の単一実装。`SIGTERM` は監視側の通常停止要求として **0**、`SIGINT` は **130**、drain は 5 秒で打ち切り、2回目のシグナルで即時終了。ユニットの `TimeoutStopSec=10` が外側の上限。
- `startup.ts`：`DEFAULT_HOST`（loopback）/ `DEFAULT_PORT` と、`LUMISCA_UPDATE_RESTART` の解釈（`self` / `supervisor` / `none`）の単一情報源。`parsePortValue` はランチャーと `service --port` の共通検証。
- `update/service.ts`：`supervisor` モードでは後継プロセスを spawn せず、shutdown → `exit(0)` だけ行う（systemd の `Restart=always` が新バイナリを起動する。同一 cgroup で spawn すると監視側と競合する）。
- `fs.ts`：`readIfExists` / `resolveGlobalDirs` / `isRecord` / `atomicWriteTextFileSync`（バックエンド専用。`shared/` は Deno API を持ち込まないためここに置く）。
- `base64.ts`：`bytesToBase64`（画像読取・PDF描画の共有）。

## 依存メモ

- `sucrase` はevalツール専用（TS→JS変換）。esbuild代替不可（TS 7がtranspile APIを公開しないため）。
- `@napi-rs/canvas` はPDF描画専用（動的import、要 `--allow-ffi`）。
- `preact/compat` はweb全体のReact互換層として使用中。削除不可。
- `ai/test` は未使用のため削除済み。
- `browser-rpc/cdp.rs` はデスクトップのブラウザラボが使うCDPパラメータ生成／応答解釈（`browser_lab.rs` の同期呼び出しから切り離し、解釈を一箇所に保つ）。
- `desktop/src-tauri/pane.rs` はドックペインのジオメトリとOS依存の配置（z-order、仮想デスクトップ固定）。

## バージョン

アプリのバージョンは8つのマニフェスト（`packages/{core,server,web}/deno.json`、
`desktop/deno.json`、`desktop/package.json`、`tauri.conf.json`、`Cargo.toml`、
`packages/server/version.ts`）に載る。最後の1つは `deno compile` 済みサーバーが
実行時に読む定数で（バイナリはリポジトリのマニフェストを持たない）、
自動アップデートの比較対象になる。`scripts/check-versions.ts` が唯一の検査実装で、
`ci.yml`（変更のたび）と `release.yml`（タグ）の両方がこれを呼ぶ。
