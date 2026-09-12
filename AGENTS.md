Lumisca-Agentは、LLMでアプリケーション開発を高速化するためのコーディングエージェントです。
Webサーバー、デスクトップアプリとして動作し、deno + tauri + preactで構築されています。

LLMの接続にはVercel AI SDK(`ai` + `@ai-sdk/*`プロバイダー)を使用しています。プロバイダー/モデルのメタデータはmodels.dev(`@opencode-ai/models`)を正とし、アプリ側はVercel AI SDKのプロバイダーインスタンス生成と資格情報ストアからのキー注入を担当します。

## ビルドの注意点

`packages/desktop` はルート `deno.json` の `workspace` に含めないこと。デスクトップは `package.json` を持つため、workspace メンバーにすると Deno が `node_modules/@lumisca/desktop -> ../../packages/desktop` を作成し、`deno compile`(サーバーバイナリ)が node_modules 埋め込み時に symlink 先の `src-tauri/target`(数GB)ごと埋め込んで、起動不能な巨大バイナリを生成する。デスクトップのタスクはルートから `deno task dev:desktop` (scripts/dev.ts を直接実行) で呼び出す。

## 障害調査

「サーバーが勝手に落ちた」系の調査は、まずTauriの app_data_dir 配下の `server.log` を見る(OSごとに場所が違う。Windows: `%APPDATA%\com.lumisca.agent\server.log`、macOS: `~/Library/Application Support/com.lumisca.agent/server.log`、Linux: `$XDG_DATA_HOME` または `~/.local/share/com.lumisca.agent/server.log`)。デスクトップシェルがローカルサーバーを子プロセスとして起動し、その stdout/stderr を行頭のローカル時刻付きで全行捕捉している(`packages/desktop/src-tauri/src/server_log.rs`)。シェル自身の操作(起動・再起動・停止・健全性判定)も `[shell]` 行として同じファイルに残るので、次の3つを区別できる。

- クラッシュ: スタックトレースや `unhandled promise rejection` が stderr に出た後、出力が途切れる
- 強制終了: `[shell] Stopping ...: <理由>` / `Killing ... for the restart` の直後で途切れる(理由にアプリ終了・更新インストーラ起動などが入る)
- ハング: `[shell] ... alive but did not answer /api/health ... left running` が出る。シェルは生きているサーバーを kill しない(`ensure_local_server`)。強制再起動はページのバナー、または `server/restart` 経由
