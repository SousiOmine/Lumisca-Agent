# THIRD-PARTY-NOTICES.md — Lumisca-Agent 同梱サードパーティ素材

このファイルは、Lumisca-Agent の配布物にそのままの形で含まれる
サードパーティ製ファイルを記録します。

## Skia ICU データ (`server/icudtl.dat`)

- 出所: npm パッケージ `@napi-rs/canvas-<platform>`（例:
  `@napi-rs/canvas-win32-x64-msvc`）に同梱の `icudtl.dat` を、
  ビルド時に無改変でコピーします
  （`scripts/build-desktop-assets.ts` が Windows リリースランナー上で
  そのプラットフォーム用のファイルを `server/icudtl.dat`
  リソースとして配置。macOS/Linux 版パッケージにはデータファイルが
  同梱されておらず、Skia バイナリに埋め込まれています）。
- 内容: Skia（`@napi-rs/canvas` の描画バックエンド）が使用する
  ICU/Unicode ロケールデータ。PDF ページ画像化ツール
  （`pdf_read_pages` → `packages/core/pdf/tools.ts`）が Skia を
  初期化するために Windows で必要です。欠けると Skia がプロセスを
  異常終了させるため、フォールバックではなく必須リソースとして
  同梱します。
- 著作権表示（ファイル内に埋め込まれた原文のまま）:

  ```
  Copyright (C) 2016 and later: Unicode, Inc. and others.
  License & terms of use: http://www.unicode.org/copyright.html
  ```

- ライセンス: Unicode License Agreement — Data Files and Software
  （上記 URL の条件が適用されます）。条件の要点は、著作権表示と
  使用条件への言及を保持したままの再配布が認められることです。
  本プロジェクトではファイルを無改変コピーすることで埋め込みの
  著作権表示を保持しています。
- ラッパー部分（`@napi-rs/canvas` の JS/ネイティブバインディング）は
  MIT License（Copyright (c) 2020 lynweklm@gmail.com）です。
