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

たとえば `STELLA_COMPACTION_STYLE.maxTokens` の「モデルが実際に出せる量より多い出力を要求してはいけないので、記録の上限と予算の小さい方を採る」は書きます。関係が破れたときに何が起きるかは、コードから読めないためです。逆に `/** The RPC path. */`（`RPC_PATH`）や `// Filter by search query`（`filtered`）は書きません。

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
- **macOS のウィンドウ操作は OS のもの**: `tauri.macos.conf.json` は `decorations: true` + `titleBarStyle: "overlay"` で、信号機はネイティブのものを使います。透明なタイトルバーはページの上に 28pt 重なり、その中のページ要素はクリックを受け取れません。帯は `.app.macos` の上余白の下から始め、上余白に `.macos-titlebar-drag` を置きます（左 78px は空ける）。ドラッグとダブルクリックはブリッジへ送ります。Windows / Linux はフレームレスのままページが描きます。
- **帯を描くかはブリッジの応答で決めない**: どちらの作法かは初期化スクリプトの `__LUMISCA_PLATFORM__` が答え、帯の有無は `inDesktopShell()` が決めます（`packages/web/src/shell.ts`）。`state` の読み出し失敗で帯を落とすと、`decorations: false` の窓は閉じることも動かすこともできなくなります。モード選択画面（`App.tsx` の `mode === null`）も同じ帯を持ちます。モードは `localStorage` でオリジンごとなので、リモート接続の初回は必ずこの画面から始まるためです。
- **帯の中身は `.titlebar-controls` に場所を譲る**: 帯は横 1 行の flex で、右端の `.titlebar-controls`（接続先・メニュー・3 ボタン）は `flex: none` です。帯へ入る中身（タブバー、stella の `.stella-titlebar-strip`）は `flex: 1` と `min-width: 0` を持ち、幅を独占してはいけません。`width: 100%` を書くと controls が右端の外へ押し出され、`decorations: false` の窓は**閉じるボタンだけを失って、ドラッグは効くまま**になります（stella モードで実際に起きた。`packages/web/src/styles_test.ts` が固定）。`width: 100%` が要るのは、素のブラウザで帯が無く `.app` の縦積みの子になる場合だけです。
- **ファイルのドロップはページが受ける**: main ウィンドウは `tauri.conf.json` で `dragDropEnabled: false` です。既定の `true` では Tauri のネイティブ D&D が WebView の HTML5 D&D を置き換え、コンポーザへのドロップが DOM に届きません（画像も含めて）。Tauri の `DragDropEvent` は使っていません。有効にした分の穴は `packages/web/src/drop-guard.ts` が塞ぎます——コンポーザ以外へファイルを落としても、ウィンドウがそのファイルへ遷移して戻れなくなります。スプラッシュ（`frontend/splash.js`）も同じガードを持ちます。`repo_hygiene_test.ts` が `false` を固定しています。

## 2. 自動アップデート

デスクトップは Tauri updater でアプリ全体を更新し、サーバー単体は `packages/server/update/` がバイナリと静的ファイルを更新します。

- **署名鍵**: 共通の鍵を使います。変更時は `packages/server/update/verify.ts` と `tauri.conf.json` の両方を更新してください。
- **メタデータ**: 配布定義とバージョン比較は `packages/server/update/release.ts` に集約しています。
- **インストール先の名前**: 配布アーカイブの最上位は `lumisca-server-<platform>` で、バージョンを含めません。自己更新は同じディレクトリでファイルを差し替えるため、名前に版があると実際の版と食い違います（`packages/core/repo_hygiene_test.ts` が固定）。
- **デスクトップの更新マニフェスト**: `latest.json` の URL は直リンク（`releases/download/<tag>/<name>`）へ書き換えます。`api.github.com` の URL はレート制限に当たり、403 で更新のダウンロードが失敗します。書き換えは `scripts/rewrite-updater-json.ts` と `.github/workflows/rewrite-updater-json.yml` です。
- **動作条件**: サーバーの自己更新は、パッケージ済みバイナリかつ `LUMISCA_DESKTOP` 未設定のときだけ動きます。
- **再起動制御**: `LUMISCA_UPDATE_RESTART`（`self` / `supervisor` / `none`）で決まります。
- **適用中は `installing` を返す**: ファイルの置き換えは数秒かかり、その間ほかの状態は動きません。画面はこれで「インストール中…」を出してボタンを止めます。解除は `#fail` と成功時の `#patch` で行い、`apply()` の `finally` では行いません——戻り値は `finally` より先に作られるため、「インストール中のまま」の応答が返ります。
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

カテゴリはどちらのモードでも同じ並びで出ます（`packages/web/src/components/settings/categories.ts`）。モードで隠す項目はなく、モードはその値が効くセッションを決めるだけです。ナビは効く範囲で 3 群に区切り、見出しでどちらに効くのかを示します。

