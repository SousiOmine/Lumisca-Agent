Lumisca-Agentは、LLMでアプリケーション開発を高速化するためのコーディングエージェントです。
Webサーバー、デスクトップアプリとして動作し、deno + tauri + preactで構築されています。

LLMの接続にはVercel AI SDK(`ai` + `@ai-sdk/*`プロバイダー)を使用しています。プロバイダー/モデルのメタデータはmodels.dev(`@opencode-ai/models`)を正とし、アプリ側はVercel AI SDKのプロバイダーインスタンス生成と資格情報ストアからのキー注入を担当します。

## ビルドの注意点

`packages/desktop` はルート `deno.json` の `workspace` に含めないこと。デスクトップは `package.json` を持つため、workspace メンバーにすると Deno が `node_modules/@lumisca/desktop -> ../../packages/desktop` を作成し、`deno compile`(サーバーバイナリ)が node_modules 埋め込み時に symlink 先の `src-tauri/target`(数GB)ごと埋め込んで、起動不能な巨大バイナリを生成する。デスクトップのタスクはルートから `deno task dev:desktop` (scripts/dev.ts を直接実行) で呼び出す。
