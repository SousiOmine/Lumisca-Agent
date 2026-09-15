# ARCHITECTURE.md — Lumisca-Agent アーキテクチャ概要

## 1. パッケージ構成

| パッケージ | 主な役割 | 依存関係 |
|---|---|---|
| `core/` | 基盤機能：SessionAgent、SessionPool（AgentFactory）、ModelManager、MCP、ツール群、SQLite、スキル／プラグイン管理 | 外部ライブラリのみ |
| `server/` | Honoベースのバックエンド：REST API、WebSocket、フェデレーションプロキシ、esbuildによるバンドル、自己アップデート機能 | `core` |
| `web/` | PreactによるSPA（`api-client`、`api-local`、`api-federation`、`api-routing` に責務を分離） | `core/shared` および `core/modes` のみ |
| `desktop/` | Tauri v2ベースのデスクトップシェル（npmとDenoを併用） | `server` を子プロセスとして起動 |
| `browser-rpc/` | Rust製ブラウザ連携用RPC：プローブ抽出、URLポリシー制御、HTTPサーバー機能 | なし |

### 依存関係の原則
- `core` は他の内部パッケージに依存しません。
- `web` が `core` から直接取り込むモジュールは**純粋関数のみ**に限定されています（フロントエンドで安全に実行できるヘルパー群である `shared/`、およびプロンプト生成を担う `modes/`）。これらはビルド時（`server/bundle.ts` の esbuild、および `web/vite.config.ts` の Vite）のエイリアス設定によって適切に解決されます。
- 型定義のみをインポートしている `@lumisca/core` の参照はコンパイル時に除去されるため、実行時のオーバーヘッドはありません。

---

## 2. web パッケージの設計方針

- **`modelCatalog.ts`（モデルカタログの共有ストア）**  
  接続先（ピア）ごとのプロバイダーおよびモデル情報を一元管理する共有ストアです。設定ダイアログのプロバイダー／モデル一覧、モデルピッカー、チャットビューなどの全UIコンポーネントは、このストアを一貫して参照します。設定画面の開き直しやタブの切り替えなどで再マウントされても再フェッチは行われません。  
  そのため、**モデルの変更操作は必ず本ストアへ書き戻す必要があります**（内部的には `applyModelEnabled` を使用し、トグルUIからは `providers.ts` の `setModelEnabled` を経由して実行します）。状態をコンポーネント内のローカルステートに持たせてしまうと、画面遷移やアンマウント時に変更内容が消失するためご注意ください。

- **圧縮チェックポイントの表示**  
  圧縮で生成される `checkpoint` メッセージは、`ContextRow` と同じ `SystemRow` を使ったコンパクトな1行（`CheckpointRow.tsx`）として描画され、クリックでモデルに渡された要約本文を展開できます。`buildTurns` では独立した行（`standalone`）として扱い、前後のターンに吸収させません（置換位置を示す行であり、そのターンを開始したプロンプトではないため）。実行中の圧縮は走行状態を消してはならないため、巻き戻しの `messages_truncated` とは別イベント（`messages_compacted`）で通知します。

- **スキルパレット（`/skill`）**  
  コンポーザーのスラッシュメニューには、静的なモード（`AGENT_MODES`）と保存済みプロンプトに加えて、**セッションのスキルカタログ**が第三の供給元として入ります（`useSkills` が `GET /api/skills` をワークスペース所有ピアから取得）。`/skill` はカタログをサブメニューとして開き、選択するとコンポーザーが `/skill <名前> ` まで補完します（`SlashCommandKind` の `complete` は、項目付きのコマンドでは `/<id> <項目id> ` へ補完する＝項目id がコマンドの引数）。送信時は `skillPromptFromText` がその行を `buildSkillPrompt`（core）のプロンプトへ包みます。  
  スキルの選択は `ModeMessage` にせず、生成したプロンプトをそのまま**通常のユーザーメッセージ**として送ります。バッジと短縮テキストは `AGENT_MODES` に登録されたモードに紐づくため、動的なスキル名をモードとして流用すると巻き戻し（`modeRewindText`）が名前を復元できません。