- **共通**: 一般 / 外観 / プロバイダー / モデル設定 / MCPサーバー / カスタマイズ / 接続先サーバー / セキュリティ
- **code mode**: 画面操作 / 保存済みプロンプト
- **stella mode**: ルーチン

モード専用の意味を持つものは、足りないものを画面で言います。`/prompt` は code mode のコンポーザにしかなく、computer use はこのマシンの画面を動かし、ルーチンは stella のエージェントの会話にしかありません。パネルはどちらのモードでも開け、対象が無ければその旨を出します（ルーチンは「エージェントを選択すると…」）。

- **カテゴリは 1 枚のページ**（`settings/SettingsPage.tsx`）。見出し（名前）と本文を分け、本文だけをスクロールさせます。中から開く画面は 1 段低い `settings/SettingsSubHeader.tsx` を持ち、`modal-header` を重ねません。900px 以下では一覧とページを 1 枚ずつ出します（`.settings-body[data-view]`）。
- **プロバイダーは 1 画面に 2 種類**を同じ部品（`settings/SettingsSection.tsx` と `settings/ProviderRow.tsx`）で並べます。AI プロバイダーと Web 検索を分けると、検索側を見落とします。ページ名がそのまま節名になる画面では節の見出しを省きます。
- **選択肢は `components/Select.tsx`**。ネイティブの `<select>` は OS の見た目で描かれ、説明行も現在値のチェックも持てません。
- **設定の行は面を塗らない**。`SettingRow` や `.setting-card` / `.provider-row` は下線で区切った行です。
- **能力のトグルは実行中のセッションにも効く**（computer use など）。設定への保存は実行中のセッションがあっても必ず行います（`SessionPool.applyCapabilityChange`）。待機中のセッションは再構築し、実行中のセッションはエージェントを差し替えず（差し替えると run の行が二重になる）ツールレジストリと能力フラグだけをその場で更新します。ツールはプリロードされずレジストリにだけ入るので、これで追従できます。能力の値は開いた時点で捕捉せず getter で渡してください（`SessionWhere.computerAvailable`、`ToolFactoryOptions.computerAvailable`）。値で持つとスキル一覧が次の open まで古いままになります。
- **接続先はタイトルバーのドロップダウンだけ**（`components/ConnectionPicker.tsx`）。新規セッション画面にはサーバー選択を置きません。表示名はシェルが `settings.json` の `lastRemote` に記録して `state` で返します。設定画面の一覧は編集用で、行は畳んだ状態が既定、名前が空のまま URL を入れたらホスト名を補完します（`packages/web/src/connections.ts`）。
- **新規セッション画面のモデルは既定モデルに書く**: ピッカーの選択は `packages/web/src/defaultModel.ts` の `rememberDefaultModel` で `model_default` に保存します。あの画面はタブ切り替えのたびに作り直され、リロードでも消えるので、コンポーネントの state だけに持たせると選んだモデルが次の表示で既定に戻ります。失敗は画面に出す（黙って落とすと、次に開いたときに既定へ戻った理由が分かりません）。設定画面の「既定のモデル」の行と同じ値なので、片方だけ変えると 2 つの画面が食い違います。`settingsStore` が未読のうちに書くと「表全体を読んだ」ことになり設定パネルが他の値を未設定と表示するので、`rememberDefaultModel` は先に読みます。
- **自分自身とは連携しない**: `connections` の各項目へ `/ws` を張って中継しますが、自分自身なら中継しません。判定は `/api/health` の `instanceId` です（tailnet 名や LAN アドレス経由の自分は URL では見分けられません）。中継済みのフレームを再中継しないのも同じ理由で、破るとエコーで CPU とメモリを食い尽くします（`packages/server/federation.ts`）。

### 画面の URL

画面はすべて URL を持ちます（`packages/web/src/route.ts`）。URL が「いまどの画面か」の唯一の答えです。

| 画面 | URL |
| --- | --- |
| モード選択（未選択） | `/` |
| code mode のトップ（新規セッション） | `/code` |
| このサーバーのセッション | `/code/s/<sessionId>` |
| ピアのセッション | `/code/p/<peerId>/s/<sessionId>` |
| stella のエージェント一覧 | `/stella` |
| stella の会話 | `/stella/a/<agentId>` |
| 設定 | `<画面>/settings` / `<画面>/settings/<category>` |

