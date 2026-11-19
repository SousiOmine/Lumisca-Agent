#!/usr/bin/env bash
# Linux サーバーに Lumisca を入れて、systemd のユーザーユニットとして
# 常駐させる。一般ユーザーで実行する。root では実行しない。
#
#   curl -fsSLO https://raw.githubusercontent.com/SousiOmine/Lumisca-Agent/master/install-server.sh
#   bash install-server.sh
#
# 既定では 127.0.0.1:8000 で待ち受け、マシン起動時に自動で立ち上がる。
set -euo pipefail

REPOSITORY="SousiOmine/Lumisca-Agent"
TARGET="x86_64-unknown-linux-gnu"
PLATFORM="linux-x64"
DEFAULT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/lumisca"

VERSION=""
DIR="$DEFAULT_DIR"
HOST=""
PORT=""
ALLOWED_HOSTS=""
TOKEN=""
SERVICE=1

usage() {
  cat <<'EOF'
Linux サーバーに Lumisca を入れて常駐させます。

使い方:
  bash install-server.sh [options]

オプション:
  --version <v>           入れる版。既定は最新のリリース。
  --dir <path>            インストール先。既定は ~/.local/share/lumisca。
  --host <addr>           待ち受けアドレス。既定は 127.0.0.1。
  --port <n>              待ち受けポート。既定は 8000。
  --allowed-hosts <list>  ループバック以外で許可するホスト名/IP。カンマ区切り。
  --token <value>         クライアント用トークン。既定は初回に生成して以後は引き継ぐ。
  --no-service            配置だけ行い、systemd には触れない。
  -h, --help              このヘルプ。

root では実行しないでください。エージェントはシェルを実行するので、
サーバーはそれを所有する一般ユーザーで動かします。
EOF
}

die() {
  printf 'install-server: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [ "$#" -ge 2 ] || die "$1 には値が必要です"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      require_value "$@"
      VERSION="$2"
      shift 2
      ;;
    --dir)
      require_value "$@"
      DIR="$2"
      shift 2
      ;;
    --host)
      require_value "$@"
      HOST="$2"
      shift 2
      ;;
    --port)
      require_value "$@"
      PORT="$2"
      shift 2
      ;;
    --allowed-hosts)
      require_value "$@"
      ALLOWED_HOSTS="$2"
      shift 2
      ;;
    --token)
      require_value "$@"
      TOKEN="$2"
      shift 2
      ;;
    --no-service)
      SERVICE=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "不明なオプションです: $1"
      ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || die "Linux でのみ動きます。現在は $(uname -s) です。"
[ "$(uname -m)" = "x86_64" ] || die "配布しているのは linux-x64 だけです。現在は $(uname -m) です。"
[ "$(id -u)" -ne 0 ] || die "root では実行しないでください。サーバーを動かす一般ユーザーで実行します"

