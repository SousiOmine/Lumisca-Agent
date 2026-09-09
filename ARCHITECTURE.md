# ARCHITECTURE.md — Lumisca-Agent 構成概要

## パッケージ

| パッケージ | 役割 | 依存 |
|---|---|---|
| `core/` | 基盤：SessionAgent／SessionPool(AgentFactory)／ModelManager／MCP／ツール群／SQLite／スキル・プラグイン | 外部のみ |
| `server/` | Hono製バックエンド（REST＋WS＋federationプロキシ＋esbuildバンドル） | `core` |
| `web/` | Preact SPA（`api-client`／`api-local`／`api-federation`／`api-routing` 分割） | `core/shared` のみ |
| `cli/` | Deno製CLI（REPL／run／select／browser-host） | `core` |
| `desktop/` | Tauri v2シェル（npm＋Deno併用） | `server` を子プロセス起動 |
| `browser-host/`＋`browser-rpc/` | Rust製WebViewホスト＋共通RPC | — |

## core内部

- `LumiscaCore`：薄いファサード＋コンポジションルート（コンストラクタで全協調者を束縛、テスト時は差替可）。
- `agent/`：`SessionAgent`（プロンプト・タイトル・MCP・通知）＋ `RetryManager`（空応答／429リトライ）＋ `GoalRunner`（自律ゴールループ）＋ `AgentFactory`（配線）＋ `SessionPool`（ライフサイクル）。
- `goal/loop.ts`：`runGoalLoop`＋`finishGoal`（全終了パス統一）。
- `tools/system-prompt.ts`：coding／chatプロンプトは `sharedGuidelines` を共有。
- `shared/`：フロント安全ヘルパー（esbuildでwebバンドルに取込）。`misc.ts` は errors／json／text／models／bootstrap／async の節分け。

## 依存メモ

- `sucrase` はevalツール専用（TS→JS変換）。esbuild代替不可（TS 7がtranspile APIを公開しないため）。
- `@napi-rs/canvas` はPDF描画専用（動的import、要 `--allow-ffi`）。
- `preact/compat` はweb全体のReact互換層として使用中。削除不可。
- `ai/test` は未使用のため削除済み。
