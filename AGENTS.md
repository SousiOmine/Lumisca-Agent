Lumisca-Agent は、LLM を用いてアプリケーション開発を支援するコーディングエージェントです。Web サーバーおよびデスクトップアプリとして動作し、Deno、Tauri、Preact で構築されています。

LLM との接続には Vercel AI SDK（`ai` および `@ai-sdk/*`）を使用します。モデルのメタデータは models.dev（`@opencode-ai/models`）を基準とし、アプリケーション側でプロバイダーの生成と API キーの注入を行います。

**この文書は作業者向けの手引きです。** 何をどう触るか、どこで間違えやすいかだけを書きます。なぜその設計なのかは `ARCHITECTURE.md` にあり、ここには書きません。

## 作業前の確認

編集の前に `git fetch` と `git status` で、手元が最新かを確かめます。push の前にも `git fetch` して `git log --oneline HEAD..origin/master` を見てください。

上流は同じ日に何度も進みます。古い HEAD のまま編集すると、直っている問題を作り直したり、push が拒否されたりします。取り込むときは rebase し、取り込んだ後に検証をやり直してください。

## 0. コードコメント

コメントは、コードを読んでも分からないことだけを書きます。読めば分かることを書いたコメントは、コードを直しても直されないまま残り、やがて嘘になります。足す前に、名前を直せないかを考えてください。要らないコメントは、別の文に書き直すのではなく消します。

| 書く | 書かない |
| --- | --- |
| なぜそうしたか、なぜ他の書き方を選ばなかったか | コードを日本語に翻訳しただけのもの |
| コードから読めない制約・業務ルール・数値の根拠 | 変数名やメソッド名で表現できるもの |
| 一見不要に見える処理がなぜ必要か | 修正履歴（`git log` で分かる） |
| 直感に反する挙動、ハマりどころ | 自動生成されたままのコメント |
| 期限と課題管理先が決まっている TODO | 放置された TODO、削除予定のないコメントアウト |

たとえば `SessionAgentOptions.keepTokens` の「`minTokens` より小さくないと、この検査は何も解放できない」は書きます。関係が破れたときに何が起きるかは、コードから読めないためです。逆に `/** The RPC path. */`（`RPC_PATH`）や `// Filter by search query`（`filtered`）は書きません。

- **言語は英語**: `.ts` / `.tsx` / `.rs` / `.css` のコメントは英語で書きます。日本語を書いてよいのは、画面やログの文言を引用するとき（`"作業完了"`）だけです。
- **過去の話は理由のときだけ**: 「以前はこうだった」は、いまのコードがその形である理由を説明するときだけ書きます。いつ何を直したかは `git log` に任せてください。テストの「この回帰を固定する」は書きます。
- **doc コメントには契約を書く**: `/** Options of a Sandbox. */` のような名前の言い換えは書きません。単位、範囲、省略時の意味、呼び出し側が守る前提を書きます。
- **足場は片付ける**: `// TODO: implement` のような書きかけの目印は、実装が終わったら消します。
- **TODO は追跡先とセット**: `// TODO(issue #123): …` の形だけを残します。
- **コメントアウトしたコードは残さない**: 戻すときは revert します。
- **数値には根拠を書く**: タイムアウト、上限、しきい値は、その値でなければならない理由を書きます。

## 1. ビルドの注意点

- **`packages/desktop` はワークスペースに含めない**: ルートの `deno.json` の `workspace` に入れると、Deno がシンボリックリンクを作り、サーバーバイナリのコンパイルに `src-tauri/target` を巻き込んで巨大になります。デスクトップはルートから `deno task dev:desktop` で動かします。このディレクトリから import するサーバー側のモジュールは、ルートの import map が効かないため bare specifier を持てません。環境の取り出しは `packages/server/startup-env.ts` のように依存の無いモジュールへ分け、`startup.ts` から再輸出します。
- **サーバーのビルド経路**: `scripts/build-server.ts` に集約しています。確認は `deno task smoke:server` です。

