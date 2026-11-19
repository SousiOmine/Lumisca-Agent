#!/bin/sh
# The desktop of one stella machine: a window manager, a browser with the
# agent's own profile, and the VNC bridge the chat's screen pane reaches
# through the server.
#
# One container serves one agent, so a machine has exactly one desktop. The X
# server and the session bus belong to the container itself (entry.sh); this
# adds the window manager, the browser and the bridge on top of them. Nothing
# here is numbered: there is no slot to name and no second display to pick.
#
#   desktop.sh start <agent id>
#   desktop.sh stop
#   desktop.sh reset
#   desktop.sh contract
#
# `start` is idempotent: the server calls it on the first screen tool after a
# wake, and a machine that is already up answers without starting a second
# browser.
#
# The values below (the screen size, the ports, the profile root, the bus and
# cache paths) are duplicated in vm/contract.ts. The server asks `contract`
# during its check and refuses a machine whose answer differs, so editing one
# side without the other fails loudly instead of quietly breaking a pane.
set -eu

STATE_DIR=/tmp/lumisca-desktop
PROFILE_ROOT="$HOME/.config/chromium"
VNC_PORT=5900
WEBSOCKIFY_PORT=6080
SCREEN=1280x800

# entry.sh boots this display and the image's DISPLAY names it: the browser the
# agent sees and a program started from bash are on the same screen.
DISPLAY=:99
export DISPLAY

usage='usage: desktop.sh start <agent id> | stop | reset | contract'
action=${1:?$usage}

# A pid file answers "is it still running" only when the pid is still that
# program. The state directory outlives the container it was written in (it is
# in /tmp, which is the container's writable layer), so by the time a stopped
# machine is started again the pid is gone, reused by something else, or a
# zombie nobody reaped — and `kill -0` says yes to the last two.
alive() {  # $1: pid file, $2: a word its command line must contain
  [ -f "$1" ] || return 1
  [ -r "/proc/$(cat "$1")/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$(cat "$1")/cmdline" | grep -q -- "$2"
}

display_up() {
  xdotool getdisplaygeometry >/dev/null 2>&1
}

listening() {  # $1: a tcp port on the loopback
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket
import sys

socket.create_connection(("127.0.0.1", int(sys.argv[1])), 0.5).close()
PY
}

wait_for_port() {  # $1: port
  i=0
  while [ "$i" -lt 100 ] && ! listening "$1"; do
    i=$((i + 1))
    sleep 0.1
  done
  listening "$1"
}

# The browser, its bridge and the window manager. Killing the browser first
# takes its renderers with it.
stop_desktop() {
  for name in chromium websockify x11vnc openbox; do
    if alive "$STATE_DIR/$name.pid" "$name"; then
      kill "$(cat "$STATE_DIR/$name.pid")" 2>/dev/null || true
    fi
    rm -f "$STATE_DIR/$name.pid"
  done
}

case "$action" in
contract)
  # One line, compared verbatim in vm/container.ts (CONTRACT_PROBE_SCRIPT).
  printf 'screen=%s vnc=%s websockify=%s profile=%s bus=%s cache=%s\n' \
    "$SCREEN" "$VNC_PORT" "$WEBSOCKIFY_PORT" "$PROFILE_ROOT" \
    "/tmp/lumisca-dbus/session.sock" "${XDG_CACHE_HOME:-}"
  ;;
reset)
  # entry.sh runs this at every container start, before anything else. The
  # processes of the previous run died with the container, but their pid files
  # and the X locks stayed behind, and both lie: a pid gets reused, and a lock
  # makes Xvfb refuse to start even though no server holds the display.
  rm -rf "$STATE_DIR"
  # at-spi leaves its own bus socket next to the cache; a stale one from a
  # killed container is a socket nothing listens on. The cache is the
  # machine's own (XDG_CACHE_HOME), so this never touches another agent's.
  rm -f "${XDG_CACHE_HOME:-}/at-spi/"bus_* 2>/dev/null || true
  n=${DISPLAY#:}
  rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
  ;;
start)
  agent=${2:?an agent id is required}
  # The id names the profile's directory, so it may not name a path.
  case "$agent" in
    "" | *[!A-Za-z0-9_-]*)
      echo "not an agent id: $agent" >&2
      exit 2
      ;;
  esac
  if ! display_up; then
    echo "the display $DISPLAY is not up" >&2
    exit 1
  fi
  mkdir -p "$STATE_DIR" "$PROFILE_ROOT/$agent"

  if ! alive "$STATE_DIR/openbox.pid" openbox; then
    openbox >/dev/null 2>&1 &
    echo $! > "$STATE_DIR/openbox.pid"
  fi

  # The browser. Its own profile directory is what keeps one agent's logins
  # out of another's; `--force-renderer-accessibility` is what publishes the
  # PAGE's contents on the bus rather than only the window chrome (without it
  # the web area is an empty frame to `vm_find`).
  if ! alive "$STATE_DIR/chromium.pid" chromium; then
    rm -f "$PROFILE_ROOT/$agent/Singleton"* 2>/dev/null || true
    chromium \
      --user-data-dir="$PROFILE_ROOT/$agent" \
      --force-renderer-accessibility \
      --no-first-run \
      --no-default-browser-check \
      --hide-crash-restore-bubble \
      --window-size=1280,800 \
      --window-position=0,0 \
      about:blank >/dev/null 2>&1 &
    echo $! > "$STATE_DIR/chromium.pid"
  fi

  # VNC listens on the container's loopback only; the published port carries
  # the websocket to the host's loopback, and the server relays it.
  if ! alive "$STATE_DIR/x11vnc.pid" x11vnc; then
    x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost \
      -rfbport "$VNC_PORT" -quiet >/dev/null 2>&1 &
    echo $! > "$STATE_DIR/x11vnc.pid"
  fi

  if ! alive "$STATE_DIR/websockify.pid" websockify; then
    websockify "$WEBSOCKIFY_PORT" "127.0.0.1:$VNC_PORT" >/dev/null 2>&1 &
    echo $! > "$STATE_DIR/websockify.pid"
  fi
  # The pane connects as soon as it has a port, so "started" means the relay
  # can be reached — not that the processes were spawned a moment ago.
  if ! wait_for_port "$WEBSOCKIFY_PORT"; then
    echo "the screen bridge on port $WEBSOCKIFY_PORT did not open" >&2
    exit 1
  fi
  ;;
stop)
  stop_desktop
  ;;
*)
  echo "$usage" >&2
  exit 2
  ;;
esac
