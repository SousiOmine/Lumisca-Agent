#!/bin/sh
# The stella machine's first process: a virtual display, a window manager, a
# browser and the VNC bridge the chat's screen pane connects to.
#
# The values here (DISPLAY :99, 1280x800, VNC on 6080, the session bus path)
# are also written in packages/core/vm/contract.ts, which verifies them against
# the running container at start-up. Changing one without the other breaks the
# screen pane, the agent's coordinates or its semantic tools, so both are
# expected to change together.
set -eu

export DISPLAY=:99

# A lock left behind by a killed container keeps Xvfb from starting.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!

# Wait for X, with a bound: a display that never comes up must fail visibly
# rather than leave the machine half-started.
i=0
while [ "$i" -lt 100 ]; do
  xdotool getdisplaygeometry >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 0.1
done

openbox &
OPENBOX_PID=$!

# The session bus the semantic tools reach the machine's widgets through.
#
# At a FIXED path, not `dbus-launch --autolaunch`: the autolaunch address
# changes on every start, and the server enters the machine with `podman exec`,
# which inherits nothing from this script — it could never find the bus.
# A stale socket from a killed container would make dbus-daemon refuse to bind,
# so the directory is recreated.
rm -rf /tmp/lumisca-dbus
mkdir -p /tmp/lumisca-dbus
dbus-daemon --session --fork --nopidfile \
  --address=unix:path=/tmp/lumisca-dbus/session.sock &
DBUS_PID=$!
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/lumisca-dbus/session.sock

# Accessibility on, BEFORE any application starts. A GTK app reads
# `toolkit-accessibility` once, when it initialises, and only then loads its
# ATK bridge: an app started while the value was false never appears on the bus,
# no matter what is set afterwards. The AT-SPI bus itself is started by D-Bus
# activation on the first app that asks for it, so nothing here launches it.
gsettings set org.gnome.desktop.interface toolkit-accessibility true

# Chromium keeps its profile lock across container recreations (it names the
# previous container's hostname and pid), which shows an "Unlock Profile"
# dialog over the screen the agent is trying to read.
rm -f /home/agent/.config/chromium/Singleton*

# `--force-renderer-accessibility` is what makes Chromium publish the contents
# of the PAGE (buttons, fields, table cells), not just its window chrome.
# Without it the web area is an empty frame on the bus: the agent could find
# Chromium's own toolbar but nothing the page shows.
chromium \
  --force-renderer-accessibility \
  --no-first-run \
  --no-default-browser-check \
  --hide-crash-restore-bubble \
  --window-size=1280,800 \
  --window-position=0,0 \
  about:blank &
CHROMIUM_PID=$!

# VNC listens on the container's loopback only: the server forwards it over an
# authenticated WebSocket (server/stella-screen.ts). It is never exposed on the
# host's network.
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet &
X11VNC_PID=$!

websockify 6080 127.0.0.1:5900 &
WEBSOCKIFY_PID=$!

# SIGTERM is how `podman stop` ends this container. `wait` does not forward it
# to children, and without this trap a stop would sleep out podman's 10 second
# grace period and then SIGKILL, making every shutdown feel broken.
trap 'kill $DBUS_PID $XVFB_PID $OPENBOX_PID $CHROMIUM_PID $X11VNC_PID $WEBSOCKIFY_PID 2>/dev/null; exit 0' TERM INT

wait