### デスクトップのシェルブリッジ

シェル操作は loopback の HTTP へ送り（`packages/desktop/src-tauri/src/bridge_server.rs`）、届かない場合だけ Tauri IPC に退避します。経緯と理由は `ARCHITECTURE.md` の「シェルブリッジは loopback の HTTP、HTTPS のページは Tauri IPC へ退避する」にあります。

- **独自スキームにしない**: WKWebView（macOS）は http(s) のページから独自スキームを fetch させません。CSP の `connect-src` に `http://127.0.0.1:*` が必要です（`packages/server/render.ts`）。
- **HTTPS のページは IPC に退避する**: WebKit は https のページから loopback への fetch を遮断します。`shellCall` が切り替えるのは**通信段階の失敗**だけで、HTTP エラーで再実行するとアクションが二重に走ります。リモートページに許すコマンドは `capabilities/remote-shell.json` の `allow-shell-action` だけです。
- **macOS のウィンドウ操作は OS のもの**: `tauri.macos.conf.json` は `decorations: true` + `titleBarStyle: "overlay"` で、信号機はネイティブのものを使います。透明なタイトルバーはページの上に 28pt 重なり、その中のページ要素はクリックを受け取れません。帯は `.app.macos` の上余白の下から始め、上余白に `.macos-titlebar-drag` を置きます（左 78px は空ける）。ドラッグとダブルクリックはブリッジへ送ります。Windows / Linux はフレームレスのままページが描き、どちらかは `state` の `platform` が答えます。

## 2. 自動アップデート

デスクトップは Tauri updater でアプリ全体を更新し、サーバー単体は `packages/server/update/` がバイナリと静的ファイルを更新します。

- **署名鍵**: 共通の鍵を使います。変更時は `packages/server/update/verify.ts` と `tauri.conf.json` の両方を更新してください。
- **メタデータ**: 配布定義とバージョン比較は `packages/server/update/release.ts` に集約しています。
- **インストール先の名前**: 配布アーカイブの最上位は `lumisca-server-<platform>` で、バージョンを含めません。自己更新は同じディレクトリでファイルを差し替えるため、名前に版があると実際の版と食い違います（`packages/core/repo_hygiene_test.ts` が固定）。
- **デスクトップの更新マニフェスト**: `latest.json` の URL は直リンク（`releases/download/<tag>/<name>`）へ書き換えます。`api.github.com` の URL はレート制限に当たり、403 で更新のダウンロードが失敗します。書き換えは `scripts/rewrite-updater-json.ts` と `.github/workflows/rewrite-updater-json.yml` です。
- **動作条件**: サーバーの自己更新は、パッケージ済みバイナリかつ `LUMISCA_DESKTOP` 未設定のときだけ動きます。
- **再起動制御**: `LUMISCA_UPDATE_RESTART`（`self` / `supervisor` / `none`）で決まります。
- **事前検証**: アーカイブの整合性は `scripts/check-server-archive.ts` で確かめます。

## 3. Linux 常駐（systemd ユーザーユニット）

パッケージ済みサーバーは systemd のユーザーユニットとして常駐できます（`packages/server/systemd/`）。任意のコマンドを実行できるため、root ではなく一般ユーザーで動かします。

- `./lumisca-server service config`: 設定内容を確認
- `./lumisca-server service install`: 登録と起動
- `./lumisca-server service status`: 稼働状況と接続情報
- `./lumisca-server service uninstall`: 停止と登録解除

設定は `<config home>/systemd/user/lumisca.service` と `service.env` です。外部から接続するときは `--host` と `--allowed-hosts` を指定します。OS 起動時から動かすには `loginctl enable-linger <user>` が必要で、ログは `journalctl --user -u lumisca -f` で見ます。

## 4. 障害調査

サーバーが止まったら、アプリケーションデータ領域の `server.log` を見ます。

