Lumisca-Agent は、LLM を用いてアプリケーション開発を支援するコーディングエージェントです。Web サーバーおよびデスクトップアプリとして動作し、Deno、Tauri、Preact で構築されています。

LLM との接続には Vercel AI SDK（`ai` および `@ai-sdk/*`）を使用します。モデルのメタデータは models.dev（`@opencode-ai/models`）を基準とし、アプリケーション側でプロバイダーの生成と API キーの注入を行います。

## 作業前の確認

コードを編集する前に、ローカルリポジトリが最新の状態であるかを確認してください。リモートの更新を取り込み、古いコードに基づく編集や競合を防ぎます。

```bash
git fetch
git status
```

## 1. ビルドの注意点

- **`packages/desktop` のワークスペース除外**  
  `packages/desktop` はルートの `deno.json` の `workspace` に含めないでください。含めると Deno がシンボリックリンクを作成し、サーバーバイナリのコンパイル時に `src-tauri/target` を巻き込んで巨大なバイナリが生成されます。デスクトップの開発タスクはルートから `deno task dev:desktop` で実行します。
- **サーバーのビルド経路**  
  サーバーバイナリのビルドは `scripts/build-server.ts` に集約しています。デスクトップ同梱向けと単体配布向けの双方がこのスクリプトを経由します。動作確認は `deno task smoke:server` で行います。

### デスクトップのシェルブリッジ

ページはサーバーが配信するため Tauri のコマンドを呼べません。ウィンドウ操作・接続先の切り替え・更新は、シェルが立てる loopback の HTTP の口へ送ります（`packages/desktop/src-tauri/src/bridge_server.rs`、ページ側は `packages/web/src/shell.ts`）。origin はメインウィンドウの initialization script（`window.__LUMISCA_BRIDGE__`）でページへ渡します。

- **独自スキームにしない**: WKWebView（macOS）は http(s) のページから独自スキームを fetch させず、`lumisca://` だった頃は macOS でタイトルバーごと描画されませんでした。CSP の `connect-src` に `http://127.0.0.1:*` を足すのを忘れないでください（`packages/server/render.ts`）。
- **macOS のウィンドウ操作は OS のもの**: `tauri.macos.conf.json` で `decorations: true` + `titleBarStyle: "overlay"` にし、信号機ボタンはネイティブのものを使います。ページは帯を信号機の右から始め、閉じる／最小化／最大化のボタンを描きません。Windows / Linux はフレームレスのまま、ページが右端に描きます。どちらかは `state` の `platform` が答えます。

## 2. 自動アップデート

デスクトップ版とサーバー単体版で更新方式が異なります。

- **デスクトップ**: Tauri updater を使用し、アプリケーション全体を更新します。
- **サーバー単体**: `packages/server/update/` の実装により、バイナリと静的ファイルを更新します。

### 留意事項
- **署名鍵**: 双方で共通の鍵を使用します。変更時は `packages/server/update/verify.ts` と `tauri.conf.json` の両方を更新してください。
- **メタデータ管理**: 配布定義やバージョン比較は `packages/server/update/release.ts` に集約しています。
- **インストール先の名前**: 配布アーカイブの最上位ディレクトリは `lumisca-server-<platform>` で、バージョンを含みません。自己更新はバイナリと同じディレクトリのファイルを差し替えるため、名前に版があると実際の版と食い違います（`packages/core/repo_hygiene_test.ts` がこの規約を固定しています。実効バージョンは `--version`、適用記録、更新マニフェストが答えます）。
- **デスクトップの更新マニフェスト**: 公開する `latest.json` の URL は直リンク（`releases/download/<tag>/<name>`）へ書き換えます。tauri-action が書く `api.github.com` の URL は未認証リクエストのレート制限（60 回/時/IP）と User-Agent 必須の対象で、403 になるとアプリ内更新がダウンロードに失敗します。書き換えは `scripts/rewrite-updater-json.ts` と `.github/workflows/rewrite-updater-json.yml`（公開済みリリースの修復にも手動実行できます）。
- **動作条件**: サーバーの自己更新は、パッケージ済みバイナリかつ `LUMISCA_DESKTOP` 環境変数が未設定の場合にのみ動作します。
- **再起動制御**: 更新後の動作は環境変数 `LUMISCA_UPDATE_RESTART`（`self`, `supervisor`, `none`）で指定します。
- **事前検証**: 配布アーカイブの整合性は `scripts/check-server-archive.ts` で確認します。

