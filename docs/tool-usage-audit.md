# エージェントのツール在庫と `present` の利用実態

この文書は2つの問いに答える。

1. Lumisca のエージェントには、どのツールが与えられるのか
2. 「成果物提出ツール」(`present`) は使用率が低く、役に立っていないのではないか

2 は推測ではなく、実運用データベースの全メッセージを集計して判定した。結論は「使用率は低くない。ただし壊れ方が悪く、UI 側の見返りが小さい」である。

---

## 1. ツール在庫

ツールは「毎リクエストで LLM に渡す（プリロード）」か「`tool_search` で発見して `tool_call` で実行する（レジストリ）」かに分かれる。定義の所在は次のとおり。

| 区分 | 定義 | 実装 |
| --- | --- | --- |
| プリロード | `createCodingTools` / `createChatTools` | `core/tools/toolsets.ts` |
| レジストリ | `ToolRegistry`（セッション単位） | `core/tools/registry.ts` |
| ガイドライン | `PromptSection`（`requires` で出し分け） | `core/tools/prompt-sections.ts` |
| 名前の正準 | `TOOL_*` 定数（UI と共有） | `core/shared/tool-names.ts` |

### 1.1 コーディングセッション（ワークスペースあり）: 20 ツール

| 分類 | ツール |
| --- | --- |
| ファイル | `read` `write` `edit` `list_dir` `grep` `glob` |
| 実行 | `bash` `async_bash` `async_bash_status` `async_bash_kill` `eval` |
| 宣言 | `present` |
| 進行・委譲 | `todo` `task` `task_output` `send_message` `ask` `skill` |
| レジストリ操作 | `tool_search` `tool_call` |

`createCodingTools` が返すのは 18 個で、`tool_search` / `tool_call` は `SessionAgent` がレジストリに中身があるときだけ足す（`agent/session-agent.ts` の `registryToolPair`）。

### 1.2 チャットセッション（ワークスペースなし）: 3 + 2 ツール

`skill` `ask` `todo` のみ。ファイル・シェル・サブエージェントの面は存在しない（`createChatTools`）。レジストリに中身があれば `tool_search` / `tool_call` が加わる。

### 1.3 レジストリ（コンテキスト非搭載、`tool_search` で発見）

- ブラウザラボ 6 個（`browser_open` `browser_observe` `browser_act` `browser_wait` `browser_screenshot` `browser_close`）。デスクトップのブラウザ backend があるときだけ
- `pdf_read_pages` 1 個（コーディングセッションのみ）
- MCP ツール（設定依存）

本セッションで `tool_search` を引いた実測では **165 ツール / 9 グループ**（powerpoint 156、exa 2、ブラウザ 6、PDF 1）だった。この規模のスキーマを毎リクエストに載せないことがレジストリの目的である。

### 1.4 サブエージェント

| 種別 | ツール |
| --- | --- |
| `explore` | `read` `list_dir` `grep` `glob` `skill` `send_message`。書き込み・実行系を持たず、ファイルを変更できない |
| `general` | `read` `write` `edit` `list_dir` `grep` `glob` `bash` `eval` `skill` `send_message`。深さ制限内なら `task` `task_output`（孫エージェント）、レジストリに中身があれば `tool_search` / `tool_call` |

どちらも `ask` `todo` `async_bash*` `present` を持たない。UI への往復（`ask`）、自分の計画パネル（`todo`）、自分より長生きするプロセス（`async_bash`）、そして宣言（`present`）は、サブエージェントの仕事ではないためである。サブエージェントの成果物は親への報告文である。

---

## 2. 計測方法

`present` は 2026-09-13 のコミット `dd59810` で成果物一覧と同時に新規追加された。したがって母数は「その日以降に作られたセッション」に限る必要がある。

- 対象: `%APPDATA%\com.lumisca.agent\lumisca.db`（読み取り専用で開く。実行中のアプリの DB）
- 規模: 195 セッション / 51,641 メッセージ / 30,022 ツール呼び出し（2026-08-12 〜 2026-09-23）
- 注意: メッセージの保存形式が新旧 2 種ある（旧は `$.toolName`、新は `$.message.toolName`）。集計は `COALESCE` で両対応した

