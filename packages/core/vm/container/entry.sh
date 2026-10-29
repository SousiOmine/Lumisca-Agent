#!/bin/sh
# The stella machine's first process: a virtual display, a window manager, a
# browser and the VNC bridge the chat's screen pane connects to.
#
# The values here (DISPLAY :99, 1280x800, VNC on 6080) are also written in
# packages/core/vm/contract.ts, which verifies them against the running
# container at start-up. Changing one without the other breaks the screen pane
# or the agent's coordinates, so both are expected to change together.
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

# Chromium keeps its profile lock across container recreations (it names the
# previous container's hostname and pid), which shows an "Unlock Profile"
# dialog over the screen the agent is trying to read.
rm -f /home/agent/.config/chromium/Singleton*

chromium \
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
trap 'kill $XVFB_PID $OPENBOX_PID $CHROMIUM_PID $X11VNC_PID $WEBSOCKIFY_PID 2>/dev/null; exit 0' TERM INT

wait