- **`route.ts` は純粋関数だけ**。`parseUrl` と `urlOf` が往復し、DOM に触れません。`hooks/useRoute.ts` だけが `history` を触ります。
- **設定はモードの下**。カテゴリの一覧はどちらのモードでも同じですが、設定はそこを開いたモードの画面の一部で、閉じればその画面へ戻ります。モードを持たない `/settings` は、戻る先を答えられません。閉じると開いた画面へ戻ります（`history.back()`。履歴が無ければ `replace`）。
- **`/` は解決先**。デスクトップシェルとインストールした PWA が開く URL なので、`localStorage` の `lumisca.appMode` に解決し、`replace` で `/code` か `/stella` に置き換えます。未選択ならモード選択画面のままです。
- **URL はモードを決める**。`/stella` を開けば保存値が code でも stella になります。stella を使えないサーバーでは理由を出して `/code` に倒し、そのstella は保存しません。
- **戻るで画面が戻る**。タブ切り替え、セッションを開く、設定の開閉、設定カテゴリの変更がそれぞれ履歴になります。ただし `POST /close` は × で閉じたときだけです（戻るは画面を移るだけで、実行は止めません）。
- **設定を閉じるのは、開いてから積んだ分をまとめて戻す 1 回**です。カテゴリの変更も履歴なので、直前に 1 歩戻るだけでは前のカテゴリページに着き、`Modal` の退出が終わった不可視のシート（`opacity: 0` でも `position: fixed; inset: 0`）が画面を覆ったままになります。深さは各エントリの `history.state` が持ちます（`packages/web/src/history-entry.ts`）。`replace` で別の画面に差し替えるときは、その深さを 0 に戻してください。
- **存在しない画面はモードのトップへ**。消えたセッション・消えたエージェント・知らないカテゴリは、エラー画面ではなく使える画面に倒します（このアプリに 404 ページはありません）。
- **`/code` の状態は URL のタブだけ**。以前の「開いていたタブをすべて `localStorage` から復元」は廃止しました（URL が同じ問いに答えるため）。タブバーはこのページが開いたセッションの一覧です。
- **ドラフトはセッションの集合で管理**。`/code` の下書きは、セッションへ移っても消えません（`useDrafts` は `useTabs` の `open` をキーにします）。
- **画面遷移は階層のある移動だけ**: 遷移するのは stella の一覧 ⇄ 会話と、設定の一覧 ⇄ カテゴリページです。判定は `packages/web/src/screen-transition.ts` の `screenMove` がアドレスの組から決め、`hooks/useRoute.ts` の push / replace / `popstate` が `playScreenTransition` を通します。タブの切り替え、新規セッション画面とセッション、ダイアログの開閉は遷移しません（並列の面であり、階層ではないためです）。向きは `<html data-vt="push|back">` として JS が書き、形は `styles/motion.css` が決めます（600px 以下は横スライド、それ以上はフェード）。
  - **内側の要素に `view-transition-name` を書かない**: 名前を持つ要素は別スナップショットになり、同時に包含ブロックになります。`position: fixed` のダイアログと仮想マシンの画面ペインが、自分自身ではなくその要素を基準に置かれて壊れます（`styles_test.ts` が固定）。
  - **`flushSync` が要る**: Preact は描画をマイクロタスクに積むので、遷移のコールバックの中で `flushSync` をしないと、2 枚目のスナップショットが前の画面のままになります。
  - **戻るは履歴を戻す**: 一覧へ戻る操作（stella の戻る、設定ページの戻る）は `push` ではなく `router.dismiss` です。向きはアドレスの組から決まるので、ボタンとブラウザの戻るが同じ動きになります。設定の `showPage` は廃止し、表示は `category` から導出します（住所が唯一の答え）。
  - **未対応ブラウザでは動かないだけ**: Safari 18 / Firefox 133 より前にはアニメーションが付きません。画面の移り方は同じです。
- **開閉する面は `.collapse` を使う**: 進捗の行（`components/Panel.tsx`）、ツール呼び出し（`components/ToolCall.tsx`）、通知行（`components/SystemRow.tsx`）、ターンの作業ログ（`components/chat/ConversationTurn.tsx`）は、本体を**常にマウント**し、`className="collapse" data-open={open}` の内側に `collapse-inner` を挟みます（規則は `styles/motion.css`）。
  - **`{open && …}` を書かない**: アンマウントした要素は閉じる動きを持てません。開閉は `data-open` 1 か所で表します。
  - **高さは `grid-template-rows: 0fr ⇄ 1fr`**: 測った `height` を書くと、ストリーミングで伸びる中身に対して次のフレームには古くなります。`1fr` はブラウザが中身から答え続けます。`width` / `height` は今までどおり動かしません。
  - **`overflow: hidden` は `collapse-inner` に**: 本体の `max-height` / `overflow-y`（進捗の行はその中でスクロールします）を保つためです。`collapse > .collapse-inner > *` がフェードを持つので、内側の面に `opacity` のアニメを足さないでください。
  - **運動を減らす設定では止める**: `reduced-motion.css` が `.collapse` の `transition` を `none` にします。高さは動きそのものです。