- **Windows**: `%APPDATA%\com.lumisca.agent\server.log`
- **macOS**: `~/Library/Application Support/com.lumisca.agent/server.log`
- **Linux**: `$XDG_DATA_HOME/com.lumisca.agent/server.log`

末尾から、クラッシュ（エラー出力）、強制終了（`[shell] Stopping`）、ハング（ヘルスチェックの無応答）を判別できます。systemd は `journalctl --user -u lumisca -n 100` です。

作業中のエージェント自身を止めないため、`deno` や `lumisca-server` をプロセス名で一括終了しないでください。個別のプロセス ID を指定します。

## 5. 依存関係の更新

依存のバージョンは直接編集せず、次のコマンドで更新します。

```bash
deno update -r --latest                                        # ルートおよび全ワークスペース
cargo update --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo update --manifest-path packages/browser-rpc/Cargo.toml
npm outdated                                                   # packages/desktop 内で実行
```

Deno は公開から 24 時間以内のバージョンを既定では導入しません。`packages/desktop` はワークスペース外なので個別に確認します。

## 6. UI の多言語対応

表示文言は `packages/core/shared/i18n/` のカタログに日英の対で置きます。コンポーネントでは `const t = useT();`（`packages/web/src/i18n.ts`）で `t("キー名")` を呼び、キーは `<area>.<surface>.<element>` 形式です。システムプロンプトとツール定義の英語文面は翻訳対象外で、回答言語はセッションの指示で制御します。文言を変えたら `deno test packages/core/shared/i18n_test.ts` を実行してください。

### 設定のカテゴリ

カテゴリは「共通」と、どちらか一方のモードのものに分かれ、混在しません（`packages/web/src/components/settings/categories.ts` の `scope`）。

- **共通**: 一般 / 外観 / プロバイダー / モデル設定 / MCPサーバー / カスタマイズ / 接続先サーバー / セキュリティ
- **code mode のみ**: 画面操作 / 保存済みプロンプト
- **stella mode のみ**: ルーチン

属するかは、サーバーがその値で何をするかで決めます。`/prompt` は code mode のコンポーザにしかなく、computer use はこのマシンの画面を動かし、ルーチンは stella の会話にしかありません。

- **カテゴリは 1 枚のページ**（`settings/SettingsPage.tsx`）。見出し（名前と、何を決めるかの 1 行）と本文を分け、本文だけをスクロールさせます。中から開く画面は 1 段低い `settings/SettingsSubHeader.tsx` を持ち、`modal-header` を重ねません。900px 以下では一覧とページを 1 枚ずつ出します（`.settings-body[data-view]`）。
- **プロバイダーは 1 画面に 2 種類**を同じ部品（`settings/SettingsSection.tsx` と `settings/ProviderRow.tsx`）で並べます。AI プロバイダーと Web 検索を分けると、検索側を見落とします。ページ名がそのまま節名になる画面では節の見出しを省きます。
- **選択肢は `components/Select.tsx`**。ネイティブの `<select>` は OS の見た目で描かれ、説明行も現在値のチェックも持てません。
- **設定の行は面を塗らない**。`SettingRow` や `.setting-card` / `.provider-row` は下線で区切った行です。
- **接続先はタイトルバーのドロップダウンだけ**（`components/ConnectionPicker.tsx`）。新規セッション画面にはサーバー選択を置きません。表示名はシェルが `settings.json` の `lastRemote` に記録して `state` で返します。設定画面の一覧は編集用で、行は畳んだ状態が既定、名前が空のまま URL を入れたらホスト名を補完します（`packages/web/src/connections.ts`）。
- **自分自身とは連携しない**: `connections` の各項目へ `/ws` を張って中継しますが、自分自身なら中継しません。判定は `/api/health` の `instanceId` です（tailnet 名や LAN アドレス経由の自分は URL では見分けられません）。中継済みのフレームを再中継しないのも同じ理由で、破るとエコーで CPU とメモリを食い尽くします（`packages/server/federation.ts`）。

### リモート接続での応答