## 3. Linux 常駐（systemd ユーザーユニット）

パッケージ済みサーバーは、systemd のユーザーユニットとして常駐できます（`packages/server/systemd/`）。任意のコマンドを実行する権限を持つため、root ではなく一般ユーザー権限で動作させます。

### 管理コマンド
- `./lumisca-server service config`: 設定内容を確認
- `./lumisca-server service install`: サービスの登録と起動
- `./lumisca-server service status`: 稼働状況と接続情報の確認
- `./lumisca-server service uninstall`: サービスの停止と登録解除

### 主な仕様
- **設定ファイル**: `<config home>/systemd/user/lumisca.service` および環境変数ファイル `service.env` を生成します。
- **外部公開**: 外部から接続する場合は `--host` を指定し、接続元ホストや IP アドレスを `--allowed-hosts` に追加してください。
- **自動起動**: OS 起動時にサービスを開始するには `loginctl enable-linger <user>` を有効にする必要があります。
- **ログ確認**: 稼働ログは `journalctl --user -u lumisca -f` で確認できます。

## 4. 障害調査

### デスクトップ環境
サーバーが停止した場合は、アプリケーションデータ領域の `server.log` を確認してください。
- **Windows**: `%APPDATA%\com.lumisca.agent\server.log`
- **macOS**: `~/Library/Application Support/com.lumisca.agent/server.log`
- **Linux**: `$XDG_DATA_HOME/com.lumisca.agent/server.log`

ログの末尾から、クラッシュ（エラー出力）、強制終了（`[shell] Stopping`）、ハング（ヘルスチェックの無応答）を判別できます。

### プロセス停止時の注意
作業中のエージェント自身を停止させないため、`deno` や `lumisca-server` をプロセス名で一括終了しないでください。停止時は個別のプロセス ID を指定します。

### systemd 環境
`journalctl --user -u lumisca -n 100` でログを確認してください。

## 5. 依存関係の更新

依存パッケージのバージョンは直接編集せず、以下のコマンドで更新します。

```bash
deno update -r --latest                                        # ルートおよび全ワークスペース
cargo update --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo update --manifest-path packages/browser-rpc/Cargo.toml
npm outdated                                                   # packages/desktop 内で実行
```

- **公開直後のバージョン**: Deno の仕様により、公開から 24 時間以内のバージョンは既定で導入されません。
- **デスクトップの扱い**: `packages/desktop` はワークスペース外のため、個別に更新を確認します。

## 6. UI の多言語対応

表示文言は `packages/core/shared/i18n/` のカタログに集約しています（日本語と英語を併記）。

- **コンポーネントでの取得**: `const t = useT();`（`packages/web/src/i18n.ts`）を用いて `t("キー名")` で呼び出します。
- **キーの命名**: `<area>.<surface>.<element>` 形式で統一します。
- **LLM プロンプト**: システムプロンプトやツール定義の英語文面は翻訳対象外です。回答言語はセッションごとの指示で制御します。
- **検証**: 文言の変更後は `deno test packages/core/shared/i18n_test.ts` を実行して整合性を確認してください。

### 設定のカテゴリ

カテゴリは 2 つの群に分かれます。

- **共通**: 一般 / 外観 / プロバイダー / モデル設定 / MCPサーバー / カスタマイズ / 接続先サーバー / セキュリティ
- **モードのみ**: code mode は「画面操作」「保存済みプロンプト」、stella mode は「ルーチン」