- **実行中のツール行は `tool_start` から描く**: AI SDK は 1 ステップのツールをストリームの中で実行するので、toolCall ブロックを持つ assistant メッセージ（`message_end`）はツールが終わった後に届きます。メッセージだけを描くと、行は仕事が済んでから現れます。`SessionView.liveTools` が `tool_start` で行を足し、その呼び出しを含むメッセージの `message_end` で消します（`components/Transcript.tsx` がストリーミング本文の直下に描きます）。消し忘れると行が二重に出ます。faux プロバイダだけは順序が逆（メッセージが先、`executeTools` が後）なので、読み込み済みの履歴に同じ id があるときは足しません。

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
- **落ちたマシンは podman が戻す**: `podman create` に `--restart=unless-stopped` を渡します。マシンは会話を開くときにしか起動されないので、自前で死んだコンテナは止まったままになり、全ツールが `container state improper` を返していました。`podman stop` は手動停止として扱われるため、アプリの終了（`LumiscaCore.close()`）で止めたマシンは戻りません。送信とルーチン実行は起動を確かめてから走ります（`ensureStellaReady`）。
- **本番のマシンに触るテストは明示したときだけ**: `packages/core/stella_live_test.ts` は利用者の `lumisca-stella` をそのまま使います。`LUMISCA_STELLA_LIVE=1` が無ければ状態も読まずに skip し、`core.close()` の前に `setStellaVm(undefined)` で切り離します——`close()` は持っているマシンを止めるためです。`scripts/probe-stella.ts` も同じ理由で切り離してから閉じます。`deno task test` に含まれるので、ここを緩めるとテストを回しただけで利用中のマシンが落ちます。
- **権限**: `agent` は `sudo` を使えます。コンテナの外へは出られず（ホストをマウントせず、uid 0 は `--userns keep-id` で写像）、既定を root にしないのは Chromium のサンドボックスを使うためです。
- **同梱ファイルは 1 段まで**: `stella-container/Containerfile` は可、`stella-container/helper/a11y.py` は不可です。アーカイブを読むのは動いているサーバーのバイナリで、深さの規則はビルド時に焼き込まれます。深くすると、その版より前にインストールされたサーバーが更新を適用できません。`archive.ts` の `MAX_PACKAGE_DEPTH` を上げるのは、旧版の更新を諦めるときだけにしてください。

### 会話

- **相手は常に 1 人以上**: `GET /api/stella/agents` の初回読み出しでスターターを作ります（`LumiscaCore.ensureStellaAgent`）。全員を削除しても次の読み出しで戻ります。応答は `{ agents }` だけで、どの会話を開くかは返しません——それは URL（`/stella/a/<id>`）が答えます。
- **一覧の行は最新の発言**: 2 行目は会話と同じ射影（`shared/stella-preview.ts` の `previewOf`）、並びも最新メッセージの時刻です。開いていない会話にはストリームが無いので、一覧は 30 秒ごとに読み直します（`useVisibleInterval`）。
- **話す手段は本文と `send_chat`**: 本文はそのまま返信になり、`send_chat` がカード・ファイル・途中経過を添えます（`packages/core/tools/send-chat.ts`）。黙るターンは `NO_RESPONSE` だけを書きます（`packages/core/agent/silent-reply.ts`）。`text`・`card`・`paths` は 1 回で 1 つのメッセージになり、少なくとも 1 つ必要です。
- **カードだけは書きながら出る**: モデルが `send_chat` の引数を流している間、`card_delta` が届き、画面は `parseUiMarkupPartial` で閉じたブロックまで描きます。断片の切り出しは `packages/core/ai/tool-args-field.ts`、まとめは stella のイベントストリームの `delta` チャネルです。本文はターンの終わりに一度に届きます。
- **モデルはエージェントごと**: 選択はエージェントの編集ダイアログで行い、`PATCH /api/stella/agents/:id` の `model`（`null` は既定、省略は変更なし）で保存します。未設定ならアプリの既定モデル（設定 → モデル設定）を使います。選択はそのエージェントの会話の `sessions` 行にも同じ呼び出しで書き込まれます。会話が実行中でも拒否せず、保存したうえでその実行が終わってから適用します（`SessionService.setSessionModel`。code mode の `POST /api/sessions/:id/model` も同じです）——実行中のモデルを差し替えると run の行が二重になり、待たせるのは実行と関係のない要求を断ることになるためです。会話のモデルだけを切り替えるルートはありません——2 つの入口があると、どちらが正しいかが決まらなくなります。切り替えてもシステムプロンプトは変わりません。モデル名は context メッセージとして公開します（`packages/core/agent/model-context.ts`）。
- **identity**: `role` とは別に、`identity` ツールで自分の役割と知識を書けます（`stella_agents.identity`、`packages/core/stella/identity.ts`）。context メッセージとして届き、反映は次のターンからです。

### ツール

