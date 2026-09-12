Lumisca-Agentは、LLMでアプリケーション開発を高速化するためのコーディングエージェントです。
Webサーバー、デスクトップアプリとして動作し、deno + tauri + preactで構築されています。

LLMの接続にはVercel AI SDK(`ai` + `@ai-sdk/*`プロバイダー)を使用しています。プロバイダー/モデルのメタデータはmodels.dev(`@opencode-ai/models`)を正とし、アプリ側はVercel AI SDKのプロバイダーインスタンス生成と資格情報ストアからのキー注入を担当します。

## ビルドの注意点

`packages/desktop` はルート `deno.json` の `workspace` に含めないこと。デスクトップは `package.json` を持つため、workspace メンバーにすると Deno が `node_modules/@lumisca/desktop -> ../../packages/desktop` を作成し、`deno compile`(サーバーバイナリ)が node_modules 埋め込み時に symlink 先の `src-tauri/target`(数GB)ごと埋め込んで、起動不能な巨大バイナリを生成する。デスクトップのタスクはルートから `deno task dev:desktop` (scripts/dev.ts を直接実行) で呼び出す。

パッケージ済みサーバーのビルド経路は `scripts/build-server.ts` の1本だけ。デスクトップは `--out packages/desktop/src-tauri/resources/server`(Tauriリソースとして同梱)、サーバー単体配布は既定の `dist/server/stage/<target>` へ、同じスクリプトで `deno compile` する。パーミッションフラグ・資産レイアウト・`icudtl.dat` の配置はここが唯一の実装なので、増やす場合は両配布物に効くことを意識する。配布物の検証は `deno task build:server` → `deno task smoke:server`(パッケージ済みバイナリを起動してUI資産を取得する)。

## 自動アップデート

2つの配布物がそれぞれ自分の更新機構を持つ。デスクトップはTauri updater(`latest.json` + `.sig`、アプリバンドルごと差し替え)、サーバー単体は `packages/server/update/` の自前実装(`latest-server-<target>.json` + `.sig`、バイナリと資産をその場で差し替え)。**署名鍵は共通**で、どちらも `tauri signer sign`(minisign形式、BLAKE2b-512 + Ed25519)を使う。鍵を替えるときは `packages/server/update/verify.ts` の `RELEASE_PUBLIC_KEY` と `tauri.conf.json` の `plugins.updater.pubkey` の両方(両者が一致することを `verify_test.ts` が検査する)。

- 配布レイアウト・URL・バージョン比較の単一情報源は `packages/server/update/release.ts`。CI側(`scripts/build-server-manifest.ts`)もここを読むので、片側にしか無いURLや名前は作れない。
- サーバーの自己更新は「パッケージ済み(`Deno.build.standalone`)」かつ「デスクトップ管理下でない(`LUMISCA_DESKTOP` 未設定)」ときだけ有効。デスクトップが起動するサーバーはアプリバンドル内のバイナリなので、シェル側の更新に任せる。
- 適用は実行中プロセスに影響しない(ファイルを差し替えるだけで、新しいバージョンは次回起動から)。再起動だけがユーザー操作で、`LUMISCA_UPDATE_RESTART=none` なら監視側に任せる。
- リリース時は `scripts/check-server-archive.ts` が**実物のアーカイブ**を更新機構自身の検証器・展開器で検査する(署名・コンテナ・stageディレクトリとの一致)。ここが落ちるリリースは、ユーザー環境で更新が壊れる。
- 手元での通し確認は `.lumisca-update/` を消してから `LUMISCA_UPDATE_MANIFEST=<URL> deno task server`(開発実行では無効)ではなく、パッケージ済みバイナリに対して行う。

## 障害調査

「サーバーが勝手に落ちた」系の調査は、まずTauriの app_data_dir 配下の `server.log` を見る(OSごとに場所が違う。Windows: `%APPDATA%\com.lumisca.agent\server.log`、macOS: `~/Library/Application Support/com.lumisca.agent/server.log`、Linux: `$XDG_DATA_HOME` または `~/.local/share/com.lumisca.agent/server.log`)。デスクトップシェルがローカルサーバーを子プロセスとして起動し、その stdout/stderr を行頭のローカル時刻付きで全行捕捉している(`packages/desktop/src-tauri/src/server_log.rs`)。シェル自身の操作(起動・再起動・停止・健全性判定)も `[shell]` 行として同じファイルに残るので、次の3つを区別できる。

- クラッシュ: スタックトレースや `unhandled promise rejection` が stderr に出た後、出力が途切れる
- 強制終了: `[shell] Stopping ...: <理由>` / `Killing ... for the restart` の直後で途切れる(理由にアプリ終了・更新インストーラ起動などが入る)
- ハング: `[shell] ... alive but did not answer /api/health ... left running` が出る。シェルは生きているサーバーを kill しない(`ensure_local_server`)。強制再起動はページのバナー、または `server/restart` 経由

**エージェント自身が動いているプロセスは kill しない**(`deno` / `lumisca-server` を名前で一括停止すると、検証用に起動したサーバーと一緒に自分自身も止まる。停止は `async_bash_kill` か個別 pid の指定で行う)。