- **カテゴリは「共通」か、どちらか一方のモードに属します**（`packages/web/src/components/settings/categories.ts` の `scope`）。混在させません。以前の「セキュリティ」はコマンド安全チェック（全モード）と computer use（code mode のみ）を同じ画面に置いていたため、モードを切り替えると画面の半分が黙って効かなくなっていました。ナビは群ごとに見出しを付け、モード側の見出しは現在のモード名（`stella mode のみ`）になります。属するかどうかは、**サーバーがその値で何をするか**で決めます — `/prompt` は code mode のコンポーザ（スラッシュメニュー）にしか無く、computer use はこのマシンの画面を動かし（stella は VM 側の画面ツール `vm_screenshot` / `vm_act` を持つ）、ルーチンは stella の会話にしか無い、という具合です。`initialCategory` の型は共通カテゴリだけを受け取ります（呼び出し側はそのダイアログのモードを知らないため）。
- **カテゴリは 1 枚のページです**（`settings/SettingsPage.tsx`）。見出し（名前＋何を決めるかの 1 行）と本文を分け、本文だけがスクロールします。長い画面で見出しが流れると、いま何の画面か・どう抜けるかが分からなくなります。カテゴリの中から開く画面（プロバイダー詳細、MCP エディタ、フォーム）は自分専用の 1 段低いバー（`settings/SettingsSubHeader.tsx`）を持ちます。パネルごとに `modal-header` を描くと、ページ見出しの直下にもう 1 つ見出しが並びます。
- **狭い画面（900px 以下）では一覧とページを 1 枚ずつ**出します。横に並べるとページが細く、横スクロールのタブ列はラベルが切れて「そのカテゴリが何を決めるか」を書く余白もありません。`.settings-body[data-view]` で切り替えます。
- **プロバイダー**は AI プロバイダーと Web 検索プロバイダーを同じ画面に並べます（別カテゴリにすると検索側を見落とします）。2 つは同じ部品（`settings/SettingsSection.tsx` と `settings/ProviderRow.tsx`）で描きます。見出し＋追加、1 行の説明、行の一覧という同じ形にしないと、同じ画面の途中で読み方を変えることになります。ページ名がそのまま節の名前になる場合（MCPサーバー、保存済みプロンプト、ルーチン）は節の見出しを省きます（同じことを 2 回書かない）。
- **選択肢は自作の `components/Select.tsx`** を使います。ネイティブの `<select>` は OS の見た目で描かれ、説明行や現在値のチェックを持てません（言語選択・テーマ選択が該当）。
- **設定の行は面を塗りません**。`SettingRow` や `.setting-card` / `.provider-row` は下線で区切った行です。ダイアログ自体が浮いた面なので、行に面を足すとタイルの集合になり、塗りが本文のコントラストを落とします。
- **接続先**はデスクトップのタイトルバー上のドロップダウン（`components/ConnectionPicker.tsx`）だけから切り替えます。新規セッション画面にはサーバー選択を置きません（同じ問いに 2 箇所で答えると、片方が必ず間違った答えになります）。ワークスペース一覧は表示中のサーバー自身のものです。表示名はシェルが `settings.json` の `lastRemote` に名前ごと記録して `state` で返します（リモートのページのレジストリはそのサーバー自身のもので、自分自身の項目を持たないため）。純粋関数は `packages/web/src/connections.ts` にあります。
- **設定の接続先サーバー**の一覧は編集用です。行は畳んだ状態が既定で、押すと入力欄が開き、保存で閉じます。名前が空のまま URL を入力したらホスト名を補完します（手で入れた名前は上書きしません）。
- **自分自身とは連携しない**: サーバーは `connections` の各項目へ `/ws` を張ってイベントを中継しますが、その項目が自分自身なら中継しません。判定は URL ではなく `/api/health` の `instanceId`（プロセスごとの uuid）で行います。tailnet 名・LAN アドレス・リバースプロキシ経由の自分は URL の文字列では見分けられないためです。中継済みのフレーム（`peerId` が入っているもの）を再中継しないのも同じ理由で、自分自身への接続があるとエコーが止まらず、CPU を 1 コア占有したままメモリを使い切ります（`packages/server/federation.ts`）。

### リモート接続での応答（差分の結合・圧縮・プロキシ）