- **集合**: ファイル、シェル、バックグラウンド実行（`async_bash` / `async_bash_status` / `async_bash_kill`。VM 内で `setsid` で動き、完了は通知としてモデルに届きます。パネルはありません）、画面、意味の層、`send_chat`、`history_search`、`skill`、`todo`、サブエージェントがプリロードされます。`todo` の計画は画面に出しません（依頼が複数あるときに、まだやっていないことを覚えておくためのもので、パネルのためではありません）。`ask` はありません。`identity` と `agent_create`、`routine_*` は main レジストリ経由で `tool_search` から見つけさせます。ルーチンは組み込みスキル `routines` が教えます（`packages/core/skills/builtin/routines.ts`）。`agent_create` の役割は `role` か `role_file`（マシン内のファイル）で渡し、UTF-8 でない・空・20,000 文字超は拒否します。
- **`eval` は渡さない**: サーバープロセス内で JavaScript を実行するため、VM の外へ出る経路になります。VM 内でコードを動かすときは `bash` から `node` を使います。サブエージェントにも渡しません（`SubagentRuntime.eval` が `false`）。
- **サブエージェントのスキル**: `skill` ツールが読むカタログはセッションが渡します（`SubagentRuntime.skills`）。stella はマシン内のカタログ（`stella.skills()`）から、サブエージェントが持たないツールを教える組み込みを落としたもの、code mode はワークスペースのディスカバリです。開始時に `<available_skills>` 一覧も context メッセージとして 1 件渡します（`packages/core/tools/task-hub.ts` の `spawn`）。VM の画面ツールはサブエージェントに渡しません。
- **レジストリの分離**: セッションは `main` と `subagent` の 2 つを持ちます（`packages/core/tools/registries.ts`）。MCP・browser-lab・computer・`pdf_read_pages` は両方に入り、`identity` / `agent_create` / `routine_*` は main だけです。
- **パスの境界**: 相対パスと `bash` の基点は `/home/agent/agents/<agent id>`、境界は `/home/agent` です（`packages/core/vm/fs.ts` の `resolveVmPath`）。変えるときは `packages/core/tools/system-prompt.ts` も合わせてください。
- **ファイルの送受信**: ユーザーへは `send_chat` の `paths`（code mode は `chat_attach`）で送ります。上限は `attachFiles()` の 1 箇所で、1 件 4 MiB・1 回 10 件・合計 16 MiB、累計に上限はありません。ユーザーからの添付はマシンの中に書き（`packages/core/vm/uploads.ts`）、メッセージは参照と表示名・サイズだけを持ちます。表示はマシンから読み、消えていれば 404 です。

### 記憶（MEMORY.md）

エージェントは自分の作業フォルダに `MEMORY.md` を持ち、`read` / `write` / `edit` で読み書きします。専用のツールはありません（`identity` とは別物です。あちらは DB の行で、毎ターン context メッセージとして届きます）。

- **用意するのは 2 か所**: 作成時（`LumiscaCore.createStellaAgent` → `StellaMachineService.prepareAgentFolder`）と、会話を開くとき（`getOrCreateStellaSession`）です。作成時にマシンが止まっていれば何もしません——エージェントの作成がコンテナの起動を要求してはいけないためです。
- **`[ -e ]` ガードを外さない**: 開くたびに走るので、無条件に `: >` すると記憶が毎回消えます。コマンドは `packages/core/vm/agent-memory.ts` の 1 箇所だけで、`stella_live_test.ts` が「開き直しても消えない」を固定しています。
- **文面とファイル名は別々に持つ**: 文面は `packages/core/tools/system-prompt.ts`、名前は `AGENT_MEMORY_FILE` です。`vm/agent-memory_test.ts` が両者の一致を検査します。
- **作成は非同期**: フォルダを触るため `createStellaAgent` / `ensureStellaAgent` は `Promise` を返します。`agent_create` ツールも同じ経路を通るので、ツールから作ったエージェントにもファイルができます。

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
- **受け渡し**: 人が必要な手順は `vm_ask_user` で待ちます（`packages/core/vm/handover.ts`）。待機中は画面ペインが操作可能になり、エージェントは止まっています。待ちには 15 分の期限があり（`HANDOVER_TIMEOUT_MS`）、過ぎると `handover_end` でペインを閉じてから「利用者が来なかった」をツールの結果として返します（実行は止めません。待ち続けるとルーチンが順番待ちで止まります）。期限は `handover` イベントとスナップショットの `expiresAt` に載せ、開始は通知の対象です。待ちを解く経路を増やすときは、`cancelAll` とイベントの後始末、タイマーの片付けも確認してください。

### 履歴と自動実行

