# Lumisca Agent

Claude Code / Codex / opencode のようなコーディングエージェント。AI基板に
[pi](https://github.com/earendil-works/pi)(`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`)を使用し、
CLI・Web・デスクトップの3つのフロントエンドから同一の機能を利用できます。

## 特徴

- **サーバーサイドレンダリング(SSR)**: React を Hono サーバー上で直接レンダリング。
  Vite / npm ビルドは不要で `deno task server` だけで完結します(クライアントJSは
  起動時に esbuild が自動バンドル)
- **Fluent デザイン**: フラット・シンプルな UI。ダーク/ライトモードをサイドバー下部の
  アイコンで切り替え可能(設定はデータベースに保存され、SSR で引き継がれます)。アイコンは tabler icons
- **タブ式セッション管理**: ブラウザのように上部タブで複数セッションを同時に切り替え
  (Web / デスクトップ)。各セッションは独立して並行稼働します
- **フェデレーション**: ⚙ → 接続先サーバー で登録した**別のマシンのサーバー**
  (LAN / Tailscale)のワークスペースを同じ一覧に表示し、そのままセッションを開始・
  作業できます。エージェントはワークスペースを所有するマシンで実行され、イベントは
  リアルタイムに同期されます(接続切替の操作は不要)
- **ワークスペース**: 単一フォルダだけでなく、複数フォルダをまとめた単位でも作業可能。
  ファイル操作(read / write / edit / list_dir)はワークスペース内に制限されます
  (パス正規化 + シンボリックリンク解決によるサンドボックス)
- **セッション永続化**: セッション履歴とメタデータを SQLite に保存。再起動後も再開できます
- **全プロバイダー対応**: Anthropic, OpenAI, DeepSeek, OpenRouter, Google など
  20+ のプロバイダーを API キー方式で利用可能(モデル選択UI付き)
- **ツール**: read_file / write_file / edit / list_dir / grep / glob / bash(cmd.exe または /bin/sh)
- **MCP 対応**: 外部ツールサーバー(MCP)を追加可能。**設定モーダル(⚙ → MCP サーバー)
  でアプリ単位(全ワークスペース共通)に GUI 管理**でき、ツールは
  `mcp__<サーバー>__<ツール>` として利用可能(公式 `@modelcontextprotocol/sdk` 使用)。
  各ワークスペースの `.mcp.json` も自動的にマージされます(同名はワークスペース優先)
- **プロジェクトメモリ (AGENTS.md)**: ワークスペースのリポジトリにある
  `AGENTS.md` / `AGENTS.override.md` を自動でシステムプロンプトに取り込みます
  (`.git` を手がかりにリポジトリルートまで遡り、合計32KBまで。編集は次回オープン時に反映)

## 構成

```
packages/
├── core/      AI基板(共通)。全フロントエンドはこれだけに依存
│   ├── agent/       pi-agent-core ラッパー + セッションプール
│   ├── tools/       ワークスペース境界付きコーディングツール
│   ├── mcp/         MCP クライアント(公式 SDK ラッパー + .mcp.json 設定)
│   ├── memory/      AGENTS.md プロジェクトメモリ
│   ├── workspace/   複数フォルダ管理・サンドボックス
│   ├── session/     セッション管理 + SQLite 永続化
│   ├── models/      pi-ai モデル管理
│   ├── settings/    APIキー等の設定(DBバックの CredentialStore)
│   └── db/          SQLite(node:sqlite)
├── server/    Hono HTTP + WebSocket(127.0.0.1 ローカル専用)+ React SSR + esbuild バンドル
├── web/       React フロントエンドのソース(SSR/ハイドレーション共用)
├── cli/       シングルセッションの対話 CLI
└── desktop/   Tauri 2 デスクトップシェル
```

## 必要環境

- [Deno](https://deno.com) 2.8+
- Rust(デスクトップアプリのビルド時のみ)

## 使い方

### Web(推奨)

```bash
deno task server        # 本番相当(キャッシュ有効)
deno task server:dev    # 開発用: ライブリロード付き
# → http://127.0.0.1:8000 をブラウザで開く
```

React の初期HTMLはサーバーでレンダリングされます。本番相当(`server`)では
ハイドレーション用のクライアントJSを初回アクセス時に esbuild で自動生成し
(`.lumisca-cache/` にキャッシュ)、開発用(`server:dev`)では **Vite**(dev 専用)
がソースを直接配信します。

`server:dev` では `packages/web/src` の変更に対して **React Fast Refresh**
(状態を保持したままの部分更新)が働きます。HMR は Vite 自身の WebSocket
(ポート 24678)で配信されるため、入力中のテキストや開いているタブは保持された
まま UI だけが更新されます。SSR も同じ Vite のモジュールランナーで行われるため、
再起動なしでサーバー側レンダリングにも変更が即時反映されます。

初回の `server:dev` は Vite と依存パッケージのダウンロードのため起動に数十秒
かかることがあります。Vite が起動できない環境では、従来どおり esbuild による
再バンドル + フルページリロードに自動でフォールバックします。

`LUMISCA_DB` で DB パス、`LUMISCA_PORT` でポートを変更できます。

`LUMISCA_TOKEN` を設定すると、API・WebSocket・SSR ページにトークン認証がかかります
(ヘッダー `X-Lumisca-Token`、WS の `?token=`、ページの `?token=`)。デスクトップアプリは
起動のたびにトークンを生成して渡すため、別のローカルプロセスからエージェントを
操作できません。未設定なら従来どおり認証なしで動きます(リモートホスティング時は
トークン必須。→ [リモートサーバーでのホスティング](#リモートサーバーでのホスティング))

### CLI

```bash
deno task cli            # 対話モード(ワークスペース/モデル選択から開始)
deno task cli -- --resume   # 過去のセッションから再開
deno task cli -- --help     # 全オプション
```

コマンド: `/new` `/resume` `/model` `/thinking` `/workspace` `/keys` `/sessions` `/name` `/exit`

### デスクトップ(Tauri)

```bash
npm install --prefix packages/desktop
npm run tauri --prefix packages/desktop -- dev        # 開発
npm run tauri --prefix packages/desktop -- build      # インストーラ
```

アプリ起動時に Deno サーバーを自動起動し、WebView で UI を開きます。
開発時は `PATH` に deno が必要です。

`tauri build` は自動的に:
1. フロントエンドを esbuild でバンドルし `assets.json` に埋め込み
2. サーバーを `deno compile` で単一バイナリ化
3. その両方をインストーラに同梱

パッケージ版はリポジトリレイアウトや Deno 本体に依存せず動作します。

## リモートサーバーでのホスティング

エージェントの処理・ファイル操作・DB・APIキーを**別 PC の Lumisca サーバー**で
動かし、デスクトップアプリ(またはブラウザ)から接続して操作できます。
ローカルネットワークや **Tailscale** のような VPN を前提としています。

```
[クライアント PC]                 [サーバー PC]
┌──────────────┐   LAN / VPN   ┌──────────────────┐
│ デスクトップ  │ ────────────▶ │ Lumisca サーバー │
│ (接続管理UI)  │  http + token │  エージェント処理 │
└──────────────┘               │  ファイル操作     │
                               │  SQLite / APIキー │
                               └──────────────────┘
```

### サーバー PC のセットアップ

1. サーバーバイナリを用意します。デスクトップのパッケージビルドが生成する
   `packages/desktop/src-tauri/resources/server/` の
   `lumisca-server(.exe)` と `assets.json` をサーバー PC にコピーするか、
   `deno run --allow-net --allow-read --allow-write --allow-env --allow-run --allow-sys packages/server/mod.ts`
   で実行します
2. 環境変数を設定して起動します:

   | 変数 | 説明 | 例 |
   |------|------|-----|
   | `LUMISCA_HOST` | バインド先アドレス(既定 `127.0.0.1`) | `0.0.0.0` または Tailscale IP |
   | `LUMISCA_ALLOWED_HOSTS` | Host ガードで許可するホスト名(カンマ区切り・ポート不要) | `myserver.tailnet.ts.net,100.64.0.5` |
   | `LUMISCA_TOKEN` | 認証トークン。**非ループバックバインド時は必須**(未設定なら起動拒否) | 十分に長いランダム文字列 |
   | `LUMISCA_PORT` | ポート(既定 8000) | `8000` |
   | `LUMISCA_DB` | DB パス(既定 `./lumisca.db`) | `C:\lumisca\lumisca.db` |

   例(Windows):
   ```bat
   set LUMISCA_HOST=0.0.0.0
   set LUMISCA_ALLOWED_HOSTS=100.64.0.5
   set LUMISCA_TOKEN=xxxxxxxxxxxxxxxx
   lumisca-server.exe
   ```

3. 常駐化するには Windows なら NSSM や
   `sc create Lumisca binPath= "C:\lumisca\lumisca-server.exe" start= auto`、
   Linux なら systemd unit を使います(例):

   ```ini
   # /etc/systemd/system/lumisca.service
   [Unit]
   Description=Lumisca Agent server
   After=network-online.target

   [Service]
   ExecStart=/opt/lumisca/lumisca-server
   Environment=LUMISCA_HOST=0.0.0.0
   Environment=LUMISCA_ALLOWED_HOSTS=myserver.tailnet.ts.net
   Environment=LUMISCA_TOKEN=xxxxxxxxxxxxxxxx
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

4. **Tailscale 推奨**: Tailscale 経由ならトラフィックは WireGuard で暗号化されます。
   直接 LAN に公開する場合は平文 HTTP になるため、信頼できるネットワークに限定し、
   強力なトークンを使用してください。HTTPS が必要なら Caddy 等のリバースプロキシを
   前に置きます(将来のバージョンでネイティブ TLS 対応を予定)

### クライアント側 (デスクトップアプリ / ブラウザ共通)

1. サイドバーの ⚙ から**設定モーダル**を開き、**接続先サーバー**を選びます
2. 「サーバーを追加」で 名前 / URL(`http://100.64.0.5:8000` など)/ トークン
   (`LUMISCA_TOKEN` と同じ値)を入力し「テスト」で接続確認 →「保存」
3. **フェデレーション**: 登録したサーバーの**ワークスペースがそのまま一覧に表示**
   されます(マシン名バッジ付き)。別マシンのワークスペースを選んでセッションを
   開始すると、**そのマシンでエージェントが実行**され、結果がリアルタイムで
   届きます — 明示的な「接続」操作は不要です
4. ワークスペースの作成・編集・削除も**対象サーバーを選んで実行**できます
   (フォルダ選択はそのマシンのファイルシステムを参照)。リモートセッションの
   モデル切替・思考レベル変更も、そのマシンのモデル一覧で動作します
5. 登録リストは**このサーバーのデータベース**に保存され(`/api/connections`)、
   web / デスクトップのどちらからでも同じ一覧を編集できます

デスクトップアプリでは、⚙ → 接続先サーバーの「表示」ボタンで**UI 自体を別
サーバーに切り替える**こともできます(ローカルサーバーへ戻す操作も同様)。
ブラウザでは「表示」はそのサーバーの URL への移動になります。

トークンはページ読み込み後にアドレスバーから除去されます。

### セキュリティ上の注意

- トークンを知っている人は、ページ・API・WebSocket すべてにアクセスでき、
  **サーバー PC 上で bash ツールを実行できる**(エージェントの全権限に等しい)。
  トークンは厳重に管理してください
- `LUMISCA_ALLOWED_HOSTS` に指定したホスト名以外からのアクセスはサーバーが
  拒否します(Host ガード)。DNS リバインディング対策も維持されています
- サーバーの DB(`lumisca.db`)には API キーが平文で保存されます。DB ファイルの
  取り扱いに注意してください
- 複数のクライアントから同時に接続できますが、同一セッションへの同時 prompt は
  サーバー側の単一ストリーム制約により拒否されます
- デスクトップのシェルブリッジ(設定 → 接続先サーバーの「表示」)は
  **接続中のサーバーのトークンを key として要求**するため、WebView 内に読み込まれた
  別のページからシェル操作を実行することはできません。
  トークンなしで運用しているサーバーを表示中はブリッジも無防備になります
  (サーバー自体が認証なしで公開されている状態と同等)
- **フェデレーションの安全要件**: ピアを登録するサーバー (ハブ) はピアの
  トークンを DB に保持します。ハブ⇔ピア間は各ピアの `LUMISCA_ALLOWED_HOSTS` と
  トークンで保護されます。またハブが自分自身をピア登録しても自動的に無視されます
  (イベントループ防止)

## APIキーの設定

サイドバーの ⚙ から**設定モーダル**を開きます:

1. 「+ プロバイダーを追加」→ プロバイダー一覧から選択
2. APIキーを入力して保存 → プロバイダー追加完了(設定済み一覧に表示)
3. プロバイダーの詳細で**モデルのチェックボックス**により有効/無効を設定
   (無効にしたモデルはモデル選択肢に表示されません)

チャット入力欄の下にあるモデル表示をクリックすると、その場でモデルを切り替えられます。
思考モードに対応したモデルでは、モデル表示の右側に**思考強度**(Off/Minimal/Low/Medium/High/Extra High/Max)
の選択肢が表示され、モデルごとに設定できます(対応していない段階は自動的に最寄りの段階へ補正されます)。
新しいセッションはワークスペースを選ぶだけで作成でき、モデルは直近で使用したモデルが
自動設定されます(後から切り替え可能)。
環境変数(`ANTHROPIC_API_KEY` 等)で認証が解決されるプロバイダーも設定済みとして表示されます。

## MCP サーバーの設定

MCP(Model Context Protocol)サーバーを追加すると、その外部ツールを
エージェントから `mcp__<サーバー名>__<ツール名>` として呼び出せます。

設定は**アプリ単位(全ワークスペース共通)**と**ワークスペース単位**の2段階があり、
両方が自動的にマージされます(同名のサーバーはワークスペース単位が優先):

1. **アプリ単位(GUI 推奨)**: 設定モーダル(⚙ → MCP サーバー)→
   「+ サーバーを追加」で名前・種類(stdio / HTTP)・コマンド・引数・環境変数を入力して保存。
   すべてのワークスペースのセッションに適用されます
2. **ワークスペース単位(ファイル)**: ワークスペースルートの `.mcp.json`
   (Claude Code 互換形式)を直接編集

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer x" }
    }
  }
}
```

- 各サーバーは `enabled: false` で削除せずに一時無効化できます
- `env` とコマンド/URL 内の `${VAR}` はプロセスの環境変数で展開されます
- 変更は保存後すぐに、対象の全セッションへ反映されます
  (実行中のセッションがある場合は保存をブロック)
- 外部編集との競合時は上書き確認ダイアログが表示されます
- **注意**: MCP ツールはワークスペースのサンドボックス境界の外にもアクセスできます。
  アプリ単位の設定は DB に、設定ファイルに秘密情報を含める場合は `.gitignore` への
  追加を推奨します

## プロジェクトメモリ (AGENTS.md)

ワークスペース内のリポジトリ(`.git` まで遡って検出)にある `AGENTS.md` を自動で
システムプロンプトに取り込みます。階層ごとの `AGENTS.override.md` は同じ階層の
`AGENTS.md` を置き換えます。合計32KBまで。ファイルを編集すると、セッションを
開き直したときに反映されます。

## データ

- データベース: `./lumisca.db`(既定。`LUMISCA_DB` で変更)
  - テーブル: workspaces / workspace_folders / sessions / messages / settings
- APIキー: 設定DB内(`api_key:<providerId>` キー)に保存(サーバーが動く PC に保存される)

## テスト

```bash
deno task test       # 全テスト
deno task check      # 型チェック
deno task lint       # lint
deno task fmt        # フォーマット(適用)
deno task fmt:check  # フォーマット(確認のみ)
```

core(サンドボックス・永続化・ツール境界)、server(HTTP / WebSocket / SSR / バンドル)の
テストを含みます。CI(GitHub Actions)では fmt / lint / check / test を実行します。

## 設計メモ

- エージェントループは pi の `Agent`(イベント購読ベース)を使用し、
  イベントを WebSocket / CLI へ中継します
- SSR では初期データ(ワークスペース・セッション一覧)を `/assets/initial-data.js`
  として外部化し、クライアントが `hydrateRoot` で引き継ぎます
  (ハイドレーションミスマッチ防止のため `window.__INITIAL_DATA__` を利用。
  インラインスクリプトはページ CSP で禁止しているため外部化しています)
- セッションのメッセージは message_end ごとに SQLite へ追記保存され、
  再オープン時に完全復元されます
- システムプロンプトは生成時に AGENTS.md を取り込みます。ユーザー指定の
  カスタムプロンプト(`system_prompt_custom`)のみ保存され、生成プロンプトは
  開くたびに再生成されるため、AGENTS.md の編集が次回オープン時に反映されます
- MCP は公式 `@modelcontextprotocol/sdk` の Client を使用し、`McpManager` が
  セッションごとにサーバーの起動・ツール発見・呼び出し・終了を管理します
  (stdio は子プロセス、HTTP は streamable HTTP)。アプリ単位の設定は DB
  (settings の `mcp_servers` キー、汎用 settings API からは保護)で、
  ワークスペースの `.mcp.json` とマージして使用します
- ワークスペース境界の検証は `packages/core/workspace/sandbox.ts` に集約されており、
  実在パスは realpath 解決後にルート集合との包含判定を行います
- セキュリティ: ループバック限定 + `LUMISCA_ALLOWED_HOSTS`(リモートホスティング時)
  + オリジン完全比較(CORS / WS)+ 任意の `LUMISCA_TOKEN` 認証
  (非ループバックバインド時は必須。認証付きサーバーでは SSR ページ自体もトークン必須)。
  Markdown レンダラーは画像 URL を https/http + 非ループバックに制限します

