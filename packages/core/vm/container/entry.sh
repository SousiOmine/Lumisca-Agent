#!/bin/sh
# The stella machine's first process: its screen (:99), its session bus, and
# the accessibility switch. The window manager, the browser and the VNC bridge
# — the desktop the conversation works on — are started on first use by
# container/desktop.sh, so a machine that only runs shell commands does not
# pay for a browser.
#
# One container serves one agent. The screen, the bus and the accessibility
# tree are therefore the machine's own, and no second display or numbered bus
# exists.
#
# The values here (DISPLAY :99, 1280x800, the session bus path) are also
# written in packages/core/vm/contract.ts, which verifies them against the
# running container at start-up; desktop.sh answers for the desktop itself
# (`desktop.sh contract`). Changing one without the other breaks what the
# check proves, so both are expected to change together.
set -eu

export DISPLAY=:99

# The same path as VM_DESKTOP_SCRIPT in vm/contract.ts, which proves it is
# there (the contract check asks this program what it would start).
DESKTOP_SCRIPT=/usr/local/lib/lumisca/desktop.sh

# The machine's own cache, named after the agent at creation. AT-SPI puts its
# bus socket under it keyed by DISPLAY, and a shared home would let two
# machines find each other's socket. A machine created without it is a
# definition this image does not serve, so it fails here rather than mixing
# accessibility trees later.
: "${XDG_CACHE_HOME:?the machine was created without XDG_CACHE_HOME}"
mkdir -p "$XDG_CACHE_HOME"

# Every process of the previous container run is gone, but the state they left
# in /tmp is not: pid files name pids that are now reused, and the X locks
# make Xvfb refuse to start on a display nobody holds. Forgotten before
# anything starts, including this script's own :99.
"$DESKTOP_SCRIPT" reset

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

# The session bus, at a FIXED path, not `dbus-launch --autolaunch`: the
# autolaunch address changes on every start, and the server enters the machine
# with `podman exec`, which inherits nothing from this script — it could never
# find the bus. A stale socket from a killed container would make dbus-daemon
# refuse to bind, so the directory is recreated.
rm -rf /tmp/lumisca-dbus
mkdir -p /tmp/lumisca-dbus
# `--fork` returns only once the bus is listening (a client that races it
# fails to connect, and a `gsettings set` that loses that race leaves
# accessibility at its default for every app started afterwards), and
# `--print-pid` names the daemon it leaves behind so the trap can end it.
DBUS_PID=$(dbus-daemon --session --fork --print-pid --nopidfile \
  --address=unix:path=/tmp/lumisca-dbus/session.sock)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/lumisca-dbus/session.sock

# Accessibility on, BEFORE any application starts. A GTK app reads
# `toolkit-accessibility` once, when it initialises, and only then loads its
# ATK bridge: an app started while the value was false never appears on the
# bus, no matter what is set afterwards. The AT-SPI bus itself is started by
# D-Bus activation on the first app that asks for it, so nothing here launches
# it.
#
# The write is read back once: dconf's file lives in the shared home, so two
# machines starting at the same moment can race its lock, and a lost write
# would leave this machine without an accessibility tree — a failure the
# contract check refuses at start-up. The second failure is left to that
# check, which reports the value it read.
gsettings set org.gnome.desktop.interface toolkit-accessibility true
if [ "$(gsettings get org.gnome.desktop.interface toolkit-accessibility)" != "true" ]; then
  gsettings set org.gnome.desktop.interface toolkit-accessibility true
fi

# SIGTERM is how `podman stop` ends this container. `wait` does not forward it
# to children, and without this trap a stop would sleep out podman's 10 second
# grace period and then SIGKILL, making every shutdown feel broken. The
# desktop started by desktop.sh is a child of its own `podman exec` (and of the
# container's process namespace), so it dies with the container rather than
# from this list.
trap 'kill $DBUS_PID $XVFB_PID 2>/dev/null; exit 0' TERM INT

wait