- **ルーチン**: `daily` / `weekly` / `every` / `once` / `watch` の 5 種類だけで、cron は扱いません。`once` は `YYYY-MM-DD HH:MM` のローカル日時を 1 つ持ち、次が無いので「進める」代わりに実行前に枠を空けて無効にし、走り終えたら行を削除します（走らなかった待機・見送りは理由付きで残ります。時刻が過ぎたまま起動した場合は遅れて実行）。次回時刻は保存値ではなく `packages/core/shared/routine.ts` の `nextRunAt` で計算し、実行前に進めます。
- **確認と実行は別**: `watch` の確認は推論を呼ばない別の事実で、`watch_checked_at` / `watch_error` に書きます（`last_run_at` / `last_status` は実行だけ）。マシンが動いていない確認は 15 分後に送り直し、ルーチンは止めません。観測値は監視対象の変更と有効化のやり直しで捨てます（`repo.ts` の `update`）。
- **待機は 1 本・1 時間**: 会話が空くまで待つのは設計どおりですが、積み上げません（`scheduler.ts` の `queued`）。上限を超えたら実行せずに `skipped` として理由を残します。`RoutineView.queued` は画面の「待機中」です。
- **ルーチンのプロンプトは描かない**: 実行は利用者のプロンプトとして届きますが、本文はルーチンの指示（作成時にエージェントが書いた定型の依頼）なので、会話には出しません（stella は `stella-state.ts` の `transcriptEntries`、code mode は `MessageRow` が落とします）。`StellaEntry.routine` の名前は識別・カーソル・一覧の 2 行目のために射影・圧縮の記録まで通し続けてください（stella の会話には描かないので、一覧の 2 行目だけがルーチン名を出します）。
- **放置された会話の圧縮**: 最後のメッセージから 30 分たったとき、モデルの視界が 50k トークン以上なら畳みます（`SessionAgentOptions.idleCompaction`、定数は `packages/core/agent/factory.ts` の `STELLA_IDLE_COMPACTION`）。視界はすべて畳み、尻尾は残しません（idle 中に答えているリクエストは無いためです）。要約中に会話が動いたら挿入せずに捨てます（`ContextCompactor.compactNow` の `canCommit`）。畳んだ区間のペイロードは落としますが（`packages/core/session/prune.ts`）、行は消しません。
- **履歴は遅延読み込み**: メモリに載せるのはモデルの視界（最新チェックポイント以降）だけです（`MessageRepo.listModelView`）。画面の遡りは `packages/core/session/transcript-pager.ts` がストアから引きます。**ページが数える行（`CONVERSATION_ROWS_SQL`）は、射影（`stellaEntryOf`）がエントリにする行と同じ集合でなければなりません**。片方だけ変えると、画面に出ていた発言が再読み込みで消えます。
- **空いた領域は次の起動で返す**: `close()` がマーカーを書き（`packages/core/db/vacuum.ts` の `vacuumMarkerPath`）、次の起動時にファイルを作り直します（`vacuumOnStartup`、`packages/server/mod.ts`）。`node:sqlite` は `VACUUM` を使えないため、全行コピーと rename です。
- **`history_search`**: 検索するのは会話の射影（画面に出るもの）だけで、結果はローカル日時付き、`from` / `to` で期間を切れます。ツール名・引数・結果は出ません。

### 名前・アイコン・モデル

- **1 つのダイアログで変える**（`packages/web/src/components/stella/AgentEditDialog.tsx`）。`PATCH /api/stella/agents/:id` に `{ name?, icon?, model? }` を送り、`icon` 省略は変更なし、`null` は頭文字、`{data, mimeType}` は差し替え、`model` 省略は変更なし、`null` は既定のモデルです。名前を先に検証し（空名・長すぎる名前は 400、重複名は 409）、モデルはカタログにあるかを確かめてから書き込みます。弾かれたときに画像も名前も書かれません。
- **並びは動かさない**: 改名も差し替えも `updated_at` を触りません。「最後に話した順」のままです。
- **会話の名前はエージェント名**: stella の会話では最初のメッセージからのタイトル生成を行いません（`SessionAgentOptions.titleGeneration`、`factory.ts`）。会話のセッション名は作成時のエージェント名のままで、通知もエージェントの行から名前を読みます。古い会話は開くときに名前をエージェント名へ戻します（`getOrCreateStellaSession`）。
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
- **サブエージェントも同じカタログを読む**: サブエージェントの `skill` ツールはセッションが渡すカタログ（`SubagentRuntime.skills`）を使います。stella ではエージェント自身とマシン共通のスキルがそのまま読め、開始時の一覧にも出ます。main 専用ツール（`identity` / `agent_create` / `routine_*` / MCP 管理）と画面操作を教える組み込みは落とします（`tool-pieces.ts` の `subagentSkills`）。ディレクトリを渡すのは factory の runtime resolver までで、task-hub はもう探索しません。
- **ガイドの広告条件**: ファイルツールを持つセッションだけです（`BuiltinContext.skillAuthoring`）。stella では共通フォルダのパスをマシン側のものにして渡します。
- **テストの隔離**: `LumiscaCore.forTesting` は `appSkillDirs: []` を渡します。配線するときは `globalSkillDirs` と同じく core → pool → toolsets（と factory の runtime resolver）へ通してください。

