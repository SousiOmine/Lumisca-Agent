# Web styles

`../styles.css` はエントリ（目次）です。実体はこのディレクトリの小さな
スタイルシート群にあります。MDN「CSS の整理」（Learn > Styling basics >
Organizing your CSS）の指針に沿った構成です。

- 大きな1枚を「グローバルなルールのシート＋部分ごとの小さなシート」に分割する
- カスケード順は読み込み順（`styles.css` の `@import` の並び）で決まる

## ファイル一覧（＝カスケード順）

| 順 | ファイル | 内容 |
|----|----------|------|
| 1 | `tokens.css` | Fluent デザイントークン（dark / light テーマ変数） |
| 2 | `base.css` | 素通し・ボタン・スクロールバーなど全体の基礎 |
| 3 | `motion.css` | 共通の出現アニメ keyframes |
| 4 | `layout.css` | アプリ全体のレイアウト＋ドック用ペイン |
| 5 | `chrome.css` | タイトルバー・タブバー・メニュー・ライブ表示 |
| 6 | `chat.css` | チャット欄・メッセージ・ツールタイムライン |
| 7 | `side-panels.css` | 進捗パネル・質問カード |
| 8 | `composer.css` | 入力欄・添付・mention / slash メニュー |
| 9 | `pickers.css` | 新規セッション・履歴・peer / workspace 選択 |
| 10 | `model-picker.css` | モデル切替・思考レベル・コンテキスト量・モデル選択 |
| 11 | `modals.css` | モーダル枠・エラーバナー |
| 12 | `settings.css` | 設定モーダル・各設定パネル |
| 13 | `banners.css` | アップデートバナー・サーバー停止バナー |
| 14 | `folder-browser.css` | ワークスペースのフォルダー選択（フォルダー一覧・2ペインのブラウザ） |
| 15 | `reduced-motion.css` | `prefers-reduced-motion` の無効化 |

## 新しい見た目を足すとき

1. 置き場所は上の表から選ぶ（迷ったらコンポーネントが使われる画面の近い番号）。
2. 新しい部品群が既存のどれにも属さない場合のみ新規ファイルを作り、
   `../styles.css` の `@import` にカスケード位置を意識して追加する。
3. アニメは `opacity` / `transform` のみ・120〜180ms・`var(--lum-ease)` に寄せ、
   `reduced-motion.css` への無効化追加を忘れない。

## 狭い画面（レスポンシブ）

幅の条件は 3 つ、タッチは入力デバイスの条件で 1 つ、計 4 つだけです
（一覧は `tokens.css` の先頭にあり、`../styles_test.ts` が 3 値以外の
`max-width` を検出します）。

| 条件 | 名前 | 何を変えるか |
|------|------|--------------|
| `@media (max-width: 900px)` | compact | 余白を詰める・折り返しを許す・固定幅をやめる |
| `@media (max-width: 720px)` | pane | ドッキングペイン（460px）が本文を覆う幅。`layout.css` だけで使う |
| `@media (max-width: 600px)` | phone | 1 カラム・全画面モーダル・上部に積む進捗パネル |
| `@media (hover: none), (pointer: coarse)` | touch | hover 前提の操作を常時表示・タップ領域・入力欄 16px |

- **上書きはコンポーネントを所有するシートの末尾に書く**。カスケード順は
  シート単位なので、そこに書いた上書きは同じシートの通常ルールに必ず勝ちます。
  逆に、後ろのシートが持つルールを前のシートから上書きすると同特異度で負けるため、
  越境する上書きはしません。
- **高さは `dvh`**。`vh` は端末ブラウザの URL バーやソフトキーボードを考慮しないため、
  画面に対する高さ（モーダル・パネル・フォルダー一覧）は `dvh` で書きます。
  アプリ全体の高さは `--app-height`（既定 `100dvh`）で、タッチ端末では
  `hooks/useAppHeight.ts` が `visualViewport` の高さを書き込みます。
- **呼び出し側が決める値は CSS 変数で渡す**。インライン `style` の `left` / `width` は
  狭幅用のルールで上書きできないため、キャレット位置（`--caret-x` /
  `--caret-y`）やダイアログ幅（`--modal-width`）のように「場所に応じて変えたい値」は
  変数として渡し、配置はスタイルシートが決めます（既定値は `tokens.css` に宣言）。

## 仕組みの注意

- 開発時（Vite）は `@import` を Vite が解決する。
- 本番・パッケージ版はサーバー（`packages/server/assets.ts`）が
  `styles.css` の `@import` を同じ順序でインライン展開して配信する。
  そのため `styles/` の外への `@import` や URL 形式の `@import` は使わない。
