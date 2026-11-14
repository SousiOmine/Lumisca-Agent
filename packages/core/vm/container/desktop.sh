#!/bin/sh
# One desktop of the stella machine: an X server, a window manager, a session
# bus, a browser with the agent's own profile, and the VNC bridge the chat's
# screen pane reaches through the server.
#
# The machine gives every agent its own desktop, so two conversations cannot
# share a window, a pointer, a login or an accessibility tree. This is the
# only thing that starts or stops one: `vm/machine.ts` calls it through
# `podman exec` when a conversation first uses its screen, and `entry.sh`
# calls `reset` at every container start.
#
#   desktop.sh start <slot> <agent-id>
#   desktop.sh stop <slot>
#   desktop.sh reset
#   desktop.sh contract
#
# `start` is idempotent for the agent that owns the slot, and takes a stale
# desktop down when it is asked for a different one: a slot belongs to one
# agent, and a server that lost track of its slots (a restart) must not hand
# an agent somebody else's browser.
#
# The values below (the slot count, the display numbering, the ports, the
# profile root, the screen size, the bus naming) are duplicated in
# vm/contract.ts. The server asks `contract` during its start-up check and
# refuses a machine whose answer differs, so editing one side without the
# other fails loudly instead of quietly breaking a pane.
set -eu

STATE_DIR=/tmp/lumisca-desktop
BUS_DIR=/tmp/lumisca-dbus
PROFILE_ROOT="$HOME/.config/chromium"
VNC_BASE=5900
WEBSOCKIFY_BASE=6080
SLOTS=4
SCREEN=1280x800

usage='usage: desktop.sh start <slot> <agent id> | stop <slot> | reset | contract'
action=${1:?$usage}

# The display of one slot. :99 is the machine's own screen (entry.sh starts it
# and the contract proves it, and a command run without a desktop has it in
# DISPLAY); the desktops start one above, so a program started outside a
# desktop never lands on an agent's screen.
display_of() {
  echo ":$((100 + $1))"
}

bus_socket_of() {
  echo "$BUS_DIR/session-$1.sock"
}

bus_address_of() {
  echo "unix:path=$(bus_socket_of "$1")"
}

# A pid file answers "is it still running" only when the pid is still that
# program. The state directory outlives the container it was written in (it
# is in /tmp, which is the container's writable layer), so by the time a
# stopped machine is started again the pid is gone, reused by something else,
# or a zombie nobody reaped — and `kill -0` says yes to the last two.
alive() {  # $1: pid file, $2: a word its command line must contain
  [ -f "$1" ] || return 1
  [ -r "/proc/$(cat "$1")/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$(cat "$1")/cmdline" | grep -q -- "$2"
}

display_up() {  # $1: display
  DISPLAY=$1 xdotool getdisplaygeometry >/dev/null 2>&1
}

bus_up() {  # $1: socket path
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket
import sys

connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(sys.argv[1])
connection.close()
PY
}

listening() {  # $1: a tcp port on the loopback
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket
import sys

socket.create_connection(("127.0.0.1", int(sys.argv[1])), 0.5).close()
PY
}

wait_for_display() {  # $1: display
  i=0
  while [ "$i" -lt 100 ] && ! display_up "$1"; do
    i=$((i + 1))
    sleep 0.1
  done
  display_up "$1"
}

wait_for_port() {  # $1: port
  i=0
  while [ "$i" -lt 100 ] && ! listening "$1"; do
    i=$((i + 1))
    sleep 0.1
  done
  listening "$1"
}

# Start the slot's own session bus. Two agents on two displays must not share
# one: the AT-SPI registry the semantic tools read lives on the session bus.
ensure_bus() {  # $1: slot
  socket=$(bus_socket_of "$1")
  mkdir -p "$BUS_DIR"
  if bus_up "$socket"; then
    return 0
  fi
  rm -f "$socket"
  # The bus's OWN environment is what the services it activates inherit, and
  # at-spi names its accessibility bus after the X display
  # (`~/.cache/at-spi/bus_100`). A daemon started without DISPLAY would give
  # every desktop the machine's `bus_99`, and the semantic tools of one agent
  # would read another agent's windows.
  DISPLAY=$(display_of "$1") dbus-daemon --session --fork --nopidfile \
    --address="unix:path=$socket" >/dev/null 2>&1
  i=0
  while [ "$i" -lt 50 ] && ! bus_up "$socket"; do
    i=$((i + 1))
    sleep 0.1
  done
  bus_up "$socket"
}

# The browser, its bridge and the claim on the slot. The X server, the window
# manager and the bus belong to the display, not to the agent that happened to
# use it: the next desktop starts on them.
stop_slot() {  # $1: slot
  slot_state="$STATE_DIR/$1"
  # The browser first: its renderers are its children and go with it.
  for name in chromium websockify x11vnc; do
    if alive "$slot_state/$name.pid" "$name"; then
      kill "$(cat "$slot_state/$name.pid")" 2>/dev/null || true
    fi
    rm -f "$slot_state/$name.pid"
  done
  rm -f "$slot_state/agent"
}

case "$action" in
contract)
  # One line, compared verbatim in vm/container.ts (CONTRACT_PROBE_SCRIPT).
  printf 'slots=%s display=%s screen=%s vnc=%s websockify=%s profile=%s bus=%s\n' \
    "$SLOTS" "$(display_of 0)" "$SCREEN" "$VNC_BASE" "$WEBSOCKIFY_BASE" \
    "$PROFILE_ROOT" "$(bus_socket_of 0)"
  ;;