## 12. PWA（インストール）

https（`tailscale serve` など）で開いた端末から、ページを PWA としてインストールできます。理由は `ARCHITECTURE.md` の「PWA としてのインストール」にあります。

- **manifest はリクエストごとに生成**します（`packages/server/manifest.ts`）。`theme_color` はそのページの第一描画のテーマ色で、`@lumisca/core/shared` の `THEME_COLORS` と `tokens.css` の `--bg` が一致することを `styles_test.ts` が検査します。`start_url` に token を入れないでください。
- **token ガードの対象外は `/manifest.webmanifest`・`/pwa/*`・`/sw.js`**（`security.ts` の `unguardedPath`）。ブラウザのインストール処理が Cookie 無しで取りに来るためです。秘密は載せないでください。
- **アイコンは `packages/web/public/pwa/` の PNG を `assets.json` に base64 で埋め込みます**（`PWA_ICON_FILES`）。宣言する `sizes` は実ファイルと一致させてください（`app_assets_test.ts` が照合）。`icon-maskable-512.png` は円形マスクで切られないよう、内容を 70% に縮めています。
- **Service Worker は https のページでのみ登録**します（`packages/web/src/pwa.ts`）。デスクトップの `http://127.0.0.1` は secure context なので、スキームの判定がそのまま除外になります。キャッシュは `/assets/*.js`（`initial-data.js` を除く）、`/pwa/*`、`/favicon.png`、manifest だけで、network-first です。ページ・`/api`・`/ws` には触りません。
- **`public/sw.js` のキャッシュ方針を変えたら `CACHE_NAME` を上げてください**。`/sw.js` は `max-age=0, must-revalidate` で配ります。
- **クライアントの版ずれは `buildId` で検出**します。`Assets.buildId()`（`app.js` の ETag）を `GET /api/build` と `initial-data.js` の両方に載せ、`hooks/useBuildWatch.ts` が可視の間 60 秒ごと＋復帰時に比べ、違えば `UpdateBanner` が再読み込みを促します。インストールした PWA にはアドレスバーも再読み込みもなく、開いたときのバンドルを保ち続けるためです（サーバー単体アップデートより前のクライアントは、ブラウザで開いても更新の操作を出せませんでした）。片方だけに載せると検出できないので、`app_assets_test.ts` が両者の一致を検査します。自動で読み直さないのは実行中のセッションを切らないためで、このページから再起動したときだけ自動になります。**`/api/health` には載せません**。生存確認は連合の疎通確認やデスクトップの起動確認が 3 秒予算で叩くもので、`buildId` の初回算出は esbuild を走らせて数百ミリ秒から数秒かかるためです（これを健康確認に載せていたため、負荷の高い CI ランナーで生きているピアが落ちていると判定されました）。
- **更新状態を取得できなかった理由は分類して出します**（`hooks/useUpdateStatus.ts` の `classifyUpdateFailure`）。404 は「このサーバーには更新機能がない」、401/403 は認証切れ、通信失敗は到達不可で、それぞれ別の文面です。一つの「この環境では利用できません」に潰すと、更新できるサーバーでもデスクトップアプリへ誘導してしまいます。
- **standalone の余白**: viewport は `viewport-fit=cover`、余白は `env(safe-area-inset-*)` で戻します（`layout.css` の `.app`、全画面 `.modal`、`.mp-popover`）。`packages/server/render.ts` と `packages/web/index.html` の viewport は揃えたままにしてください。
- **確認**: `app_assets_test.ts` と `app_security_test.ts` が通ること。実機は Chrome の DevTools → Application → Manifest で、警告が出ないことを見ます。

### 通知（Web Push）

インストールした PWA に、実行完了・質問・画面の受け渡し・エラーを OS 通知で届けます（`packages/server/push.ts`、`packages/core/notify/`）。

