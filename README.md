Lumisca-Agentは、LLMでアプリケーション開発を高速化するためのコーディングエージェントです。

Webサーバー、およびデスクトップアプリとして動作します。

基本的に私が趣味での開発に使用するために作っているものなので、
私が欲しいなと思いついた機能を好き勝手実装していきます。

既存のコーディングエージェントでできることは大体できるので、
珍しい機能としては
- 画像入力に非対応のモデルを使用している際は、画像入力に対応したモデルに画像のキャプションを生成させてそれを渡すことで、
画像入力に対応しているモデルに近い使い勝手が得られる
- 頻繁に入力する文章を保存していつでも呼び出せる
- Enterで送信されない

しか思いつきませんでした。今後増える可能性大

## Linuxサーバーに常駐させる

一般ユーザーで次を実行します。rootでは実行しません。

```
curl -fsSLO https://raw.githubusercontent.com/SousiOmine/Lumisca-Agent/master/install-server.sh
bash install-server.sh
```

既定では`127.0.0.1:8000`で待ち受け、systemdのユーザーユニットとしてマシン起動時に自動で立ち上がります。接続先のURLとトークンは最後に表示されます。

`--port`、`--host`、`--dir`、`--version`で変えられます。`--help`で一覧を出します。`--host`にループバック以外を指定するときは`--allowed-hosts`も指定します。

インストール先は既定で`~/.local/share/lumisca`です。状態は`lumisca-server service status`、停止と削除は`lumisca-server service uninstall`で行います。