- **差分はセッション単位でまとめる**: `/ws` と stella の会話ストリームは `message_delta` / `delta` を 16 ms 分まとめて 1 フレームにします（`packages/core/shared/ws-batch.ts`）。キーがセッション id なのは、1 本のソケットが複数タブのイベントを運ぶからです。ツール開始・確定・終了は遅延させず、送る前に保留分を flush します。
- **rev はイベント数のまま**: フレームには最後の `rev` と、含めたイベント数 `events` を載せます。`revisionGap` は `events` を見ます。ここを「1 フレーム = 1 イベント」に戻すと、結合のたびにスナップショットを取り直します。
- **クライアントも rAF でまとめる**: `useSessionEvents` / `useStella` は保留中の delta をアニメーションフレーム単位で反映し、他のイベントの適用前に必ず flush します。
- **圧縮と再検証**: 全応答を gzip し、`/assets/*` は `ETag` で再検証、ページと初期データは `no-store` です。CSS はページの `<style>` にインラインします（`packages/server/render.ts`）。規則は `packages/server/app-file-headers.ts` にあります。
- **プロキシ**: タイムアウトは `packages/server/federation.ts` の `proxyTimeoutFor` がパスから決めます（通常 30 秒、open／messages／compact／rewind は 120 秒、`/fed/peers` は 3 秒）。`content-disposition`、`cache-control`、`etag`、`vary`、`content-security-policy`、`x-content-type-options` は透過し、`content-encoding` は通しません。
- **同一サーバーの判定はスキームを見ない**: CORS と WebSocket の Origin 検証は、Origin のホストとポートが `Host` と一致するかで決めます（`packages/server/security.ts` の `sameServerAuthority`。MCP の `redirect_uri` も同じ関数）。TLS 終端は https を受けて http で転送するため、スキームまで比べると `/ws` が 403 になり、本文が流れないまま 10 秒おきのスナップショットだけになります。

## 7. stella mode（仮想マシン）

podman コンテナを仮想マシンとして与え、その中だけでエージェントを動かすモードです。実装は `packages/core/vm/` にあり、会話は相手（agent）ごとに 1 本だけです。表示するモードはクライアントごとに選び（`packages/web/src/hooks/useAppMode.ts`）、サーバーは能力と状態だけを返します（`GET /api/stella/status`）。

### マシン

- **必要環境**: Linux と rootless podman だけです。`podman --version` が通っても起動できるとは限らないので、素のイメージを 1 回起動して確かめ（`VM_PROBE_IMAGE`）、失敗すれば `podman_unusable` として提示を断ります。
- **イメージ**: `packages/core/vm/container/Containerfile` から初回起動時にビルドします。配布物では `scripts/build-server.ts` が `stella-container/` をバイナリの隣へ同梱し、`packages/server/paths.ts` が場所を解決します。定義のダイジェストを `lumisca.container-digest` ラベルに焼き、ずれていればイメージを作り直します（`/home/agent` は `podman cp` で退避して戻します）。
- **契約値**: 画面サイズ（1280x800）、DISPLAY、uid/gid、作業ディレクトリ、パスワード無し `sudo` は `packages/core/vm/contract.ts` と Containerfile / entry.sh の両方にあります。起動時に実コンテナと突き合わせ（`sudo -n true` を含む）、ずれていれば起動を失敗させます。
- **権限**: `agent` は `sudo` を使えます。コンテナの外へは出られず（ホストをマウントせず、uid 0 は `--userns keep-id` で写像）、既定を root にしないのは Chromium のサンドボックスを使うためです。
- **同梱ファイルは 1 段まで**: `stella-container/Containerfile` は可、`stella-container/helper/a11y.py` は不可です。アーカイブを読むのは動いているサーバーのバイナリで、深さの規則はビルド時に焼き込まれます。深くすると、その版より前にインストールされたサーバーが更新を適用できません。`archive.ts` の `MAX_PACKAGE_DEPTH` を上げるのは、旧版の更新を諦めるときだけにしてください。

