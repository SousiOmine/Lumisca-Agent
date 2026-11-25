# サードパーティ素材の表記

Lumisca-Agent の配布物に含まれるサードパーティ製ファイルとライセンス情報を記録します。

## Skia ICU データ (`icudtl.dat`)

- **出所**: npm パッケージ `@napi-rs/canvas-<platform>`（例: `@napi-rs/canvas-win32-x64-msvc`）に同梱の `icudtl.dat` を、ビルド時に無改変でコピーしています。Windows のビルド時（`scripts/build-server.ts`）にサーバーバイナリと同じ階層へ配置します（デスクトップ版では `server/icudtl.dat` リソース）。macOS および Linux 版のパッケージでは、Skia バイナリに埋め込まれているため同梱していません。
- **内容**: Skia（`@napi-rs/canvas` の描画バックエンド）が使用する ICU/Unicode ロケールデータです。PDF ページ画像化ツール（`packages/core/pdf/tools.ts` の `pdf_read_pages`）の初期化に必須であり、欠落するとプロセスが異常終了するため同梱しています。
- **著作権表示**（ファイル内の原文）:

  ```
  Copyright (C) 2016 and later: Unicode, Inc. and others.
  License & terms of use: http://www.unicode.org/copyright.html
  ```

- **ライセンス**: Unicode License Agreement — Data Files and Software（上記 URL の条件が適用されます）。無改変でコピーし、埋め込みの著作権表示を保持しています。
- **ラッパーのライセンス**: `@napi-rs/canvas` のバインディング部分は MIT License（Copyright (c) 2020 lynweklm@gmail.com）です。

## 数式フォント KaTeX

- **出所**: npm パッケージ `katex` の `dist/fonts/*.woff2` を無改変で配布物に含めます。ビルド時にサーバーのアセットへ配置します。配置先は `assets.json` とデスクトップ版の `assets/` です。返信の数式を組むスタイルシートがこのファイルを参照します。
- **内容**: KaTeX が数式を組むための書体です。`packages/server/assets.ts` が `katex/dist/katex.min.css` の `url()` を `/assets/<名前>` へ書き換え、参照されたファイルをそのまま同梱します。スタイルシートそのものは `url()` の書き換え、`woff` と `ttf` の代替指定の削除、圧縮だけを行って同梱します。
- **著作権表示**: `Copyright (c) 2013-2020 Khan Academy and other contributors`
- **ライセンス**: MIT License