---

## 3. core パッケージの設計方針

- **`LumiscaCore`**  
  薄いファサード（Facade）かつコンポジションルート（Composition Root）として機能します。コンストラクタで協調動作する各コンポーネントをバインドしており、テスト時には容易にモックやスタブへ差し替えることができます。
- **`agent/`**  
  `SessionAgent`（プロンプト生成・タイトル付与・MCP・通知処理）、`RetryManager`（空応答や429エラーのリトライ制御）、`GoalRunner`（自律的なゴール達成ループ）、`AgentFactory`（配線処理）、`SessionPool`（エージェントのライフサイクル管理）で構成されます。  
  なお、`agent/context-providers.ts` で扱う**動的コンテキスト**（スキルカタログや `AGENTS.md`）は、プロンプトに直書きせず `context` メッセージとして履歴スタックに追加し、値に変更があった場合のみ再送する設計です（DSHにおける `PromptContext` と同様のアプローチです）。
- **`agent/context-compaction.ts`**  
  長時間動作するセッションの履歴をモデルのリクエスト上限内に保つ**コンテキスト圧縮**の唯一の実装です（DeepSeek Harness の compaction seam と token meter をLumiscaの語彙に写像したもの）。設計上の要点は次のとおりです。
  * **計測**: 直近の assistant `usage`（プロバイダーが報告した実測値）をアンカーとし、それ以降に追加された分だけを `shared/token-estimate.ts` のヒューリスティックで見積もります。アンカーが無い場合のみリクエスト全体（システムプロンプト＋ツール定義＋履歴）を見積もります。
  * **予算**: プロバイダーは `prompt + maxOutputTokens` をウィンドウに対して検証するため、しきい値は `contextWindow` ではなく **`contextWindow − maxTokens`**（使用可能入力）に対する比率です。既定はしきい値 80%・保持 16%（DSH の `thresholdRatio` / `retainRatio` と同値）。
  * **発火点**: `Agent.beforeStep`（各LLMリクエストの直前）。ターン内でツール結果が積み上がる暴走を止められます（DSH の `agent/pre-step` と同じ理由）。
  * **置換**: 古い区間を**1つの `checkpoint` メッセージで置き換え**ます（追記ではありません）。切断点は「assistant + 続く toolResult 群」を1単位として選ぶため、tool-call/result の対応は必ず保たれます（DSH の tool-pairing balance 検査に相当）。最新の1単位は常に保持します。
  * **要約呼び出し**: セッション自身のシステムプロンプト・ツールスキーマ・対象区間をそのまま再生し、指示を最後の user メッセージとして追加します（プロバイダーのプレフィックスキャッシュを再利用）。`StreamOptions.maxOutputTokens` で出力を上限内に抑えます。
  * **失敗時**: 要約が失敗した場合は履歴を一切変更せず、そのままの履歴でリクエストを続行します（DSH と同じ「durable surface を保持する」方針）。要約が元区間より縮まない場合も拒否します。
  * **overflow 回復**: プロバイダーがウィンドウ超過を返した場合（`retry-policy.ts` の `isContextOverflowError`）、しきい値と保持予算を無視した強制圧縮を1回だけ行い、成功した場合のみ再試行します。2回目の拒否はプロバイダーの元エラーをそのまま提示します（DSH の `maxOverflowRetries` と同じ）。
  * **適用範囲**: メインセッション（DB永続化＋`messages_compacted` イベント）とサブエージェント（メモリのみ）の双方が同じ `ContextCompactor` を使います。
- **`ai/rate-limit.ts`**  
  HTTP 429（レート制限）の判定、指数バックオフ、リトライループを担う唯一の実装です。通信トランスポート、セッション、サブエージェントの間で共有されています。`agent/llm-retry.ts` は本モジュールへ処理を委譲する形で assistant メッセージのリトライを行います。
- **`goal/loop.ts`**  
  自律ループを実行する `runGoalLoop` と、終了処理を共通化する `finishGoal` を提供し、ゴール達成・失敗・中断を含むすべての終了パスを統一してハンドリングします。