### 会話

- **相手は常に 1 人以上**: `GET /api/stella/agents` の初回読み出しでスターターを作ります（`LumiscaCore.ensureStellaAgent`）。全員を削除しても次の読み出しで戻ります。
- **一覧の行は最新の発言**: 2 行目は会話と同じ射影（`shared/stella-preview.ts` の `previewOf`）、並びも最新メッセージの時刻です。開いていない会話にはストリームが無いので、一覧は 30 秒ごとに読み直します（`useVisibleInterval`）。
- **話す手段は本文と `send_chat`**: 本文はそのまま返信になり、`send_chat` がカード・ファイル・途中経過を添えます（`packages/core/tools/send-chat.ts`）。黙るターンは `NO_RESPONSE` だけを書きます（`packages/core/agent/silent-reply.ts`）。`text`・`card`・`paths` は 1 回で 1 つのメッセージになり、少なくとも 1 つ必要です。
- **モデルの切り替え**: `POST /api/stella/conversations/:agentId/model`（`provider` と `modelId` が必須、実行中は 409）。切り替えてもシステムプロンプトは変わりません。モデル名は context メッセージとして公開します（`packages/core/agent/model-context.ts`）。
- **identity**: `role` とは別に、`identity` ツールで自分の役割と知識を書けます（`stella_agents.identity`、`packages/core/stella/identity.ts`）。context メッセージとして届き、反映は次のターンからです。

### ツール

- **集合**: ファイル、シェル、画面、意味の層、`send_chat`、`history_search`、`skill`、サブエージェントがプリロードされます。`ask` と `todo` はありません。`identity` と `agent_create` は main レジストリ経由で `tool_search` から見つけさせます。`agent_create` の役割は `role` か `role_file`（マシン内のファイル）で渡し、UTF-8 でない・空・20,000 文字超は拒否します。
- **`eval` は渡さない**: サーバープロセス内で JavaScript を実行するため、VM の外へ出る経路になります。VM 内でコードを動かすときは `bash` から `node` を使います。サブエージェントにも渡しません（`SubagentRuntime.eval` が `false`）。
- **レジストリの分離**: セッションは `main` と `subagent` の 2 つを持ちます（`packages/core/tools/registries.ts`）。MCP・browser-lab・computer・`pdf_read_pages` は両方に入り、`identity` / `agent_create` / `routine_*` は main だけです。
- **パスの境界**: 相対パスと `bash` の基点は `/home/agent/agents/<agent id>`、境界は `/home/agent` です（`packages/core/vm/fs.ts` の `resolveVmPath`）。変えるときは `packages/core/tools/system-prompt.ts` も合わせてください。
- **ファイルの送受信**: ユーザーへは `send_chat` の `paths`（code mode は `chat_attach`）で送ります。上限は `attachFiles()` の 1 箇所で、1 件 4 MiB・1 回 10 件・合計 16 MiB、累計に上限はありません。ユーザーからの添付はマシンの中に書き（`packages/core/vm/uploads.ts`）、メッセージは参照と表示名・サイズだけを持ちます。表示はマシンから読み、消えていれば 404 です。

### 画面

- **パネルは既定で閉じる**: 開閉はヘッダーのトグルで、送信で勝手に開き直しません。`vm_ask_user` の受け渡し中だけは必ず開きます。
- **computer use は code mode だけ**: `agent/factory.ts` が stella セッションへ渡しません（VM には `vm_screenshot` / `vm_act` と `vm_find` / `vm_do` / `vm_wait` があります）。設定でも「画面操作」は code mode 専用です。
- **GUI は意味で操作する**: ボタンを押す用途には `vm_find` / `vm_do` / `vm_wait` を使います。画素のツールは、座標を読んで渡すしかない対象（キャンバス、ドラッグ、ゲーム）のためです。結果は `delivered_verified` か `delivered_unverified` で返り、後者は繰り返すと二重に押すことになります。
  - 実装は VM の中の 1 本の Python（`packages/core/vm/container/a11y.py`）で、Deno 側（`vm/semantic.ts`）は JSON を渡して結果を文にするだけです。
  - ref（`@s12345:e7`）はスナップショットに属し、`vm_do` は role と name が変わっていれば拒否します。経路は `a11y.py` の `walk` が tuple で組み立て、読み戻しも role と name で引き直します。
  - ウィンドウの題名は frame の name なので、保存後の確認は `vm_wait` で待つのが確実です。xterm のようにバスへ出ないアプリは `vm_find` に出ません。