- **本文の差分はセッション単位でまとめる**: `/ws` と stella の会話ストリームは `message_delta` / `delta` を 16 ms 分まとめて 1 フレームにします（`packages/core/shared/ws-batch.ts`）。**キーはセッション id**です。1 本のソケットが複数タブのイベントを運ぶので、キーを分けないと別タブの語が混ざります。ツール開始・メッセージ確定・実行終了などのイベントは遅延させず、送る前に保留分を flush します（順序が崩れると本文が確定メッセージの後に届きます）。
- **rev はイベント数のまま**: フレームには含めた最後の `rev` と、含めたイベント数 `events` を載せます。クライアントの `revisionGap` は `events` を使います。ここを「1 フレーム = 1 イベント」に戻すと、結合のたびにスナップショットを取り直します。
- **クライアントも rAF でまとめる**: サーバーがまとめても描画前に複数フレームが届きます。`useSessionEvents` / `useStella` は保留中の delta をアニメーションフレーム単位で反映し、他のイベントの適用前に必ず flush します（`resync` も同様）。
- **応答は圧縮し、アセットは再検証させる**: `hono/compress`（閾値 1 KB）を全応答に掛けます。`/assets/app.js` と `/styles.css` は `ETag` + `private, max-age=0, must-revalidate`（304 で本文なし）、ページと `/assets/initial-data.js` はトークンを運ぶため `no-store` です。規則は `packages/server/app-file-headers.ts` に集約しています。
- **プロキシのタイムアウトは用途別**: `packages/server/federation.ts` の `proxyTimeoutFor` がパスから決めます（通常 30 秒、open／messages／compact／rewind は 120 秒、`/fed/peers` の到達性確認は 3 秒）。一律の短いタイムアウトは、遅いが正常なリモート処理を 502 にします。
- **プロキシはヘッダを選んで透過する**: `content-disposition`・`cache-control`・`etag`・`vary`・`content-security-policy`・`x-content-type-options` は通します。`content-encoding` は通しません（ハブの `fetch` が解凍済み）。
- **同一サーバーの判定はスキームを見ない**: CORS と WebSocket の Origin 検証は、Origin のホスト＋ポートが `Host` と一致するかで決めます（`packages/server/security.ts` の `sameServerAuthority`。MCP の `redirect_uri` も同じ関数）。TLS 終端（`tailscale serve` 等）は https を受けて http で転送するため、スキームまで比べるとページが自分自身のサーバーに対して cross-origin になります。そうなると `/ws` が 403 で拒否され、画面は 10 秒間隔のスナップショット取得だけが情報源になって「送信してから反映まで約 10 秒・本文が流れない」状態になります。別ポートと外部ホストは今も拒否します。

## 7. stella mode（仮想マシン）

stella mode は、podman コンテナを仮想マシンとして与え、その中だけでエージェントを動かす動作モードです。実装は `packages/core/vm/` にあり、会話は相手（agent）ごとに 1 本だけ存在します。

どちらのモードを表示するかは**クライアントごと**の選択です（`packages/web/src/hooks/useAppMode.ts`、`localStorage` の `lumisca.appMode`）。サーバーの設定テーブルには置きません — デスクトップとブラウザが同じサーバーを表示していても、片方の切り替えがもう片方を巻き込まないためです。サーバーが答えるのは能力とマシンの状態だけです（`GET /api/stella/status`）。

