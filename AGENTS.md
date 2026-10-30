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

## 7. stella mode（仮想マシン）

stella mode は、podman コンテナを仮想マシンとして与え、その中だけでエージェントを動かす動作モードです。実装は `packages/core/vm/` にあり、会話は mode ごとに 1 本だけ存在します。

- **必要環境**: Linux と rootless podman。podman が使えない環境では stella mode を選べません（理由を画面に表示します）。Windows / macOS は対象外です。
- **イメージ**: `packages/core/vm/container/Containerfile` から初回起動時にビルドします（数分）。配布物では `scripts/build-server.ts` が `stella-container/` をバイナリの隣へ同梱し、`packages/server/paths.ts` がその場所を解決します。Containerfile を変えたらイメージを作り直してください（画面の「作り直す」）。
- **契約値**: 画面サイズ（1280x800）、DISPLAY、uid/gid、作業ディレクトリは `packages/core/vm/contract.ts` と Containerfile / entry.sh の両方に書かれています。起動時に実コンテナと突き合わせ、ずれていれば起動を失敗させます。
- **隔離の範囲**: ホストのファイルは VM にマウントしません。VM はセキュリティ境界ではなく作業場所の区切りであり、CPU・メモリ・ディスクの上限や外向きネットワークの制限は設けていません。
- **ライフサイクル**: 起動は自動（会話を開く前）。停止はサーバー終了時と画面の「停止」。モードの切り替えだけでは停止しません。
- **eval ツールは渡しません。** サーバープロセス内で JavaScript を実行するため、VM の外に出る経路になります。VM 内でコードを動かすときは `bash` から `node` を使ってください。同じ理由で、このモードのサブエージェントにも `eval` は渡しません（`SubagentRuntime.eval` が `false`）。
- **ツールの集合**: ファイル・シェル・画面・`chat_ui`・`chat_attach`・`history_search`・`skill`・サブエージェントがプリロードされます。`ask` と `todo` はありません（質問に答えるパネルも進捗パネルも、この会話には無いため）。`identity` と `agent_create` は**プリロードせず**、セッションの main レジストリに置いて `tool_search` で見つけさせます（使い方は組み込みスキル `identity` / `agent-create` が教えます）。
- **ツールレジストリの分離**: セッションは `main` と `subagent` の 2 つのレジストリを持ちます（`packages/core/tools/registries.ts`）。MCP・browser-lab・computer・`pdf_read_pages` は両方に入り、`identity` / `agent_create` / `routine_*` は main だけに入ります。stella のサブエージェントは VM の中で code mode と同じツール集合で動きますが、この 3 種は `tool_search` でも見つかりません。
- **作業フォルダとパスの境界**: 相対パスと `bash` は `/home/agent/agents/<agent id>` を基点にしますが、境界はマシンのホーム `/home/agent` です。ほかの相手のフォルダにも絶対パスで触れます（`packages/core/vm/fs.ts` の `resolveVmPath`）。境界を変えるときはシステムプロンプト（`packages/core/tools/system-prompt.ts`）の記述も合わせてください。
- **画面の受け渡し**: 人が必要な手順は `vm_ask_user` で待ちます（`packages/core/vm/handover.ts`）。待機中は画面ペインが操作可能になり、エージェントは止まっています。待ちを解く経路（完了・停止・セッション終了）を増やすときは `cancelAll` とイベントの後始末も合わせて確認してください。
- **ルーチン**: スケジュールは `daily` / `weekly` / `every` の 3 種類だけで、cron は扱いません。次回時刻は「保存済みの値」ではなく `packages/core/shared/routine.ts` の `nextRunAt` で計算し、実行前に進めます（後回しにすると、長い実行が重複して走ります）。
- **identity（相手の自己記述）**: 相手は `role`（ユーザーが作成時に書く）とは別に、`identity` ツールで自分の役割と知識を書けます。保存先は `stella_agents.identity`、モデルへは context メッセージとして届きます（`packages/core/stella/identity.ts`）。**システムプロンプトには書きません** — 書き換えのたびに先頭が変わるとキャッシュ済みプレフィックスを捨てるためです。反映は次のターンからで、圧縮は待ちません。ツールはプリロードせず main レジストリ経由です。
- **ユーザーへのファイル送信**: 画像やファイルは `chat_attach` で送ります（`packages/core/tools/attach.ts`）。画像はインライン、それ以外はダウンロードとして会話にカードで出ます。code mode と stella の両方で使えます。保存先はデータベース隣の `.lumisca-attachments`（`packages/core/session/attachments.ts`）、配信は `/api/sessions/:id/attachment/:name` です。1 件 4 MiB・1 回 10 件・合計 16 MiB まで。`visual` ツール（`visual:` 参照で本文中に画像を置く）は **code mode のみ**に残しています（stella では外し、保存済みの応答を表示し続けるためにストアとルートだけ残しています）。
- **スキル一覧の出どころ**: `<available_skills>` を公開する provider（`packages/core/skills/catalog.ts`）は、セッションごとの解決関数を受け取ります。stella ではマシン内の `.agents/skills` とホストのグローバル／組み込みを返すので、一覧と `skill` ツールが読める集合が一致します。組み込みスキルは `BuiltinContext.stella` で `identity` / `agent-create` を加えます（`packages/core/skills/builtin/mod.ts`）。

## 8. 開発用スクリプト

手元での確認に使うスクリプトは `deno task` から実行します。

- `deno task demo`: faux プロバイダで動くデモサーバーを起動します（API キーやネットワークなしで UI とツール呼び出しを確認できます）。
- `deno task seed:history <sessionId> [nPairs]`: 指定セッションに長い履歴を流し込みます（多数メッセージでのレイアウト確認用）。
- `deno task probe:token`: 認証トークンのガード（`/api/health` がトークン無しで 401、付与で 200）を確認します。
- `deno task probe:computer`: このマシンで computer use が使えるかを確認し、スクリーンショットを 1 枚保存します（Linux では初回にデスクトップが許可ダイアログを出します）。`--click x,y` などを付けると 1 回だけ操作も行います。
- `deno task probe:stella`: stella mode がこのマシンで使えるかを確認します。`--start` を付けるとイメージのビルド・起動・画面撮影・停止まで通します（初回は数分かかります）。

いずれも手動操作用で、CI からは実行しません。引数の詳細は各スクリプトの先頭コメントにあります。