- **タイトルは名前、本文は中身**: 通知の title はエージェント名（code mode はセッション名）、body は何が起きたかです（`push.ts` の `notificationName` と `buildPushNotification`）。実行完了の body は**その run が言ったことの冒頭**（120 文字に畳んで切る）で、言うことが無かった run（`NO_RESPONSE`、カードやファイルだけ）だけ「処理が完了しました」に落とします。返信は `agent_end` が運びます（`packages/core/agent/run-reply.ts`。会話に出るものと同じ規則 `stellaEntryOf` で拾うので、ツール前のナレーションは入りません）。DB から読み直さないのは、何も言わなかった run が前の run の返信を繰り返すためです。デスクトップ通知（`packages/web/src/notify.ts`）は名前を本文に置く従来の文面のままで、返信の冒頭だけが両方に入ります。
- **stella はエージェント名で通知する**: 会話のセッション名ではなく `stella_agents.name` を読みます。会話の名前はエージェントのもので、stella では最初のメッセージからのタイトル生成を行いません（`SessionAgentOptions.titleGeneration`。古い会話は開くときに名前を戻します）。ヘッダーと通知が同じ名前を出すためです。
- **run の無い `agent_end` を出さない**: セッションを閉じると `agent.abort()` が走りますが、`agent_end` は走っていた run があるときだけ出します（`ai/agent.ts` の `abort`）。閉じただけで「完了しました」を届けないためです。閉じたセッションはどのイベントも出しません（`SessionAgent.emit`）。ここを外すと、×でタブを閉じるたびに通知が届きます。
- **可視判定は Service Worker が持つ**（`public/sw.js` の `push`）。`clients.matchAll({ type: "window", includeUncontrolled: true })` に `visibilityState === "visible"` の窓があれば何も出しません。サーバー側に presence を持たせると、複数端末のフォーカスを当てる必要が出て必ずずれます。
- **暗号は WebCrypto だけで書く**（`packages/core/notify/web-push.ts`）。VAPID の ES256、RFC 8291 の AES128GCM、HKDF の 2 段です。依存は増やさないでください。本文は必ず `0x02` 区切りで終わらせます（無いとブラウザがレコードを終端できず、黙って捨てます）。往復は `packages/core/notify/web-push_test.ts` がブラウザ側の手順で復号して確かめます。
- **鍵と購読は settings.jsonc**（`push_vapid` / `push_subscriptions`）。DB マイグレーションはありません。両方とも `settings/guard.ts` の `protectedKeyReason` で汎用設定 API から遮断しています。
- **鍵は初回の `GET /api/notify/key` で作る**。通知を使わない利用者に秘密鍵を書かないためです。保存済みの鍵対が公開側と食い違ったら**作り直さず失敗**させてください（作り直すと既存の購読が全部無効になり、ブラウザは通知を黙って捨てます）。
- **404 / 410 の購読は削除**、それ以外の失敗（429、通信断）は残します（`push.ts` の `forgetPushSubscriptions`）。
- **このサーバーのイベントだけ**送ります。中継しているピアのイベントは対象外で、購読はこのオリジンの端末のものです。
- **`pushsubscriptionchange` は当てにしない**。Chromium も発火しないことがあり、Safari は実装していません。ページを開いたときに購読を 1 回 POST し直す経路（`packages/web/src/hooks/usePush.ts`）を消さないでください。
- **`public/sw.js` は素の script** なので、ページの `push.ts` を import できません。base64url の復号だけが 2 か所にあります。
- **設定行は `pushSupported()` のときだけ**出します（`https` かつデスクトップシェル外かつ Push API あり）。デスクトップの `http://127.0.0.1` と `deno task dev` は対象外で、そこは従来どおり Tauri の通知が担当します。iOS はホーム画面の PWA でだけ動きます。

## 13. プロバイダーの OAuth ログイン（ChatGPT）

設定 → プロバイダー → ChatGPT から、ChatGPT のサブスクリプションで OpenAI のモデル（Codex 系）を使えます。実装は `packages/core/models/chatgpt/` です。

- **方式はクライアントが決める**: `POST /api/providers/:id/login` の body に `{"method":"browser"|"device_code"}` が必須です。サーバーに既定はありません。ブラウザ方式は Origin と Host が loopback のときだけ受け付けます（コールバックはサーバー機の `127.0.0.1:1455/1457` にしか来ないためです）。
- **モデル一覧はログイン時に取る**: `GET /backend-api/codex/models` を認証付きで取得し、`chatgpt_models` に保存します。取得に失敗するとログインごと失敗し、credential は保存されません。静的な一覧への fallback はありません。
- **期限切れの更新**: `resolveCredential` が期限の 60 秒前に更新し、同時要求は 1 回の更新を共有します。更新トークンはローテーションされるため、2 回交換すると片方が無効になります。
- **要求の形**: Codex バックエンドは `instructions` 必須・`store:false` です。`ai/stream.ts` の `chatgptProviderOptions` がシステムプロンプトを `instructions` に移し、`input` から外します。ここを外すと全リクエストが 400 になります。
- **設定のキー**: `AuthInteraction.method`（クライアントの選択）、`OAuthAuth.methods`（プロバイダーが受理する方式）、`ProviderInfo.loginMethods`（UI が読む一覧）です。`methods` を増やすときは 3 つとも合わせてください。
- **確認**: `deno test packages/core/models/chatgpt packages/server/login_openai_codex_test.ts packages/server/routes/providers_test.ts`。実機の確認には ChatGPT アカウントが必要で、デバイスコード方式は ChatGPT のセキュリティ設定で有効化しておきます。