- **`tools/prompt-sections.ts`**  
  システムプロンプト内のガイドライン節を定義します。各セクションは `requires` プロパティ（必要なツール名）を保持しており、**現在のセッションで有効化されているツールに対応する節のみ**がプロンプトへレンダリングされます。各ツールの `description` は「1回の呼び出し規約と失敗判定マーカー」に留め、ツール横断的な行動規範や共通ポリシーは本モジュールに集約しています（`tools/system-prompt.ts` はその組み立てのみを担当します）。
- **`tools/gitignore.ts`**  
  `loadCachedGitignore(sandbox)` により、`.gitignore` の構文解析結果をサンドボックス単位でメモリ上にキャッシュします。タイムスタンプが不一致（ファイルの更新を検知）となった場合のみ再読み込みを行います。
- **`skills/slash.ts`**  
  `/skill` が送るプロンプト本文の唯一の定義です。`modes/` と同じく web バンドルから `@lumisca/core/skills/slash` として取り込まれるため、**ディスクや node 組み込みに依存してはいけません**（`discover.ts` を取り込むと `node:path` がクライアントへ入ります）。パレットの一覧（`GET /api/skills`）は `LumiscaCore.listSkills` が `sessionSkills` で組み立て、スキルツール・スキルカタログと同じ探索を共有します（`workspaceId` 省略時はチャットセッション相当＝グローバルと組み込みのみ。`POST /api/sessions` と同じ「省略 → チャット」規約で、未知のIDは 404）。
- **`shared/`**  
  フロントエンドでも安全に動作する共通ヘルパー群です（esbuild により web バンドルへ取り込まれます）。`misc.ts` はエラー処理、JSON、テキスト操作、モデル定義、ブートストラップ、非同期処理のカテゴリごとに明確に分類されています。
- **`shared/context-usage.ts`**  
  コンテキスト使用量メーターを計算する唯一の共通実装です。`Usage.input` は**キャッシュされていない**プロンプト入力トークン数を表しており、1ターンの総プロンプトトークン数は `input + cacheRead + cacheWrite` として算出されます（`ai/types.ts` の仕様に準拠）。この仕様を取り違えると使用量が本来の倍で見積もられてしまうため、本関数を通じて計算する必要があります。
- **`shared/token-estimate.ts`**  
  プロバイダーの実測値が無い履歴を価格付けする固定ヒューリスティックです（ASCII は4文字/トークン、それ以外は1文字/トークン、画像は固定の視覚予算）。コンパクタはアンカー以降の差分だけをここで見積もるため、この誤差は常にリクエスト全体ではなく差分に限定されます。CJK を過小評価しない（＝圧縮が遅れて溢れる方向に倒れない）よう、非ASCII は1文字1トークンとしています。
- **`settings/keys.ts` 相当の機能**  
  **設定キーの信頼できる単一の情報源（SSOT）は `shared/settings-keys.ts` です**（`APP_MCP_SETTINGS_KEY` などの定数もここで定義されています）。テーマなどのUI関連キーから、サーバー単体で動作する自動アップデート設定（`UPDATE_AUTO_KEY` / `UPDATE_AUTO_RESTART_KEY`）まで、すべての設定キーを同ファイルで一元管理しています。

---

## 4. server パッケージの設計方針

