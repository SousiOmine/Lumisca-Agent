# Lumisca Agent

Claude Code / Codex / opencode のようなコーディングエージェント。AI基板に
[pi](https://github.com/earendil-works/pi)(`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`)を使用し、
CLI・Web・デスクトップの3つのフロントエンドから同一の機能を利用できます。

## 特徴

- **ビルドステップ不要**: クライアントJSは初回アクセス時に esbuild が自動バンドル。
  `deno task server` だけで完結します(UI はクライアントサイドレンダリング)
- **Fluent デザイン**: フラット・シンプルな UI。ダーク/ライトモードをサイドバー下部の
  アイコンで切り替え可能(設定はデータベースに保存され、初回描画時に反映されます)。アイコンは tabler icons
- **タブ式セッション管理**: ブラウザのように上部タブで複数セッションを同時に切り替え
  (Web / デスクトップ)。各セッションは独立して並行稼働します
- **フェデレーション**: ⚙ → 接続先サーバー で登録した**別のマシンのサーバー**
  (LAN / Tailscale)のワークスペースを同じ一覧に表示し、そのままセッションを開始・
  作業できます。エージェントはワークスペースを所有するマシンで実行され、イベントは
  リアルタイムに同期されます(接続切替の操作は不要)
- **ワークスペース**: 単一フォルダだけでなく、複数フォルダをまとめた単位でも作業可能。
  パスは**絶対パス**または**ワークスペースフォルダ名で始まる相対パス**(例: `Aaa/README.md`)
  のどちらかで指定し、フォルダ名なしの相対パスは拒否されます。ファイル操作は
  ワークスペース内に制限されます(パス正規化 + シンボリックリンク解決によるサンドボックス)
- **セッション永続化**: セッション履歴とメタデータを SQLite に保存。再起動後も再開できます
- **全プロバイダー対応**: Anthropic, OpenAI, DeepSeek, OpenRouter, Google など
  20+ のプロバイダーを API キー方式で利用可能(モデル選択UI付き)
- **ツール**: read / write / edit / list_dir / grep / glob / eval / bash(cmd.exe または /bin/sh)。
  grep / glob は `path` 省略時に**全ワークスペースフォルダ**を探索。bash は
  **`cwd` が必須引数**で、ワークスペースフォルダ名または絶対パスで指定します。
  エージェントは `ask` ツールで**ユーザーに選択式の質問**を投げられます(入力欄の上に
  質問カードが表示され、回答がツール結果として返ります。複数質問・複数選択に対応)
- **進捗管理 (todo ツール)**: エージェントは `todo` ツールで作業を**フェーズ単位の
  タスクリスト**として計画・更新できます(各タスクは pending / in_progress /
  completed / abandoned / blocked の5状態)。現在のタスクを完了すると次の pending
  タスクが自動的に in_progress になり、**画面右上の角丸パネル**に進捗がリアルタイム表示されます
- **MCP 対応**: 外部ツールサーバー(MCP)を追加可能。**設定モーダル(⚙ → MCP サーバー)
  でアプリ単位(全ワークスペース共通)に GUI 管理**でき、ツールは
  `mcp__<サーバー>__<ツール>` として利用可能(公式 `@modelcontextprotocol/sdk` 使用)。
  各ワークスペースの `.mcp.json` も自動的にマージされます(同名はワークスペース優先)
- **プロジェクトメモリ (AGENTS.md)**: ワークスペースのリポジトリにある
  `AGENTS.md` / `AGENTS.override.md` を自動でシステムプロンプトに取り込みます
  (`.git` を手がかりにリポジトリルートまで遡り、合計32KBまで)。取り込みは
  **セッション作成時**に行われるため、編集は新規セッションのみに反映されます
- **スキル (SKILL.md)**: `.agents/skills/<名前>/SKILL.md` に置いた再利用可能な
  指示を検出し、システムプロンプトの `<available_skills>` に一覧表示します。
  エージェントは `skill` ツールで内容をオンデマンドに読み込みます
  (→ [スキル (SKILL.md)](#スキル-skillmd))
- **パーソナライズ**: ⚙ → パーソナライズ で、システムプロンプトの最後に付加する
  カスタム指示を設定できます(設定ファイルと同じ場所の `AGENTS.md` に保存。新規セッションのみ反映)

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
│   ├── settings/    設定(`~/.config/lumisca-agent/settings.jsonc` バック)
│   └── db/          SQLite(node:sqlite)
├── server/    Hono HTTP + WebSocket(127.0.0.1 ローカル専用)+ 静的シェル + esbuild バンドル
├── web/       React フロントエンドのソース(クライアントレンダリング)
├── cli/       シングルセッションの対話 CLI
└── desktop/   Tauri 2 デスクトップシェル
```

## 必要環境

- [Deno](https://deno.com) 2.8+
- Rust(デスクトップアプリのビルド時のみ)

## 使い方

### Web(推奨)

```bash
deno task dev           # 開発用: Vite HMR + API サーバー
# → http://127.0.0.1:5173 をブラウザで開く

deno task server        # 本番相当(キャッシュ有効)
# → http://127.0.0.1:8000 をブラウザで開く
```

React アプリはクライアントサイドでレンダリングされます(初期HTMLはテーマ適用済みの
静的シェル)。クライアントJSは初回アクセス時に esbuild で自動生成され
(`.lumisca-cache/` にキャッシュ)、`server` から配信されます。

`dev` は Vite の開発サーバーと Hono の API サーバーを同時に起動します。
React コンポーネントと CSS の変更は Vite HMR によりブラウザへ即時反映されます。
開発画面からの `/api`、`/ws`、初期データのリクエストは Hono へプロキシされます。

`LUMISCA_DB` で DB パス、`LUMISCA_PORT` でポートを変更できます。設定(テーマ・
APIキー・接続先など)は `~/.config/lumisca-agent/settings.jsonc` に保存されます
(`$XDG_CONFIG_HOME` が設定されていれば `$XDG_CONFIG_HOME/lumisca-agent/settings.jsonc`)。

`LUMISCA_TOKEN` を設定すると、API・WebSocket・ページにトークン認証がかかります
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

## 配布 (GitHub Releases)

`vX.Y.Z` 形式のタグを push すると、GitHub Actions が Windows インストーラを
ビルドし、**ドラフトリリース**として作成します(リリースはタグと
`tauri.conf.json` / `Cargo.toml` のバージョンが一致している場合のみ成功します):

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub の Releases ページでドラフトを確認し「Publish release」で公開します。
新規ユーザーはリリースのアセットから `Lumisca_<ver>_x64-setup.exe` を
ダウンロードしてインストールします。

リリースには自動更新の準備として署名(`.sig`)と `latest.json` も含まれます。
署名に使う秘密鍵は GitHub リポジトリの Actions シークレット
(`TAURI_SIGNING_PRIVATE_KEY` = 秘密鍵の内容 / 
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = パスフレーズ)に設定済み
である必要があります(未設定だとリリースビルドが失敗します)。

### 署名キー

署名キーは `tauri signer generate` で開発者のローカル環境に生成し、
**リポジトリ外で厳重に管理してください**(保存場所・内容を README や
リポジトリに記載しないこと。パスフレーズマネージャーでの管理を推奨)。
秘密鍵とパスフレーズを紛失すると既存ユーザーへの更新配信が不可能になります。

`createUpdaterArtifacts: true` により、ローカルで `tauri build` する場合も
署名キーが必要です。鍵ファイルを環境変数で読み込んでから実行してください:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content "<鍵ファイルのパス>" -Raw).TrimEnd()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<パスフレーズ>"
npm run tauri --prefix packages/desktop -- build
```

### 自動更新 (将来対応)

現在のリリースパイプラインは自動更新に対応したアーティファクト
(`.sig` / `latest.json`)を生成済みのため、`tauri-plugin-updater` の導入
(Cargo.toml + lib.rs へのプラグイン登録、`tauri.conf.json` の
`plugins.updater` に公開鍵と `https://github.com/SousiOmine/Lumisca-Agent/releases/latest/download/latest.json`
を設定)だけで既存ユーザーへのアプリ内更新が動く状態です。

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
   | `XDG_CONFIG_HOME` | 設定ファイルの親ディレクトリ(既定 `~/.config`) | `C:\Users\me\.config` |

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
`AGENTS.md` を置き換えます。合計32KBまで。

プロジェクトメモリとパーソナライズ(下記)は**セッション作成時**にシステムプロンプトへ
取り込まれ、その時点の内容がセッションごとに固定されます。ファイルを編集しても
**既存のセッションには反映されず**、編集後に新規作成したセッションからのみ反映されます。

## スキル (SKILL.md)

再利用可能な指示を **スキル** として配置すると、エージェントがタスクに応じて
オンデマンドで読み込めるようになります。配置場所は次の2つです:

- **ワークスペース**: ワークスペースフォルダの `.agents/skills/<名前>/SKILL.md`
  (リポジトリルートまで遡って各階層を検出。モノレポのパッケージ単位にも配置できます)
- **グローバル**: `~/.agents/skills/<名前>/SKILL.md`(全ワークスペースで利用可能)

SKILL.md は YAML frontmatter で始める必要があります:

```markdown
---
name: example-skill
description: 特定の作業手順(例: リリースチェックリストの実行)を進めるためのスキル
---

(スキルの内容。手順・規約・注意点などを Markdown で記述)
```

- `name`: 小文字英数字と単一ハイフンのみ(`^[a-z0-9]+(-[a-z0-9]+)*$`、64文字以内)。
  **ディレクトリ名と一致**している必要があります
- `description`: エージェントがスキルを選択できるよう具体的に記述します(1024文字以内)
- 上記の条件を満たさない SKILL.md は無視されます

検出されたスキルは、セッション作成時のシステムプロンプトの `<available_skills>` に
名前と説明が一覧表示されます。エージェントは `skill` ツールで SKILL.md の全文を
読み込み、`read_followup` にスキルディレクトリ内の相対パスを指定すると付属ファイル
(手順書・テンプレートなど)も読み込めます。

スキルの検出は**セッション作成時**に行われるため、プロジェクトメモリと同じく
追加・編集は新規セッションのみに反映されます。同名のスキルはワークスペースが
グローバルより優先されます。

## Agent Plugins

[Agent Plugins](https://agent-plugins.org/)(v1.0.0)の**クライアント**として、スキルと
MCP サーバーをまとめた移植可能なプラグインを読み込めます。プラグインは
`plugin.json` マニフェストを持つディレクトリで、次の場所に配置します:

- **ワークスペース**: ワークスペースフォルダの `.agents/plugins/<名前>/`
  (リポジトリルートまで遡って各階層を検出。スキルと同じ走査規則)
- **グローバル**: `~/.agents/plugins/<名前>/`(全ワークスペースで利用可能)

```text
my-plugin/
├── plugin.json        # 必須。$schema と name を検証(クローズドスキーマ)
├── skills/            # 任意。直下の <名前>/SKILL.md をスキルとして検出(再帰しない)
│   └── summarize/
│       └── SKILL.md
└── mcp.json           # 任意。MCP サーバー設定($schema + mcpServers)
```

- `plugin.json` は `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` を
  `$schema` に指定します。致命的な違反(必須フィールド欠落・型誤り)があるプラグインは
  **全体が拒否**され、未知のトップレベルフィールドなどは警告のみで無視されます
  (仕様の report-and-ignore に準拠)
- `skills/` は**直下の子ディレクトリ**のみ走査し、`SKILL.md` の frontmatter が
  Agent Skills 形式のものを読み込みます(条件を満たさないものはスキップ)
- `mcp.json` は **stdio** と **streamable-http** のサーバーに対応します
  (legacy `sse` は検証のみ行い接続しません。仕様上任意)
  - stdio サーバーには `PLUGIN_ROOT`(プラグインルート)と専用の書き込み可能な
    `PLUGIN_DATA` ディレクトリ(`$XDG_DATA_HOME`/`%LOCALAPPDATA%` 配下の
    `lumisca-agent/plugin-data/<名前>`)が環境変数として注入されます
  - `./` で始まる `command` と `cwd` はプラグインルート基準で解決され、
    ルート外への脱出はそのエントリのみスキップされます
- 名前の衝突時は、スキルは ワークスペース > プラグイン > グローバル、MCP サーバーは
  明示的な設定(アプリ設定・ワークスペース `.mcp.json`)がプラグインより優先されます

プラグインの検出も**セッション作成時**に行われます。プラグインのマニフェストや
コンポーネントに問題があっても、他のプラグインやセッション自体の動作は止まりません
(問題はセッションエラーとして報告されます)。

## パーソナライズ (全体 AGENTS.md)

⚙ → パーソナライズ で、システムプロンプトの**最後**に付加するカスタム指示を設定できます。
内容は設定ファイルと同じディレクトリの `AGENTS.md`
(`~/.config/lumisca-agent/AGENTS.md`、`$XDG_CONFIG_HOME` 設定時はその配下)に保存され、
新規セッションのシステムプロンプト末尾に取り込まれます(最大32KB)。
既存のセッションには反映されません。

## データ

- データベース: `./lumisca.db`(既定。`LUMISCA_DB` で変更)
  - テーブル: workspaces / workspace_folders / sessions / messages
- 設定: `~/.config/lumisca-agent/settings.jsonc`(JSONC。手書き編集可)
  - APIキーは `api_key:<providerId>` キーに保存(サーバーが動く PC に保存される)
  - パーソナライズ: 同じディレクトリの `AGENTS.md`(⚙ → パーソナライズ で編集)

## テスト

```bash
deno task test       # 全テスト
deno task check      # 型チェック
deno task lint       # lint
deno task fmt        # フォーマット(適用)
deno task fmt:check  # フォーマット(確認のみ)
```

core(サンドボックス・永続化・ツール境界)、server(HTTP / WebSocket / 静的シェル / バンドル)の
テストを含みます。CI(GitHub Actions)では fmt / lint / check / test を実行します。

## 設計メモ

- エージェントループは pi の `Agent`(イベント購読ベース)を使用し、
  イベントを WebSocket / CLI へ中継します
- UI はクライアントサイドレンダリング(サーバーは静的シェルのみ)。初期データ
  (ワークスペース・テーマ)は `/assets/initial-data.js` として外部化して配信し、
  クライアントが読み込みます(インラインスクリプトはページ CSP で禁止しているため
  外部化しています)
- セッションのメッセージは message_end ごとに SQLite へ追記保存され、
  再オープン時に完全復元されます
- システムプロンプトはセッション**作成時**に、ベースプロンプト(OS・CPU・GPU・
  モデル・日付などの環境情報を含む)とワークスペースの AGENTS.md(プロジェクト
  メモリ)、設定ファイルと同じ場所の AGENTS.md(パーソナライズ)を取り込んで組み立て、
  `system_prompt` に保存されます。再オープン時は保存済みのプロンプトをそのまま使う
  ため、AGENTS.md の編集は新規セッションのみに反映されます(キャッシュヒット率の
  都合で、一度セッションに取り込まれたプロンプトは変更されません)。
  手動でプロンプトを指定するカスタムプロンプト API は廃止されました
- MCP は公式 `@modelcontextprotocol/sdk` の Client を使用し、`McpManager` が
  セッションごとにサーバーの起動・ツール発見・呼び出し・終了を管理します
  (stdio は子プロセス、HTTP は streamable HTTP)。アプリ単位の設定は設定ファイル
  (settings の `mcp_servers` キー、汎用 settings API からは保護)で、
  ワークスペースの `.mcp.json` とマージして使用します
- ワークスペース境界の検証は `packages/core/workspace/sandbox.ts` に集約されており、
  実在パスは realpath 解決後にルート集合との包含判定を行います
- セキュリティ: ループバック限定 + `LUMISCA_ALLOWED_HOSTS`(リモートホスティング時)
  + オリジン完全比較(CORS / WS)+ 任意の `LUMISCA_TOKEN` 認証
  (非ループバックバインド時は必須。認証付きサーバーではページ自体もトークン必須)。
  Markdown レンダラーは画像 URL を https/http + 非ループバックに制限します

