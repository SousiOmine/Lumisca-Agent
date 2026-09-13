Lumisca-Agentは、LLMを用いてアプリケーション開発を高速化するためのコーディングエージェントです。Webサーバーおよびデスクトップアプリとして動作し、Deno、Tauri、Preactで構築されています。

LLMとの接続にはVercel AI SDK（`ai` および `@ai-sdk/*` プロバイダー）を使用します。プロバイダーおよびモデルのメタデータはmodels.dev（`@opencode-ai/models`）を正とし、アプリ側はVercel AI SDKのプロバイダーインスタンス生成と、資格情報ストアからのキー注入を担当します。

## 1. ビルドの注意点

* **`packages/desktop` のワークスペース除外**  
  `packages/desktop` はルートの `deno.json` の `workspace` に含めないでください。デスクトップ側が `package.json` を保持しているため、ワークスペースに含めるとDenoが `node_modules/@lumisca/desktop -> ../../packages/desktop` のシンボリックリンクを作成します。その結果、サーバーバイナリの `deno compile` 時にシンボリックリンク先の `src-tauri/target`（数GB）ごと埋め込まれ、起動不能な巨大バイナリが生成されてしまいます。  
  ※デスクトップのタスクは、ルートから `deno task dev:desktop`（`scripts/dev.ts` を直接実行）で呼び出します。

* **サーバービルド経路の一元化**  
  パッケージ済みサーバーのビルド経路は `scripts/build-server.ts` の1本のみです。デスクトップ同梱向け（`--out packages/desktop/src-tauri/resources/server`）も、サーバー単体配布向け（既定の `dist/server/stage/<target>`）も、同じスクリプトから `deno compile` を実行します。パーミッションフラグ、資産レイアウト、`icudtl.dat` の配置はここにしか実装されていないため、変更時は両配布物に影響することを意識してください。  
  ※配布物の検証は、`deno task build:server` の実行後に `deno task smoke:server`（パッケージ済みバイナリを起動してUI資産を取得する）で行います。

## 2. 自動アップデート

デスクトップ版とサーバー単体版の2つの配布物が、それぞれ固有の更新機構を持ちます。

* **デスクトップ**: Tauri updater（`latest.json` + `.sig` を用い、アプリバンドルごと差し替え）
* **サーバー単体**: `packages/server/update/` の自前実装（`latest-server-<target>.json` + `.sig` を用い、バイナリと資産をその場で差し替え）

### 共通事項・留意点
* **署名鍵の共通化**: どちらも `tauri signer sign`（minisign形式、BLAKE2b-512 + Ed25519）を使用します。鍵を変更する際は、`packages/server/update/verify.ts` の `RELEASE_PUBLIC_KEY` と `tauri.conf.json` の `plugins.updater.pubkey` の双方を変更してください（両者が一致することは `verify_test.ts` で検証されます）。
* **メタデータの一元管理**: 配布レイアウト、URL、バージョン比較の単一情報源は `packages/server/update/release.ts` です。CI側（`scripts/build-server-manifest.ts`）もこれを参照するため、片方にしか存在しないURLや名前は作成できません。
* **自己更新の有効条件**: サーバーの自己更新は、「パッケージ済み（`Deno.build.standalone`）」かつ「デスクトップ管理下でない（`LUMISCA_DESKTOP` 未設定）」場合のみ有効です。デスクトップが起動するサーバーはアプリバンドル内のバイナリであるため、シェル側の更新に任せます。
* **更新の適用と再起動**: 適用処理は実行中のプロセスに影響を与えません（ファイルを差し替えるのみで、新バージョンは次回起動時から反映されます）。再起動の動作は環境変数 `LUMISCA_UPDATE_RESTART` で制御します。
  * `self`（既定）: 自ら後継プロセスを spawn します。
  * `supervisor`: 自身は `exit(0)` し、systemd などの監視側に新バイナリを起動させます（ユニット側にはこれを設定します）。
  * `none`: 再起動しません。
* **リリース前検証**: リリース時は `scripts/check-server-archive.ts` が、実物のアーカイブを更新機構自身の検証器・展開器で検査します（署名、コンテナ、stageディレクトリとの一致）。この検証が失敗するリリースは、ユーザー環境での更新破損につながります。
* **手元での確認**: ローカルでの通し確認は、`.lumisca-update/` を削除した上で、開発実行（`LUMISCA_UPDATE_MANIFEST=<URL> deno task server` は無効）ではなくパッケージ済みバイナリに対して実施します。

## 3. Linux 常駐（systemd ユーザーユニット）

パッケージ済みサーバーは、systemd の**ユーザーユニット**として常駐可能です（`packages/server/systemd/`）。エージェントは任意の bash を実行するため、root ではなく所有者権限で動作させます。

### 操作コマンド
* `./lumisca-server service config`: 書き込む内容を確認（システムは変更しません）
* `./lumisca-server service install`: 導入 → 有効化 → 起動 → linger の確認
* `./lumisca-server service status`: 稼働状況、自動起動、ドリフト、接続先を確認
* `./lumisca-server service uninstall`: 停止してユニットを削除（設定とDBは保持します）

