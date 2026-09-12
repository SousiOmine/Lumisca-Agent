# ARCHITECTURE.md — Lumisca-Agent 構成概要

## パッケージ

| パッケージ | 役割 | 依存 |
|---|---|---|
| `core/` | 基盤：SessionAgent／SessionPool(AgentFactory)／ModelManager／MCP／ツール群／SQLite／スキル・プラグイン | 外部のみ |
| `server/` | Hono製バックエンド（REST＋WS＋federationプロキシ＋esbuildバンドル） | `core` |
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
- `agent/`：`SessionAgent`（プロンプト・タイトル・MCP・通知）＋ `RetryManager`（空応答／429リトライ）＋ `GoalRunner`（自律ゴールループ）＋ `AgentFactory`（配線）＋ `SessionPool`（ライフサイクル）。
- `ai/rate-limit.ts`：429判定・バックオフ・リトライループの唯一の実装（トランスポート／セッション／サブエージェントが共有）。`agent/llm-retry.ts` はそこへ委譲するassistantメッセージ版。
- `goal/loop.ts`：`runGoalLoop`＋`finishGoal`（全終了パス統一）。
- `tools/system-prompt.ts`：coding／chatプロンプトは `sharedGuidelines` を共有。
- `tools/gitignore.ts`：`loadCachedGitignore(sandbox)` が `.gitignore` の解析結果をSandbox単位でキャッシュする（stamp不一致＝ファイル変更で再読込）。
- `shared/`：フロント安全ヘルパー（esbuildでwebバンドルに取込）。`misc.ts` は errors／json／text／models／bootstrap／async の節分け。
- `shared/context-usage.ts`：コンテキストメーターの唯一の計算実装。`Usage.input` は**未キャッシュ**のプロンプト入力で、1ターンのプロンプトは `input + cacheRead + cacheWrite`（`ai/types.ts` の契約。ここを混同するとメーターが2倍に膨らむ）。
- `settings/keys.ts` 相当：**設定キーの単一情報源は `shared/settings-keys.ts`**（`APP_MCP_SETTINGS_KEY` 等もここ）。テーマ等のUIキーも同じファイル。
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

アプリのバージョンは7つのマニフェスト（`packages/{core,server,web}/deno.json`、
`desktop/deno.json`、`desktop/package.json`、`tauri.conf.json`、`Cargo.toml`）に載る。
`scripts/check-versions.ts` が唯一の検査実装で、`ci.yml`（変更のたび）と
`release.yml`（タグ）の両方がこれを呼ぶ。
