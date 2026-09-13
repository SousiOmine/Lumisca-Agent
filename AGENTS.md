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
- 適用は実行中プロセスに影響しない(ファイルを差し替えるだけで、新しいバージョンは次回起動から)。再起動の方法は `LUMISCA_UPDATE_RESTART` が決める: `self`(既定。後継プロセスを spawn)、`supervisor`(自分は `exit(0)` し、systemd などの監視側に新バイナリを起動させる。ユニットはこれを設定する)、`none`(再起動しない)。
- リリース時は `scripts/check-server-archive.ts` が**実物のアーカイブ**を更新機構自身の検証器・展開器で検査する(署名・コンテナ・stageディレクトリとの一致)。ここが落ちるリリースは、ユーザー環境で更新が壊れる。
- 手元での通し確認は `.lumisca-update/` を消してから `LUMISCA_UPDATE_MANIFEST=<URL> deno task server`(開発実行では無効)ではなく、パッケージ済みバイナリに対して行う。

## Linux 常駐（systemd ユーザーユニット）

パッケージ済みサーバーは、自分自身を systemd の**ユーザーユニット**として常駐させられる（`packages/server/systemd/`）。root では動かさない（エージェントは任意の bash を実行するため、所有者権限で動かすのが前提）。

```bash
./lumisca-server service config            # 書き込む内容を確認（何も変更しない）
./lumisca-server service install           # 導入 → 有効化 → 起動 → linger 確認
./lumisca-server service status            # 稼働・自動起動・ドリフト・接続先
./lumisca-server service uninstall         # 停止してユニットを削除（設定とDBは残す）
```

- **生成物**: `<config home>/systemd/user/lumisca.service`（systemd が読む場所）と `<config home>/lumisca-agent/service.env`（0600。`EnvironmentFile=` が指す設定層）。`config home` は `XDG_CONFIG_HOME` か `~/.config`。
- **既定は loopback**（`127.0.0.1:8000`）。外から使うときは `--host` を明示し、クライアントが使う名前/IP を `--allowed-hosts` で必ず渡す（Host ガードは伝えられていないホスト名を 403 にする）。例: `--host 100.64.0.5 --allowed-hosts 100.64.0.5,homeserver`
- **トークン**は初回に生成し、以後の install では `service.env` の値を引き継ぐ（引き継ぎ元はこのファイルなので、手で編集した値も次の install で保持される。値を消したいときは行を消す）。`service config` は伏せ字で表示する。
- **起動時の自動起動**には `loginctl enable-linger <user>` が必要。install が試行し、失敗したら実行すべきコマンドを出して非0で終わる（linger が無効だと「ログイン時起動」になり、要件を満たさない）。
- **install の前提**: Linux / パッケージ済みバイナリ / `LUMISCA_DESKTOP` 未設定 / インストール先が書き込み可能 / ポートが空き（ユニットが active のときは自分のポートなので検査しない）。すべて前処理で確認し、失敗時は何も書かない。
- **更新との連携**: ユニットは `LUMISCA_UPDATE_RESTART=supervisor` を設定する。更新を適用するとサーバーは shutdown → `exit(0)` し、unit の `Restart=always` が新バイナリを起動する（サーバー自身は後継プロセスを spawn しない。同一 cgroup で監視側と競合するため）。
- **ログと調査**: `journalctl --user -u lumisca -f`。`service status` は「ユニットが現在のバイナリのテンプレートと一致しない（＝更新後に再インストールが必要）」ことも報告する。
- 非 Linux では `install` / `status` / `uninstall` は exit 2 で拒否する（`config` はパッケージ済みであればどこでも動く）。

## 障害調査

「サーバーが勝手に落ちた」系の調査は、まずTauriの app_data_dir 配下の `server.log` を見る(OSごとに場所が違う。Windows: `%APPDATA%\com.lumisca.agent\server.log`、macOS: `~/Library/Application Support/com.lumisca.agent/server.log`、Linux: `$XDG_DATA_HOME` または `~/.local/share/com.lumisca.agent/server.log`)。デスクトップシェルがローカルサーバーを子プロセスとして起動し、その stdout/stderr を行頭のローカル時刻付きで全行捕捉している(`packages/desktop/src-tauri/src/server_log.rs`)。シェル自身の操作(起動・再起動・停止・健全性判定)も `[shell]` 行として同じファイルに残るので、次の3つを区別できる。

- クラッシュ: スタックトレースや `unhandled promise rejection` が stderr に出た後、出力が途切れる
- 強制終了: `[shell] Stopping ...: <理由>` / `Killing ... for the restart` の直後で途切れる(理由にアプリ終了・更新インストーラ起動などが入る)
- ハング: `[shell] ... alive but did not answer /api/health ... left running` が出る。シェルは生きているサーバーを kill しない(`ensure_local_server`)。強制再起動はページのバナー、または `server/restart` 経由

**エージェント自身が動いているプロセスは kill しない**(`deno` / `lumisca-server` を名前で一括停止すると、検証用に起動したサーバーと一緒に自分自身も止まる。停止は `async_bash_kill` か個別 pid の指定で行う)。

systemd 常駐で動いているサーバー（上記「Linux 常駐」）は journald に出る: `journalctl --user -u lumisca -n 100`。`SIGTERM` の受信、drain のタイムアウト（5秒）、`Restart=always` による再起動はここで区別できる。ユニットの状態と生成物の一致は `./lumisca-server service status` が報告する。