- **`systemd/`**  
  ビルド済みサーバーを Linux の systemd **ユーザーユニット**として常駐させる `service` サブコマンド（`install` / `config` / `status` / `uninstall`）を提供します。設定内容は以下の**3層を順に合成**して生成され、その優先順位は `systemd/compose.ts` で一元管理されています。
  1. `systemd/template.ts` に定義されたユニットテンプレート（`deno compile` で単一バイナリにパッケージングするため、テンプレートも TypeScript 定数として保持）
  2. 既存の `<config home>/lumisca-agent/service.env`（パーミッション 0600。認証トークンの引き継ぎ元であり、運用担当者が手動編集可能なレイヤー）
  3. 起動時引数フラグ（`--host` / `--port` / `--db` / `--allowed-hosts` / `--token`）

  `config` コマンドは上記 1〜3 を合成した結果を表示するのみで、ファイル書き込みは行いません（秘匿情報であるトークンはマスクされます）。`install` コマンドは合成結果をファイルに出力し、`systemctl --user enable/restart` の実行および linger 設定の有効化確認までを行います。  
  なお、ループバックアドレス以外（外部ネットワーク等）でリクエストを受け付ける場合は、Host ヘッダーのバリデーションによる 403 エラーを防ぐため、`--allowed-hosts` の指定が必須となります。詳細な運用手順は `AGENTS.md` をご参照ください。
- **`auth-cookie.ts`**  
  認証トークン（`LUMISCA_TOKEN`）をブラウザに記憶させる Cookie の方針を定義します。ヘッダー（API クライアント）とクエリパラメータ（WebSocket ハンドシェイク・初回のページ表示）はそのままに、ブラウザが `?token=` 付き URL を一度開けば Cookie で同じ資格情報を提示できるようにし、毎回トークンを打ち込む手間をなくします（属性は `HttpOnly` / `SameSite=Lax`。遠隔運用は LAN / Tailscale 上の平文 HTTP が前提のため `Secure` は付けません）。Cookie 名にはポートを含めます（`lumisca_token_<ポート>`）。Cookie はポートを区別しないため、同一ホストの複数インスタンス（開発用 8000 と常駐用 8100 など）が互いの Cookie を上書きして 401 に落ちるのを防ぐためです。受け入れ順序と保存の判断は `app.ts` の `installSecurityMiddleware` にあります。
- **`shutdown.ts`**  
  プロセスの正常停止フローを一括管理します。監視プロセス（スーパーバイザー）からの通常停止要求である `SIGTERM` 受信時は終了コード **0**、手動中断の `SIGINT` 受信時は **130** で終了します。未完了処理のドレイン処理（drain）は 5 秒でタイムアウトし、シャットダウン中に2回目のシグナルを受信した場合は即時強制終了します。なお、外側の制御としてユニット定義の `TimeoutStopSec=10` が最大タイムアウト時間となります。
- **`startup.ts`**  
  デフォルトの待受設定（`DEFAULT_HOST`（ループバック）、`DEFAULT_PORT`）、および環境変数 `LUMISCA_UPDATE_RESTART` の動作モード（`self` / `supervisor` / `none`）を定義する単一の情報源です。`parsePortValue` はランチャー起動時と `service --port` の双方で共通のポート検証ロジックとして使用されます。
- **`update/service.ts`**  
  `supervisor` モード時、自動更新後に後継プロセスを自前で spawn せず、正常シャットダウンを経て `exit(0)` のみを行います（同一 cgroup 内でプロセスを起動すると監視側と競合するため、systemd の `Restart=always` に後続プロセスの立ち上げを委ねる設計です）。
- **`fs.ts`**  
  バックエンド専用のファイル操作ユーティリティ群（`readIfExists` / `resolveGlobalDirs` / `isRecord` / `atomicWriteTextFileSync`）です。`shared/` に Deno 固有のランタイム API を持ち込ませないため、本パッケージ配下に分離して配置しています。
- **`base64.ts`**  
  画像読み込みや PDF レンダリングで共通利用される `bytesToBase64` 変換処理を提供します。

---

## 5. 依存関係および実装上の留意点

- **`sucrase`**  
  eval ツール内での TypeScript から JavaScript へのトランスパイル専用に採用しています。TypeScript 7 では transpile API が外部公開されていないため、esbuild での代替は不可としています。
- **`@napi-rs/canvas`**  
  PDF 描画処理専用モジュールです。動的インポートで読み込まれるため、実行時には `--allow-ffi` 権限が必要です。
- **`preact/compat`**  
  web パッケージ全体における React 互換レイヤーとして利用しており、依存から削除することはできません。
- **`ai/test`**  
  利用箇所が存在しないため、コードベースより削除済みです。
