#!/bin/sh
# One desktop of the stella machine.
#
# The machine gives every agent its own desktop — X server, window manager,
# browser profile and VNC bridge — so two conversations can work at once
# without their windows, pointers or logins mixing. This is the only thing
# that starts or stops one; `vm/machine.ts` calls it through `podman exec`
# when a conversation first uses its screen.
#
#   desktop.sh start <slot> <agent-id>
#   desktop.sh stop <slot>
#
# Idempotent: `start` on a slot that is already up does nothing, and `stop`
# on a slot that is down is not an error.
set -eu

STATE_DIR=/tmp/lumisca-desktop
VNC_BASE=5900
WEBSOCKIFY_BASE=6080

action=${1:?usage: desktop.sh start|stop <slot> [agent-id]}
slot=${2:?a slot is required}
case "$slot" in
  0|1|2|3) ;;
  *)
    echo "no such desktop slot: $slot" >&2
    exit 2
    ;;
esac

# Slot 0 is the display the container boots; the others are started here.
if [ "$slot" -eq 0 ]; then
  display=":99"
else
  display=":$((99 + slot))"
fi
state="$STATE_DIR/$slot"

alive() {
  [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null
}

case "$action" in
start)
  agent=${3:?an agent id is required}
  profile="$HOME/.config/chromium/$agent"
  mkdir -p "$state" "$profile"

  # A lock left behind by a killed container keeps Xvfb from starting.
  if ! [ -e "/tmp/.X${display#:}-lock" ]; then
    rm -f "/tmp/.X${display#:}-lock" "/tmp/.X11-unix/X${display#:}"
    Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp &
    echo $! > "$state/xvfb.pid"
    i=0
    while [ "$i" -lt 100 ]; do
      DISPLAY="$display" xdotool getdisplaygeometry >/dev/null 2>&1 && break
      i=$((i + 1))
      sleep 0.1
    done
  fi

  if ! alive "$state/openbox.pid"; then
    DISPLAY="$display" openbox &
    echo $! > "$state/openbox.pid"
  fi

  # The browser. Its own profile directory is what keeps one agent's logins
  # out of another's; `--force-renderer-accessibility` is what publishes the
  # PAGE's contents on the bus rather than only the window chrome.
  if ! alive "$state/chromium.pid"; then
    rm -f "$profile/Singleton"* 2>/dev/null || true
    DISPLAY="$display" chromium \
      --user-data-dir="$profile" \
      --force-renderer-accessibility \
      --no-first-run \
      --no-default-browser-check \
      --hide-crash-restore-bubble \
      --window-size=1280,800 \
      --window-position=0,0 \
      about:blank >/dev/null 2>&1 &
    echo $! > "$state/chromium.pid"
  fi

  # VNC listens on the container's loopback only; the published range carries
  # the websocket to the host's loopback, and the server relays it.
  if ! alive "$state/x11vnc.pid"; then
    x11vnc -display "$display" -forever -shared -nopw -localhost \
      -rfbport "$((VNC_BASE + slot))" -quiet >/dev/null 2>&1 &
    echo $! > "$state/x11vnc.pid"
  fi

  if ! alive "$state/websockify.pid"; then
    websockify "$((WEBSOCKIFY_BASE + slot))" \
      "127.0.0.1:$((VNC_BASE + slot))" >/dev/null 2>&1 &
    echo $! > "$state/websockify.pid"
  fi
  ;;

stop)
  # The browser first: its renderers are its children and go with it.
  for name in chromium websockify x11vnc; do
    if alive "$state/$name.pid"; then
      kill "$(cat "$state/$name.pid")" 2>/dev/null || true
    fi
    rm -f "$state/$name.pid"
  done
  # Xvfb and openbox stay. Display :99 is part of the machine's contract, and
  # a window manager is a few hundred kilobytes.
  ;;

*)
  echo "usage: desktop.sh start|stop <slot> [agent-id]" >&2
  exit 2
  ;;
esac