- **アクセシビリティはイメージ側の設定**: `entry.sh` がアプリの起動前に `gsettings set org.gnome.desktop.interface toolkit-accessibility true` を実行します。GTK アプリはこの値を起動時に 1 度だけ読み、後から変えてもバスに出ません。Chromium には `--force-renderer-accessibility` を付けます。
  - 契約値は `contract.ts` の `VM_DBUS_ADDRESS` / `VM_A11Y_GSETTINGS_KEY` / `VM_A11Y_HELPER` で、`verifyImageContract` が 1 回の `podman exec` で検査し、欠ければ起動を落とします。`containerFilesDigest` はサブディレクトリも含めます。
  - スクロールは X11 のホイールボタン（4 上・5 下・6 左・7 右）で、正の値で 5 を送ります（`VM_SCROLL_NOTCH` = 100、上限 20）。
- **受け渡し**: 人が必要な手順は `vm_ask_user` で待ちます（`packages/core/vm/handover.ts`）。待機中は画面ペインが操作可能になり、エージェントは止まっています。待ちを解く経路を増やすときは、`cancelAll` とイベントの後始末も確認してください。

### 履歴と自動実行

- **ルーチン**: `daily` / `weekly` / `every` の 3 種類だけで、cron は扱いません。次回時刻は保存値ではなく `packages/core/shared/routine.ts` の `nextRunAt` で計算し、実行前に進めます。
- **放置された会話の圧縮**: 最後のメッセージから 30 分たったとき、モデルの視界が 50k トークン以上なら畳みます（`SessionAgentOptions.idleCompaction`、定数は `packages/core/agent/factory.ts` の `STELLA_IDLE_COMPACTION`、保持は 20k）。要約中に会話が動いたら挿入せずに捨てます（`ContextCompactor.compactNow` の `canCommit`）。畳んだ区間のペイロードは落としますが（`packages/core/session/prune.ts`）、行は消しません。
- **履歴は遅延読み込み**: メモリに載せるのはモデルの視界（最新チェックポイント以降）だけです（`MessageRepo.listModelView`）。画面の遡りは `packages/core/session/transcript-pager.ts` がストアから引きます。**ページが数える行（`CONVERSATION_ROWS_SQL`）は、射影（`stellaEntryOf`）がエントリにする行と同じ集合でなければなりません**。片方だけ変えると、画面に出ていた発言が再読み込みで消えます。
- **空いた領域は次の起動で返す**: `close()` がマーカーを書き（`packages/core/db/vacuum.ts` の `vacuumMarkerPath`）、次の起動時にファイルを作り直します（`vacuumOnStartup`、`packages/server/mod.ts`）。`node:sqlite` は `VACUUM` を使えないため、全行コピーと rename です。
- **`history_search`**: 検索するのは会話の射影（画面に出るもの）だけで、結果はローカル日時付き、`from` / `to` で期間を切れます。ツール名・引数・結果は出ません。

### 名前とアイコン