case "$DIR" in
  /*) ;;
  *) die "--dir は絶対パスで指定してください: $DIR" ;;
esac

if [ -n "$PORT" ]; then
  case "$PORT" in
    *[!0-9]* | "") die "--port は 1 から 65535 の整数で指定してください: $PORT" ;;
  esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port は 1 から 65535 の整数で指定してください: $PORT"
fi

command -v tar >/dev/null 2>&1 || die "tar が必要です"
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  die "curl か wget が必要です"
fi
if [ "$SERVICE" -eq 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "systemd が必要です (systemctl が見つかりません)"
fi

if [ -n "$VERSION" ]; then
  case "$VERSION" in
    *[!0-9.]* | "") die "--version は 0.11.10 のような版で指定してください: $VERSION" ;;
  esac
  MANIFEST_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION/latest-server-$TARGET.json"
else
  MANIFEST_URL="https://github.com/$REPOSITORY/releases/latest/download/latest-server-$TARGET.json"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/lumisca-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 -o "$2" "$1"
  else
    wget -O "$2" "$1"
  fi
}

json_string() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1
}

json_number() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$2" | head -n 1
}

printf '更新情報を取得しています: %s\n' "$MANIFEST_URL"
download "$MANIFEST_URL" "$TMP/manifest.json" || die "更新情報を取得できませんでした"

VERSION_FOUND="$(json_string version "$TMP/manifest.json")"
ARCHIVE_URL="$(json_string url "$TMP/manifest.json")"
ARCHIVE_SIZE="$(json_number size "$TMP/manifest.json")"
[ -n "$VERSION_FOUND" ] && [ -n "$ARCHIVE_URL" ] && [ -n "$ARCHIVE_SIZE" ] ||
  die "更新情報の形式が不正です: $MANIFEST_URL"
if [ -n "$VERSION" ] && [ "$VERSION_FOUND" != "$VERSION" ]; then
  die "更新情報の版が一致しません。取得した版は $VERSION_FOUND で、指定は $VERSION です。"
fi

printf 'Lumisca v%s をダウンロードしています...\n' "$VERSION_FOUND"
download "$ARCHIVE_URL" "$TMP/server.tar.gz" || die "サーバーをダウンロードできませんでした: $ARCHIVE_URL"
ACTUAL_SIZE="$(wc -c <"$TMP/server.tar.gz" | tr -d ' ')"
[ "$ACTUAL_SIZE" = "$ARCHIVE_SIZE" ] ||
  die "ダウンロードしたファイルの大きさが違います。$ACTUAL_SIZE バイトでした。期待は $ARCHIVE_SIZE バイトです。"

mkdir -p "$TMP/extract"
tar -xzf "$TMP/server.tar.gz" -C "$TMP/extract"
SRC="$TMP/extract/lumisca-server-$PLATFORM"
[ -x "$SRC/lumisca-server" ] || die "アーカイブに lumisca-server が見つかりません"

mkdir -p "$DIR"
# Copy everything but the executable, then replace the executable with a
# rename. Writing over a running binary fails with ETXTBSY on Linux; a rename
# swaps the directory entry and leaves the running process on the old inode.
for entry in "$SRC"/*; do
  name="$(basename "$entry")"
  [ "$name" = "lumisca-server" ] && continue
  cp -R "$entry" "$DIR/"
done
cp "$SRC/lumisca-server" "$DIR/.lumisca-server.new"
chmod +x "$DIR/.lumisca-server.new"
mv -f "$DIR/.lumisca-server.new" "$DIR/lumisca-server"

printf 'Lumisca v%s を %s に配置しました。\n' "$VERSION_FOUND" "$DIR"

if [ "$SERVICE" -eq 0 ]; then
  printf '\n常駐させるには次を実行してください:\n'
  printf '  %s service install' "$DIR/lumisca-server"
  [ -n "$HOST" ] && printf ' --host %s' "$HOST"
  [ -n "$PORT" ] && printf ' --port %s' "$PORT"
  [ -n "$ALLOWED_HOSTS" ] && printf ' --allowed-hosts %s' "$ALLOWED_HOSTS"
  [ -n "$TOKEN" ] && printf ' --token %s' "$TOKEN"
  printf '\n'
  exit 0
fi

INSTALL_ARGS=("$DIR/lumisca-server" service install)
[ -n "$HOST" ] && INSTALL_ARGS+=(--host "$HOST")
[ -n "$PORT" ] && INSTALL_ARGS+=(--port "$PORT")
[ -n "$ALLOWED_HOSTS" ] && INSTALL_ARGS+=(--allowed-hosts "$ALLOWED_HOSTS")
[ -n "$TOKEN" ] && INSTALL_ARGS+=(--token "$TOKEN")

printf '\nsystemd のユーザーユニットを設定しています...\n'
if "${INSTALL_ARGS[@]}"; then
  :
else
  printf '\n常駐の設定が完了しませんでした。上のメッセージを確認してください。\n' >&2
  printf 'サーバーは %s に配置済みです。\n' "$DIR" >&2
  exit 1
fi

printf '\nインストールしました。\n'
printf '  版: %s\n' "$VERSION_FOUND"
printf '  場所: %s\n' "$DIR"
printf '\n状態:\n'
"$DIR/lumisca-server" service status || true