- **必要環境**: Linux と rootless podman。podman が使えない環境では stella mode を選べません（理由を画面に表示します）。Windows / macOS は対象外です。
- **実際に起動できるかまで確かめる**: `podman --version` が通ることは「コンテナを起動できる」ことを意味しません。サンドボックス化されたコンテナの中で Lumisca を動かしている場合など、podman は答えても `crun` がコンテナ作成に失敗します（`/proc/sys` が読み取り専用、`CAP_SYS_ADMIN` が無い）。そのため状態判定は素のイメージを 1 回起動して確かめ（`VM_PROBE_IMAGE`）、失敗すれば `podman_unusable` として理由付きで mode を提示しません。ここを甘く見ると「提示される → 数分ビルド → カーネルのパスを名指しした失敗」という、利用者に何も伝わらない待ちになります。
- **イメージ**: `packages/core/vm/container/Containerfile` から初回起動時にビルドします（数分）。配布物では `scripts/build-server.ts` が `stella-container/` をバイナリの隣へ同梱し、`packages/server/paths.ts` がその場所を解決します。ビルドしたイメージにはコンテナ定義一式のダイジェストをラベル（`lumisca.container-digest`）として記録し、起動時にディスク上のファイルと突き合わせます。ずれていれば（Containerfile を編集した、更新で新しい Containerfile が入った）イメージを**自動で作り直し**、コンテナを置き換えます。そのときエージェントのホーム `/home/agent` は `podman cp` で一時ディレクトリへ退避して戻すので、作業中のファイルは失われません（ホストへはマウントしません。VM の隔離が目的のため）。UI に「作り直す」ボタンはありません。
- **契約値**: 画面サイズ（1280x800）、DISPLAY、uid/gid、作業ディレクトリ、`agent` アカウントのパスワード無し `sudo` は `packages/core/vm/contract.ts` と Containerfile / entry.sh の両方に書かれています。起動時に実コンテナと突き合わせ（`sudo -n true` の実行を含む）、ずれていれば起動を失敗させます。
- **root 権限**: マシン内の `agent` アカウントは `sudo` をパスワード無しで使えます（`/etc/sudoers.d/agent`）。パッケージ導入・サービス有効化・`/etc` 配下の編集はマシン内の普通の作業だからです。root になってもコンテナの外には出られません — ホストのファイルはマウントしておらず、コンテナの capability はコンテナのままで（rootless podman の `mount` は失敗します）、コンテナ内の uid 0 は `--userns keep-id` により非特権のホストユーザーへ写像されます。既定のユーザーを root にしないのは Chromium がサンドボックスを使えなくなるためで、root は必要になったときだけ `sudo` で取ります。
- **隔離の範囲**: ホストのファイルは VM にマウントしません。VM はセキュリティ境界ではなく作業場所の区切りであり、CPU・メモリ・ディスクの上限や外向きネットワークの制限は設けていません。同じ理由で、マシン内の `sudo` は開いています（上記の root 権限）。
- **ライフサイクル**: 起動は自動（会話を開く前）。停止はサーバー終了時と画面の「停止」。モードの切り替えだけでは停止しません。
- **エージェントは常に 1 人以上**: `GET /api/stella/agents` の初回読み出しでスターターを作ります（`LumiscaCore.ensureStellaAgent`、名前と役割はメッセージカタログ）。空のサイドバーだけの stella mode を作らないためで、条件は一覧が空かどうかだけです。全員を削除しても次の読み出しで戻ります。
- **画面パネル**: 会話の右列にマシンの画面を出します。ヘッダー右上のトグルで表示・非表示を切り替え、既定は閉じています（会話の幅を最初から奪わず、ペインを開くまで VNC の接続も張りません）。開いた・閉じた状態はそのまま保ちます（送信で勝手に開き直しません）。`vm_ask_user` の受け渡し中だけは、実行がそこで止まっているため必ず開きます。トグルのアイコンはモニタで、閉じているときは斜線入りのモニタです（状態はアイコン、次の操作はツールチップが示します）。
- **computer use は code mode だけ**: `agent/factory.ts` が stella セッションへは渡しません（VM には `vm_screenshot` / `vm_act` がある）。設定画面でも「画面操作」は code mode 専用のカテゴリです（`settings/categories.ts` の `scope: "code"`）。
- **eval ツールは渡しません。** サーバープロセス内で JavaScript を実行するため、VM の外に出る経路になります。VM 内でコードを動かすときは `bash` から `node` を使ってください。同じ理由で、このモードのサブエージェントにも `eval` は渡しません（`SubagentRuntime.eval` が `false`）。
- **ツールの集合**: ファイル・シェル・画面・`chat_ui`・`chat_attach`・`history_search`・`skill`・サブエージェントがプリロードされます。`ask` と `todo` はありません（質問に答えるパネルも進捗パネルも、この会話には無いため）。`identity` と `agent_create` は**プリロードせず**、セッションの main レジストリに置いて `tool_search` で見つけさせます（使い方は組み込みスキル `identity` / `agent-create` が教えます）。
- **ツールレジストリの分離**: セッションは `main` と `subagent` の 2 つのレジストリを持ちます（`packages/core/tools/registries.ts`）。MCP・browser-lab・computer・`pdf_read_pages` は両方に入り、`identity` / `agent_create` / `routine_*` は main だけに入ります。stella のサブエージェントは VM の中で code mode と同じツール集合で動きますが、この 3 種は `tool_search` でも見つかりません。
- **作業フォルダとパスの境界**: 相対パスと `bash` は `/home/agent/agents/<agent id>` を基点にしますが、境界はマシンのホーム `/home/agent` です。ほかの相手のフォルダにも絶対パスで触れます（`packages/core/vm/fs.ts` の `resolveVmPath`）。境界を変えるときはシステムプロンプト（`packages/core/tools/system-prompt.ts`）の記述も合わせてください。
- **画面の受け渡し**: 人が必要な手順は `vm_ask_user` で待ちます（`packages/core/vm/handover.ts`）。待機中は画面ペインが操作可能になり、エージェントは止まっています。待ちを解く経路（完了・停止・セッション終了）を増やすときは `cancelAll` とイベントの後始末も合わせて確認してください。
- **ルーチン**: スケジュールは `daily` / `weekly` / `every` の 3 種類だけで、cron は扱いません。次回時刻は「保存済みの値」ではなく `packages/core/shared/routine.ts` の `nextRunAt` で計算し、実行前に進めます（後回しにすると、長い実行が重複して走ります）。
- **放置された会話の圧縮**: stella の会話は何週間も生き、何時間・何日かぶりに開かれます。しきい値に届かなくても、最後のメッセージから 3 時間たったら履歴を畳みます（`SessionAgentOptions.idleCompactionMs`。値を渡すのは stella セッションだけで、既定は 0 = しきい値のみ。定数は `packages/core/agent/factory.ts` の `STELLA_IDLE_COMPACTION_MS`）。予約は会話を開いたときと run が終わったときに引き直し、run が始まったら外します（使用中の会話を背後で畳まない）。要約の間に会話が動いたら挿入せずに捨てます（`ContextCompactor.compactNow` の `canCommit`）。
- **identity（相手の自己記述）**: 相手は `role`（ユーザーが作成時に書く）とは別に、`identity` ツールで自分の役割と知識を書けます。保存先は `stella_agents.identity`、モデルへは context メッセージとして届きます（`packages/core/stella/identity.ts`）。**システムプロンプトには書きません** — 書き換えのたびに先頭が変わるとキャッシュ済みプレフィックスを捨てるためです。反映は次のターンからで、圧縮は待ちません。ツールはプリロードせず main レジストリ経由です。
- **ユーザーへのファイル送信**: 画像やファイルは `chat_attach` で送ります（`packages/core/tools/attach.ts`）。画像はインライン、それ以外はダウンロードとして会話にカードで出ます。code mode と stella の両方で使えます。保存先はデータベース隣の `.lumisca-attachments`（`packages/core/session/attachments.ts`）、配信は `/api/sessions/:id/attachment/:name` です。1 件 4 MiB・1 回 10 件・合計 16 MiB まで。`visual` ツール（`visual:` 参照で本文中に画像を置く）は **code mode のみ**に残しています（stella では外し、保存済みの応答を表示し続けるためにストアとルートだけ残しています）。
- **相手のアイコン**: 相手の絵は `stella_agents.icon`（ストアが生成したファイル名、空なら未設定）で、保存先は DB 隣の `.lumisca-agent-icons/<agent id>/`（`packages/core/stella/icons.ts`）、配信は `GET /api/stella/agents/:id/icon/:name` です。未設定なら名前の頭文字（白）を、`agent id` から決定的に導いた色相の上に描きます（`packages/core/shared/agent-avatar.ts`）。設定するのはユーザーだけで（会話ヘッダーのアイコン → ダイアログ）、**モデルには渡しません**。形式は PNG / JPEG / GIF / WebP / BMP（SVG 不可）で 512 KiB まで、バイト列の先頭で実際の形式を検査します。差し替えは「新ファイル → 行 → 旧ファイル削除」の順です。
- **スキル一覧の出どころ**: `<available_skills>` を公開する provider（`packages/core/skills/catalog.ts`）は、セッションごとの解決関数を受け取ります。stella ではマシン内の `.agents/skills` とホストのグローバル／組み込みを返すので、一覧と `skill` ツールが読める集合が一致します。組み込みスキルは `BuiltinContext.stella` で `identity` / `agent-create` を加えます（`packages/core/skills/builtin/mod.ts`）。

## 8. 開発用スクリプト

手元での確認に使うスクリプトは `deno task` から実行します。

- `deno task demo`: faux プロバイダで動くデモサーバーを起動します（API キーやネットワークなしで UI とツール呼び出しを確認できます）。
- `deno task seed:history <sessionId> [nPairs]`: 指定セッションに長い履歴を流し込みます（多数メッセージでのレイアウト確認用）。
- `deno task probe:token`: 認証トークンのガード（`/api/health` がトークン無しで 401、付与で 200）を確認します。
- `deno task probe:computer`: このマシンで computer use が使えるかを確認し、スクリーンショットを 1 枚保存します（Linux では初回にデスクトップが許可ダイアログを出します）。`--click x,y` などを付けると 1 回だけ操作も行います。
- `deno task probe:stella`: stella mode がこのマシンで使えるかを確認します。`--start` を付けるとイメージのビルド・起動・画面撮影・停止まで通します（初回は数分かかります）。

いずれも手動操作用で、CI からは実行しません。引数の詳細は各スクリプトの先頭コメントにあります。