- **`browser-rpc/src/cdp.rs`**  
  デスクトップ版のブラウザラボ機能が使用する CDP（Chrome DevTools Protocol）のパラメータ生成および応答解析を担当します。`browser_lab.rs` の同期呼び出し処理から責務を切り離し、プロトコルの解釈ロジックを一箇所に集約しています。
- **`desktop/src-tauri/src/pane.rs`**  
  ドックペインの配置座標（ジオメトリ）の計算や、OS 固有のウィンドウ配置（Z オーダーの制御、仮想デスクトップへの固定など）を制御します。
- **Rust におけるロックの取得方針**  
  スレッドセーフなロックの取得は、すべて **`lib.rs` の `LockRecover::lock_recover()` を経由して行います**（`Mutex::lock().unwrap_or_else(|e| e.into_inner())` を個別に記述することは禁止します）。Poison 状態となったロックからの復旧ポリシーを一箇所に集約することで、Tauri コマンドがパニックによって無応答となる障害を防止しています。
- **`scripts/lib.ts`**  
  メンテナンス用スクリプト共通のヘルパー関数群（`repoRoot` / `binaryName` / `reportUsage` / `parseOptions` / `createChecker`）を提供します。`repoRoot` のパス解決には `fileURLToPath` を使用しています（`.pathname` の手動変換は、スペースを含むパスで破損するため禁止です）。
- **esbuild（本番環境）と Vite（開発環境）のデュアル構成**  
  本番用配布物のバンドル生成（`deno compile` への内包）は `server/bundle.ts`（esbuild）が担当し、開発時の HMR（Hot Module Replacement）および API プロキシ機能は `packages/web/vite.config.ts`（Vite）が担います。なお、CSS の `@import` 解決順序の仕様は両環境で厳密に一致させています（詳細は `packages/web/src/styles/README.md` を参照）。
- **履歴メッセージのロール**  
  モデルに見せる形（`toLlmMessages`）は `user` / `assistant` / `toolResult` の3種のみです。Lumisca 固有のロール（`notification` / `context` / `mode` / `checkpoint`）はいずれも user メッセージへ変換されます。新しいロールを追加する場合は、この変換・`estimateMessageTokens`（トークン見積り）・web 側の `MessageRow` / `buildTurns` の3か所を同時に更新してください（1か所でも漏れると、そのメッセージがモデルに届かないか、UIで描画されません）。
- **`MessageRepo.replaceRange`**  
  履歴の一部を置き換える唯一の DB 操作です（圧縮が使用）。行はトランスクリプト順に挿入されるため rowid が位置と一致する、という `deleteFrom` と同じ前提に依存しています。置換後の永続化済み件数（`SessionAgent.savedCount`）は「置換位置＋1＋置換区間より後ろに残った既存行数」で再計算します。ここを単純にトランスクリプト長にしてしまうと、まだ保存されていない末尾のメッセージが二重に挿入されます。

---

## 6. 多言語対応（i18n）

アプリの言語（UI の表示言語と、セッションが回答する言語）は **1 つの値**で、サーバー設定 `language`（`shared/settings-keys.ts` の `LANGUAGE_KEY`、値は `"ja"` / `"en"`）に保存されます。