reset)
  # entry.sh runs this at every container start, before anything else. The
  # processes of the previous run died with the container, but their pid files
  # and the X locks stayed behind, and both lie: a pid gets reused, and a lock
  # makes Xvfb refuse to start even though no server holds the display.
  rm -rf "$STATE_DIR"
  # at-spi leaves its own bus socket per display next to the home's cache; a
  # stale one from a killed container is a socket nothing listens on.
  rm -f "$HOME/.cache/at-spi/"bus_* 2>/dev/null || true
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  i=0
  while [ "$i" -lt "$SLOTS" ]; do
    n=$(display_of "$i")
    n=${n#:}
    rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
    i=$((i + 1))
  done
  ;;
start)
  slot=${2:?$usage}
  agent=${3:?an agent id is required}
  case "$slot" in
    *[!0-9]*)
      echo "not a desktop slot: $slot" >&2
      exit 2
      ;;
  esac
  if [ "$slot" -ge "$SLOTS" ]; then
    echo "no such desktop slot: $slot (the machine has $SLOTS)" >&2
    exit 2
  fi
  # The id names the profile's directory, so it may not name a path.
  case "$agent" in
    "" | *[!A-Za-z0-9_-]*)
      echo "not an agent id: $agent" >&2
      exit 2
      ;;
  esac

  display=$(display_of "$slot")
  slot_state="$STATE_DIR/$slot"
  profile="$PROFILE_ROOT/$agent"
  mkdir -p "$slot_state" "$profile"

  # A different agent means the slot is being handed over: a fifth
  # conversation took it, or this server restarted and forgot which agent it
  # had given it to. The browser and the bridge go, the display stays.
  if [ -f "$slot_state/agent" ] && [ "$(cat "$slot_state/agent")" != "$agent" ]; then
    stop_slot "$slot"
  fi
  printf '%s\n' "$agent" > "$slot_state/agent"

  if ! display_up "$display"; then
    n=${display#:}
    rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
    Xvfb "$display" -screen 0 "${SCREEN}x24" -nolisten tcp >/dev/null 2>&1 &
    echo $! > "$slot_state/xvfb.pid"
    if ! wait_for_display "$display"; then
      echo "the display $display did not come up" >&2
      exit 1
    fi
  fi

  if ! alive "$slot_state/openbox.pid" openbox; then
    DISPLAY="$display" openbox >/dev/null 2>&1 &
    echo $! > "$slot_state/openbox.pid"
  fi

  if ! ensure_bus "$slot"; then
    echo "the session bus of slot $slot did not come up" >&2
    exit 1
  fi

  # The browser. Its own profile directory is what keeps one agent's logins
  # out of another's; `--force-renderer-accessibility` is what publishes the
  # PAGE's contents on the bus rather than only the window chrome (without it
  # the web area is an empty frame to `vm_find`).
  if ! alive "$slot_state/chromium.pid" chromium; then
    rm -f "$profile/Singleton"* 2>/dev/null || true
    DISPLAY="$display" DBUS_SESSION_BUS_ADDRESS="$(bus_address_of "$slot")" \
      chromium \
      --user-data-dir="$profile" \
      --force-renderer-accessibility \
      --no-first-run \
      --no-default-browser-check \
      --hide-crash-restore-bubble \
      --window-size=1280,800 \
      --window-position=0,0 \
      about:blank >/dev/null 2>&1 &
    echo $! > "$slot_state/chromium.pid"
  fi

  # VNC listens on the container's loopback only; the published range carries
  # the websocket to the host's loopback, and the server relays it.
  if ! alive "$slot_state/x11vnc.pid" x11vnc; then
    x11vnc -display "$display" -forever -shared -nopw -localhost \
      -rfbport "$((VNC_BASE + slot))" -quiet >/dev/null 2>&1 &
    echo $! > "$slot_state/x11vnc.pid"
  fi

  port=$((WEBSOCKIFY_BASE + slot))
  if ! alive "$slot_state/websockify.pid" websockify; then
    websockify "$port" "127.0.0.1:$((VNC_BASE + slot))" >/dev/null 2>&1 &
    echo $! > "$slot_state/websockify.pid"
  fi
  # The pane connects as soon as it has a port, so "started" means the relay
  # can be reached — not that the processes were spawned a moment ago.
  if ! wait_for_port "$port"; then
    echo "the screen bridge on port $port did not open" >&2
    exit 1
  fi
  ;;
stop)
  slot=${2:?$usage}
  case "$slot" in
    *[!0-9]*)
      echo "not a desktop slot: $slot" >&2
      exit 2
      ;;
  esac
  if [ "$slot" -ge "$SLOTS" ]; then
    echo "no such desktop slot: $slot (the machine has $SLOTS)" >&2
    exit 2
  fi
  stop_slot "$slot"
  ;;
*)
  echo "$usage" >&2
  exit 2
  ;;
esac