なおワークスペース直下の `lumisca.db` は開発用で、最終更新が 2026-09-08 —— `present` の導入前である。これを根拠に「0 回」と結論すると誤る（実際そう誤読した）。

---

## 3. 使用率

| 指標 | 値 |
| --- | --- |
| 呼び出し回数 | 17 / 30,022 = **0.057%** |
| 呼び出したセッション | 10 / 195 |
| 導入後の実働コーディングセッション | 26 中 10 = **38%** |
| 導入後にファイルを書いたセッション | 17 中 10 = **59%** |

回数シェア 0.057% は誤った分母である。`present` は「1 タスクにつき 1 回宣言する」性質のツールで、同じ性質の `ask`（69 回）や `task`（65 回）と比べても同程度に使われている。セッション単位で見ると、同世代の他ツールと比べて中位につける。

| ツール | 使用セッション（実働 26 中） |
| --- | --- |
| `bash` | 24 |
| `write`/`edit` | 17 |
| `todo` | 16 |
| **`present`** | **10** |
| `skill` | 8 |
| `ask` | 7 |
| `task` | 3 |

**使用率が低いという仮説は成立しない。** 低く見えるのは、呼び出し回数を分母にしたときだけである。

---

## 4. 「役に立たない」という印象の内訳と、その対処

仮説は外れたが、印象の原因は実在した。3 点あり、うち 2 点は対処済みである。

### 4.1 エラー率 41% —— 全ツール中で最悪（対処済み）

| ツール | エラー率 | 呼び出し数 |
| --- | --- | --- |
| **`present`** | **41.2%** | 17 |
| `browser_screenshot` | 27.8% | 18 |
| `browser_wait` | 27.3% | 33 |
| `list_dir` | 7.5% | 469 |
| `read` | 0.6% | 9,749 |

7 件の失敗はすべて `Unknown workspace folder: …`、つまりサンドボックスのパス規則違反である。

```
Unknown workspace folder: packages. Workspace folders: Lumisca-Agent   (4 件)
Unknown workspace folder: docs.     Workspace folders: Lumisca-Agent   (1 件)
Unknown workspace folder: internal. Workspace folders: VibeTeX         (1 件)
Unknown workspace folder: deno.json. Workspace folders: Lumisca-Agent  (1 件)
```

規則は「相対パスの先頭セグメントがワークスペースフォルダ名でなければならない」（`workspace/sandbox.ts` の `relativeToRoot`）。`read` や `list_dir` も同じ検証を通るが、そちらは直前のツール出力から正準形のパスをコピーするため失敗しない。`present` は作業の最後に呼ばれ、モデルが自分の要約からパスを書くため、リポジトリ相対の自然な形（`packages/…`）を渡してしまう。

**決定的だったのは、`present` 自身のスキーマ例がその失敗形を教えていたこと。**

```ts
// 修正前
path: string("Workspace path to an existing file, e.g. `docs/report.pdf`"),
```

ワークスペースのフォルダが `Lumisca-Agent` であるとき `docs/report.pdf` は解決できない。実際 `docs/…` を渡した失敗が記録されている。ツール説明・引数例・ガイドライン節のどこにもフォルダ接頭辞の規則は書かれておらず、唯一の例が規則に反していた。

ただし実害は限定的で、7 件すべてが直後の再試行で成功している（1 セッションあたり「失敗 1 回 + 成功 1 回」の形）。最終状態は常に正しい。失われるのは往復 1 回分のトークンと時間である。

対処として、スキーマ例を `Aaa/docs/report.pdf`（フォルダ名を先頭セグメントに置く形）に直し、引数の説明でも規則を明示した。サンドボックス側で接頭辞なしの相対パスを受け入れる「緩和」はしていない —— それは暗黙のフォールバックであり、`read` / `write` / `edit` と規則が食い違う。

### 4.2 一覧の操作が「パスをコピー」だけ（対処済み）

当時の成果物パネルが提供する操作はクリックによるパス文字列のコピーのみ（i18n の copyHint = 「クリックでコピー: {path}」）だった。ファイルを開く・プレビューする・エクスプローラーで表示する導線は、Web 側にもサーバー側にもデスクトップシェル側にも存在しない（`routes/fs.ts` は `/fs/roots` と `/fs/browse` のみ）。

一方 `present.ts` の doc コメントは導入時から一貫して次を主張していた。

