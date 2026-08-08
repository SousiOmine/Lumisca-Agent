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
- **ワークスペース**: 単一フォルダだけでなく、複数フォルダをまとめた単位でも作業可能。
  ファイル操作(read / write / edit / list_dir)はワークスペース内に制限されます
  (パス正規化 + シンボリックリンク解決によるサンドボックス)
- **セッション永続化**: セッション履歴とメタデータを SQLite に保存。再起動後も再開できます
- **全プロバイダー対応**: Anthropic, OpenAI, DeepSeek, OpenRouter, Google など
  20+ のプロバイダーを API キー方式で利用可能(モデル選択UI付き)
- **ツール**: read_file / write_file / edit / list_dir / bash(cmd.exe または /bin/sh)

## 構成

```
packages/
├── core/      AI基板(共通)。全フロントエンドはこれだけに依存
│   ├── agent/       pi-agent-core ラッパー + セッションプール
│   ├── tools/       ワークスペース境界付きコーディングツール
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

`LUMISCA_TOKEN` を設定すると、API と WebSocket にトークン認証がかかります
(ヘッダー `X-Lumisca-Token` または WS の `?token=` クエリ)。デスクトップアプリは
起動のたびにトークンを生成して渡すため、別のローカルプロセスからエージェントを
操作できません。未設定なら従来どおり認証なしで動きます。

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

## データ

- データベース: `./lumisca.db`(既定。`LUMISCA_DB` で変更)
  - テーブル: workspaces / workspace_folders / sessions / messages / settings
- APIキー: 設定DB内(`api_key:<providerId>` キー)に保存(ローカル専用前提)

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
- ワークスペース境界の検証は `packages/core/workspace/sandbox.ts` に集約されており、
  実在パスは realpath 解決後にルート集合との包含判定を行います
- セキュリティ: ループバック限定 + オリジン完全比較(CORS / WS)+
  任意の `LUMISCA_TOKEN` 認証。Markdown レンダラーは画像 URL を
  https/http + 非ループバックに制限します