- **1 つのダイアログで変える**（`packages/web/src/components/stella/AgentEditDialog.tsx`）。`PATCH /api/stella/agents/:id` に `{ name?, icon? }` を送り、`icon` 省略は変更なし、`null` は頭文字、`{data, mimeType}` は差し替えです。名前を先に検証する（空名・長すぎる名前は 400、重複名は 409）ので、弾かれたときに画像は書かれません。
- **並びは動かさない**: 改名も差し替えも `updated_at` を触りません。「最後に話した順」のままです。
- **`role` は編集できない**: 作成時のシステムプロンプトに入っており、後から変えても既存の会話に届きません。名前もプロンプトには入りません（`packages/core/tools/system-prompt.ts`）。プロンプト自体はセッションを開くたびに導出し直され、保存値と違えば書き換わるので（`packages/core/agent/factory.ts` の `ensureSystemPrompt`）、新しい版でプロンプトを変えれば既存の会話にも届きます。
- **アイコン**: 保存先は DB 隣の `.lumisca-agent-icons/<agent id>/`（`packages/core/stella/icons.ts`）。未設定なら名前の頭文字を `agent id` から導いた色の上に描きます（`packages/core/shared/agent-avatar.ts`）。PNG / JPEG / GIF / WebP / BMP の 512 KiB までで、SVG は置けません。

## 8. MCP サーバーの管理（会話から）

エージェントは `mcp_add` / `mcp_remove` / `mcp_list` で、設定画面と同じアプリ全体の設定を変更できます（`packages/core/mcp/manage-tools.ts`）。ワークスペースの `.mcp.json` とプラグインのサーバーは対象外です。

- **探索経路**: 3 つはプリロードせず main レジストリに置き、`tool_search` → `tool_call` で呼びます。sub-agent には渡しません。組み込みスキル `mcp-servers`（`packages/core/skills/builtin/mcp-servers.ts`）が経路を教えます。
- **接続テスト**: `mcp_add` は接続してツール一覧を取るまで 1 行も保存しません（30 秒）。401 はサインイン要求として保存し、設定画面でのサインインを促します。初回の取得が 30 秒を超える場合は `verify: false` で省けます。
- **保存先の書き換え**: `McpService.addAppServer` / `removeAppServer` は該当エントリだけを差し替えます。丸ごと書き戻すと、他のサーバーの `${VAR}` が展開後の値で確定します。
- **適用**: 保存は `setAppMcpConfig` を通るので、開いているセッションは idle なら再構築、実行中なら差し替えで追従します（`SessionPool.applyMcpConfigChange`）。

## 9. 開発用スクリプト

手元の確認は `deno task` から実行します。どれも手動操作用で、CI からは実行しません。

- `deno task demo`: faux プロバイダで動くデモサーバー
- `deno task seed:history <sessionId> [nPairs]`: 指定セッションに長い履歴を流し込む
- `deno task probe:token`: 認証トークンのガードを確認
- `deno task probe:computer`: computer use が使えるかを確認（`--click x,y` で操作も）
- `deno task probe:stella`: stella mode が使えるかを確認（`--start` でビルドから停止まで）

引数の詳細は各スクリプトの先頭コメントにあります。

## 10. 画像の保存

エージェントが読み込んだ画像と、プロンプトに添付された画像は、トランスクリプト（DB）に画像ブロックとして残ります。保存前に `packages/core/media/stored-image.ts` の `prepareStoredImage` を通してください（長辺 1568px・1 MiB に収め、まだ重ければ JPEG 化）。

- **画像を返すツールは、画像ブロックを作る前にこの関数を通す**。注記には縮小後の寸法と容量を書きます（`read` の `[image: …]`、`pdf_read_pages` の頁の行、`browser_screenshot` の 1 行目）。名乗る数値と実際の画像が食い違うと、モデルは別のものを見ていることになります。
- **座標を持つ 2 つのスクリーンショット**（`computer_screenshot` / `vm_screenshot`）も同じ規則で縮め、結果の文に画面の寸法と倍率を必ず書きます（`computer_screenshot` は `screen = round(image / scale)`、`vm_screenshot` は「画像の位置 × 倍率」）。倍率が無いと、モデルが読んだ位置とクリック先がずれます。
- **プロンプト添付**は `packages/server/routes/session-requests.ts` の `preparePromptImages` を通します。code mode はメッセージへ、stella はマシンへ書くためです。
- **原ファイルとユーザーへ送るファイルは触りません**。`chat_attach` / `send_chat` / `visual` は、アセット置き場（4 MiB 上限）にそのままのバイト列を書きます。