### 仕様詳細
* **生成物**:
  * `<config home>/systemd/user/lumisca.service`（systemd が読み込む場所）
  * `<config home>/lumisca-agent/service.env`（パーミッション 0600。`EnvironmentFile=` が指す設定層）  
  ※`config home` は `XDG_CONFIG_HOME` または `~/.config` です。
* **ホスト指定**: 既定は loopback（`127.0.0.1:8000`）です。外部から利用する場合は `--host` を明示し、クライアントが使う名前やIPを `--allowed-hosts` で必ず渡してください（Host ガードにより、伝えられていないホスト名は 403 になります）。  
  例: `--host 100.64.0.5 --allowed-hosts 100.64.0.5,homeserver`
* **トークン**: 初回に生成され、以降の `install` では `service.env` の値を引き継ぎます（手動で編集した値も保持されます。値を消したい場合は行を削除します）。`service config` では伏せ字で表示されます。
* **OS起動時の自動起動**: `loginctl enable-linger <user>` が必要です。`install` 時に試行し、失敗した場合は実行すべきコマンドを表示して非0で終了します（linger が無効だとログイン時起動となり、要件を満たしません）。
* **`install` の前提条件**: 以下の条件をすべて前処理で確認し、失敗時は何も書き込みません。
  1. Linux であること
  2. パッケージ済みバイナリであること
  3. `LUMISCA_DESKTOP` が未設定であること
  4. インストール先が書き込み可能であること
  5. ポートが空いていること（ユニットが active の場合は自身のポートであるため検査しません）
* **更新との連携**: ユニットには `LUMISCA_UPDATE_RESTART=supervisor` を設定します。更新適用時にサーバーは shutdown → `exit(0)` し、ユニットの `Restart=always` が新バイナリを起動します（同一 cgroup で監視側と競合するため、サーバー自身は後継プロセスを spawn しません）。
* **ログと状態確認**: ログは `journalctl --user -u lumisca -f` で確認できます。`service status` は、ユニットが現在のバイナリのテンプレートと一致しない（更新後に再インストールが必要な）状態も報告します。
* ※非 Linux 環境では、`install` / `status` / `uninstall` は exit 2 で拒否されます（`config` はパッケージ済みであれば動作します）。

## 4. 障害調査

### デスクトップ環境の調査
サーバーが意図せず停止した場合は、まず Tauri の `app_data_dir` 配下にある `server.log` を確認してください。

* **配置場所**:
  * **Windows**: `%APPDATA%\com.lumisca.agent\server.log`
  * **macOS**: `~/Library/Application Support/com.lumisca.agent/server.log`
  * **Linux**: `$XDG_DATA_HOME/com.lumisca.agent/server.log` または `~/.local/share/com.lumisca.agent/server.log`

デスクトップシェルがローカルサーバーを子プロセスとして起動し、その stdout/stderr を行頭のローカル時刻付きで全行記録しています（`packages/desktop/src-tauri/src/server_log.rs`）。シェル自身の操作（起動、再起動、停止、健全性判定）も `[shell]` 行として同じファイルに残るため、以下の3つを区別できます。

* **クラッシュ**: スタックトレースや `unhandled promise rejection` が stderr に出力された後、出力が途切れる
* **強制終了**: `[shell] Stopping ...: <理由>` または `Killing ... for the restart` の直後で途切れる（理由にはアプリ終了、更新インストーラ起動などが入ります）
* **ハング**: `[shell] ... alive but did not answer /api/health ... left running` が出力される。シェルは生きているサーバーを kill しません（`ensure_local_server`）。強制再起動はページのバナー、または `server/restart` 経由で行います。

### プロセス停止時の注意
**エージェント自身が動いているプロセスは kill しないでください**。`deno` や `lumisca-server` を名前で一括停止すると、検証用に起動したサーバーと一緒に自分自身も停止してしまいます。停止は `async_bash_kill` か個別 pid の指定で行ってください。

### systemd 常駐環境の調査
systemd ユーザーユニットで動いているサーバーは journald を確認します。

```bash
journalctl --user -u lumisca -n 100
```

`SIGTERM` の受信、drain のタイムアウト（5秒）、`Restart=always` による再起動をここで区別できます。ユニットの状態と生成物の一致は `./lumisca-server service status` で確認可能です。

## 5. 依存関係の更新

依存のバージョンは各マニフェストに固定されており、解決経路ごとに更新コマンドが異なります。手で書き換えず、次のコマンドで更新してください。

```bash
deno update -r --latest                                        # ルートと全ワークスペースの deno.json / deno.lock
cargo update --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo update --manifest-path packages/browser-rpc/Cargo.toml
npm outdated                                                   # packages/desktop で実行（@tauri-apps/cli）
```

* **24時間ゲート**: Deno 2.9 以降、公開から24時間以内のバージョンは既定で採用されません。`deno outdated --latest` が最新版を表示しても `deno update --latest` が据え置くことがあります（`--minimum-dependency-age 0` で無効化できますが、リリース直前の更新では既定のままにします）。
* **`packages/desktop` はワークスペース外**のため（本ファイル 1 節）、`deno update -r` の対象に含まれません。`@tauri-apps/cli` の実体は `package-lock.json` です。
* **`uses:` も依存です**: ワークフローで使うアクションは、メジャー更新時にランナーの要件（例: `actions/cache@v5` 以降は Node 24 と runner 2.327.1 以上）が変わります。更新時はリリースノートを確認してください。