> the UI lists them in the deliverables panel **and opens them from there**

実装はコピーしかしない。**コメントと実装が最初から乖離している**（`git show dd59810:packages/core/tools/present.ts` で確認済み）。

対処として、コメントを実装に合わせ、表示そのものを右パネルの浮動カードからチャット欄の末尾（会話の直下）へ移した。カードは種類のアイコン・ファイル名・種類の行（`ドキュメント · PDF`）・エージェントが付けた説明を並べ、操作はパスのコピーだけである。

「開く」導線は足していない。開く／プレビューを実現するには新しい API（サーバー）とデスクトップ側の opener が要り、サーバー単体配布（ブラウザが別マシンにある）では意味が薄い。**現状のアプリにファイルを開く能力は存在しない**（`routes/fs.ts` はフォルダ選択の `/fs/roots` と `/fs/browse` のみ、Tauri 側のプラグインは updater / dialog / notification のみ）。できない操作をボタンで見せないことが、ここでの正しい選択である。

なお、最終アシスタントメッセージは既にパスと説明を markdown で列挙している。成果物一覧の付加価値は「セッションを通じて残る一覧」に限られる —— これが「役に立たないように見える」印象の主因だった。

### 4.3 ガイドライン節がプロンプトに載っていないセッションが大多数（設計どおり）

`present` のガイドライン節（`tool:present`）を持つセッションは 195 中 12 にすぎない。`present` を使った 10 セッションのうち、持っていたのは 4 だけである。

原因は設計どおりの挙動にある。システムプロンプトはセッション作成時に凍結される（`AgentFactory.open` は `session.systemPrompt` があれば再生成しない）一方、**ツール配列は開くたびに再構築される**。そのため、後から追加されたツールは「ツール定義は見えるが、ガイドライン節は無い」状態で既存セッションに現れる。

裏を返せば、**ツール定義だけで 6 セッションが `present` を使った**ことになる。説明文はトリガーとして機能しており、ガイドライン節は補強にすぎない。ここは対処の対象ではない —— ツールの契約は説明文が持ち、節は横断的な行動規範だけを書くという分担どおりである。

---

## 5. 対処しなかった選択肢

**成果物一覧の削除**。セッション単位の使用率 38〜59% を維持コストに見合わないと取るなら、`present.ts` / 成果物一覧 / `tool:present` 節 / `TOOL_PRESENT` / i18n をまとめて落とすのが筋である。今回は使用率が中位であること、およびセッションをまたいで残る唯一の成果物ビューであることから、維持を選んだ。削除する場合も中途半端に残さないこと —— 片方だけを消すとドリフト源になる。

---

## 6. 計測の再現手順

```sql
-- ツール別の呼び出し数・エラー数・セッション数
WITH t AS (
  SELECT session_id,
         COALESCE(json_extract(content,'$.message.toolName'),
                  json_extract(content,'$.toolName')) AS tool,
         COALESCE(json_extract(content,'$.message.isError'),
                  json_extract(content,'$.isError')) AS is_error
  FROM messages WHERE role = 'toolResult'
)
SELECT tool, COUNT(*) AS calls,
       SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS errors,
       COUNT(DISTINCT session_id) AS sessions
FROM t GROUP BY tool ORDER BY calls DESC;

-- 導入（2026-09-13）以降のコーディングセッションを分母にする
WITH coding AS (
  SELECT s.id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
  WHERE s.created_at >= strftime('%s','2026-09-13')*1000 AND w.chat = 0
),
t AS (
  SELECT session_id,
         COALESCE(json_extract(content,'$.message.toolName'),
                  json_extract(content,'$.toolName')) AS tool
  FROM messages WHERE role = 'toolResult'
)
SELECT
  (SELECT COUNT(DISTINCT session_id) FROM t
     WHERE session_id IN (SELECT id FROM coding) AND tool IN ('write','edit')) AS wrote_files,
  (SELECT COUNT(DISTINCT session_id) FROM t
     WHERE session_id IN (SELECT id FROM coding) AND tool = 'present') AS used_present;
```

実行例（読み取り専用で開く。稼働中のアプリの DB を触らない）:

```bash
sqlite3 -readonly "$APPDATA/com.lumisca.agent/lumisca.db" ".read query.sql"
```