## 11. スキルの作成・書き換え

スキルは会話から作れます。作成用のツールはなく、フォルダと `SKILL.md` なので `read` / `write` / `edit` / `list_dir` で書き（削除だけ `bash` の `rm`）、書き方は組み込みスキル `skill-authoring` が教えます。

- **置き場所は 4 つ**: ワークスペースの `.agents/skills`、Lumisca 用フォルダ（`<config home>/lumisca-agent/skills`）、`~/.agents/skills`（読み取りのみ）、組み込みです。stella ではエージェント自身の `.agents/skills` とマシン共通の `/home/agent/.agents/skills` で、ホストの Lumisca 用フォルダは読みません。
- **Lumisca 用フォルダは追加ルート**: `Sandbox` の `extraRoots` に入り、絶対パスでだけ届きます。フォルダ名による相対パス解決には参加しないので、リポジトリに `skills/` があっても曖昧になりません。退避先の `roots[0]` はワークスペースのままです。
- **`skill` ツールは一覧を毎回引き直す**: カタログ provider と同じディスカバリを呼ぶので、書いたスキルを同じ run で読めます。固定配列に戻すと「一覧には出るが `Unknown skill`」になります。
- **ガイドの広告条件**: ファイルツールを持つセッションだけです（`BuiltinContext.skillAuthoring`）。stella では共通フォルダのパスをマシン側のものにして渡します。
- **テストの隔離**: `LumiscaCore.forTesting` は `appSkillDirs: []` を渡します。配線するときは `globalSkillDirs` と同じく core → pool → toolsets / task-hub へ通してください。

## 12. PWA（インストール）

https（`tailscale serve` など）で開いた端末から、ページを PWA としてインストールできます。理由は `ARCHITECTURE.md` の「PWA としてのインストール」にあります。

- **manifest はリクエストごとに生成**します（`packages/server/manifest.ts`）。`theme_color` はそのページの第一描画のテーマ色で、`@lumisca/core/shared` の `THEME_COLORS` と `tokens.css` の `--bg` が一致することを `styles_test.ts` が検査します。`start_url` に token を入れないでください。
- **token ガードの対象外は `/manifest.webmanifest`・`/pwa/*`・`/sw.js`**（`security.ts` の `unguardedPath`）。ブラウザのインストール処理が Cookie 無しで取りに来るためです。秘密は載せないでください。
- **アイコンは `packages/web/public/pwa/` の PNG を `assets.json` に base64 で埋め込みます**（`PWA_ICON_FILES`）。宣言する `sizes` は実ファイルと一致させてください（`app_assets_test.ts` が照合）。`icon-maskable-512.png` は円形マスクで切られないよう、内容を 70% に縮めています。
- **Service Worker は https のページでのみ登録**します（`packages/web/src/pwa.ts`）。デスクトップの `http://127.0.0.1` は secure context なので、スキームの判定がそのまま除外になります。キャッシュは `/assets/*.js`（`initial-data.js` を除く）、`/pwa/*`、`/favicon.png`、manifest だけで、network-first です。ページ・`/api`・`/ws` には触りません。
- **`public/sw.js` のキャッシュ方針を変えたら `CACHE_NAME` を上げてください**。`/sw.js` は `max-age=0, must-revalidate` で配ります。
- **standalone の余白**: viewport は `viewport-fit=cover`、余白は `env(safe-area-inset-*)` で戻します（`layout.css` の `.app`、全画面 `.modal`、`.mp-popover`）。`packages/server/render.ts` と `packages/web/index.html` の viewport は揃えたままにしてください。
- **確認**: `app_assets_test.ts` と `app_security_test.ts` が通ること。実機は Chrome の DevTools → Application → Manifest で、警告が出ないことを見ます。
