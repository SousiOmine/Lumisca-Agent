Lumiscaは、LLMを使用した汎用的なエージェントアプリケーションです。

基本的に私が趣味での開発に使用するために作っているものなので、
私が欲しいなと思いついた機能を好き勝手実装していきます。

煩わしいセッション管理を不要にしながら，高いキャッシュヒット率を実現しています．
各エージェントにデスクトップ付きコンテナが与えられるため，
PCで実行できる大抵の作業を委任することが可能です．

## 導入方法
デスクトップアプリとdebian用のサーバーを用意していますが，
debian系ディストリビューションのコンピュータにサーバーを導入し，
デスクトップアプリをサーバーに接続するクライアントとして使用することを推奨しています．

Lumiscaのサーバーに外出先から接続する場合は，Tailscaleという
メッシュVPNソフトを導入することで実現可能です
（おそらく他のVPNソフトでも可能だが未検証）．
以下ではTailscaleを導入し，
`tailscale serve -bg`でポートをTailscaleネットワーク内で
共有していることを前提として記述します．

デスクトップアプリはWindows,MacOS,Debian用ビルドがあるので
[Releaseページ](https://github.com/SousiOmine/Lumisca-Agent/releases)からダウンロードしてください。

### Linuxサーバーに常駐させる

一般ユーザーでインストールスクリプトを実行してください．

```
curl -fsSLO https://raw.githubusercontent.com/SousiOmine/Lumisca-Agent/master/install-server.sh
bash install-server.sh --allowed-hosts xxx.tailnet-xxxx.ts.net
```
--allowed-hostsオプションでは、実行しているコンピュータにおける
Tailscaleのホスト名を指定してください．

スクリプトを実行すると，必要な依存ソフトウェアとLumiscaサーバーが導入され，
systemdのユーザーユニットとしてマシン起動時に自動で立ち上がります．
初回接続時に要求されるトークンが最後に表示されます．

実行後はサービスとして常駐するため，
停止・削除する際には`lumisca-server service uninstall`コマンドを実行してください．

あとは同一Tailscaleネットワーク内のデバイスから、
インストールしたサーバーのTailscaleホスト名にアクセスし、表示されたトークンを入力することで接続できます．

### プロバイダの設定
Lumiscaの使用には，LLMのプロバイダを接続し，モデルを呼び出す必要があります．
私のおすすめはChatGPTサブスクリプション連携，あるいはOpencode Goですが，
複数のプロバイダに対応しています．

Lumiscaでは複数回のツール呼び出しを頻繁に実行するため，エージェント能力の高いモデルを指定することを推奨しています．