- **文言カタログ**: `core/shared/i18n/`（`common.ts` / `chrome.ts` / `settings.ts` / `chat.ts` / `panels.ts`）。1 エントリに**両言語**を持たせる形式（`"key": { ja: "…", en: "…" }`）で、欠けた翻訳はコンパイルエラーになります。キーは `messages.ts` が集約し、`translate(locale, key, params)` で `{name}` プレースホルダを差し込みます。`i18n_test.ts` が「キー網羅」「プレースホルダ一致」「ja === en の未訳」を検証します。
- **LLM 向けプロンプトは一律英語**: システムプロンプトのガイドライン、ツール説明、`/plan`・`/review`・`/goal` が送るプロンプト本文、スキル呼び出しプロンプトは英語で固定し、言語ごとに二重管理しません。**回答言語はシステムプロンプトの指示だけが決めます**（`tools/language.ts`）。
- **セッション開始時の言語**: システムプロンプトは作成時にスナップショットされる（`agent/factory.ts`）ため、セッションは開始時に選ばれていた言語で回答し続けます。言語設定を後から変えても既存セッションのプロンプトは変わりません（新規セッションから反映）。サブエージェントとセッションタイトルも、その時点のセッション言語に揃えます。
- **セッション言語の解決**: `LumiscaCore.getLanguage()` が「保存値 → マシンのロケール（`locale.ts`）」の順で解決し、エージェント組み立て時に渡します。コアがトランスクリプトへ書き込む文言（圧縮チェックポイントの見出し、ゴール停止通知）はこの言語で生成され、保存された文字列はそのまま残ります（過去のメッセージを遡って翻訳し直すことはしません）。
- **初回の言語決定**: `app.ts` の `languageFor` が「保存値 → `Accept-Language` → マシンのロケール → 既定 `ja`」の順で解決し、**未設定なら最初のページ表示時にその値を保存**します。以後の唯一の書き手は設定ダイアログの**「一般」パネル**（`GeneralPanel` の言語行）で、`web/src/hooks/useLanguage.ts` が楽観更新とロールバックを担当します。GET で書き込むのはこの初回だけです。
- **クライアント側**: `web/src/i18n.ts` がモジュールストア（`useSyncExternalStore`）と `useT()` / `t()` を提供します。コンポーネントは `const t = useT();` で文言を引きます（`t()` を直接呼ぶのは通知など描画外のコードのみ）。`InitialData.language` を `client.tsx` がレンダリング前にストアへ流し込むため、初回描画から正しい言語になります。日付・相対時刻は `web/src/format.ts` の `Intl` ベースのヘルパーを使います。
- **エージェントモードのメニュー文言**: `core/modes/*.ts` は文言を持たず、カタログの**キー**（`MessageKey`）だけを持ちます（`chat.mode.*`）。web 側が `t` を渡して解決するため、スラッシュメニューの `useMemo` は翻訳関数を依存に含めます。
- **対象外**: デスクトップシェル（Rust）の文言、サーバー CLI / systemd / 更新機構のメッセージ（`server/mod.ts`, `server/systemd/`, `server/update/`）、起動スプラッシュは日本語のままです。`core/workspaces.ts` のチャット用ワークスペース名（`"チャット"`）は内部識別用で API からは隠されるため、翻訳対象ではありません。
- **未対応（次段階の候補）**: 次の文言はユーザーから見える場所に残っていますが、今回のスコープ（Web UI・コア生成文言・モード文言）には含めていません。(1) サーバー API のエラー文言（`server/federation.ts` のピア接続エラー、`server/login.ts` のレートリミット文言）— リクエストの言語を API 層まで引き回す必要があります。(2) ブラウザツール（`core/browser/*`）の診断メッセージ — モデルに読ませるツール結果であり、UI のトランスクリプトにも表示されるため、どちらの言語に寄せるかは別途判断が必要です。

## 7. バージョン管理

本アプリケーションのバージョン番号は、以下の**8つのマニフェストファイル**で定義されています。

1. `packages/core/deno.json`
2. `packages/server/deno.json`
3. `packages/web/deno.json`
4. `desktop/deno.json`
5. `desktop/package.json`
6. `tauri.conf.json`
7. `Cargo.toml`
8. `packages/server/version.ts`

`packages/server/version.ts` は、`deno compile` によって単一バイナリ化されたサーバーが実行時に自己のバージョンを把握するための定数定義です（コンパイル済みバイナリはリポジトリ内のマニフェストファイルを直接参照できないため、本ファイル値が自動アップデート時の比較基準となります）。

バージョンの整合性検証は `scripts/check-versions.ts` が唯一の実装として担っており、CI ワークフロー（`ci.yml`：コード変更の都度実行）およびリリースパイプライン（`release.yml`：タグ発行時に実行）の双方から呼び出され、不整合の発生を防止しています。