#!/bin/sh
# The stella machine's first process: its own screen (:99), its session bus,
# and the accessibility switch. The desktops the conversations work on —
# X servers, window managers, browsers with their own profiles, VNC bridges —
# are started per agent by container/desktop.sh, so two agents do not share a
# browser, a profile, a pointer or an accessibility tree.
#
# The values here (DISPLAY :99, 1280x800, the session bus path) are also
# written in packages/core/vm/contract.ts, which verifies them against the
# running container at start-up; desktop.sh answers for the desktops
# themselves (`desktop.sh contract`). Changing one without the other breaks
# what the check proves, so both are expected to change together.
set -eu

export DISPLAY=:99

# The same path as VM_DESKTOP_SCRIPT in vm/contract.ts, which proves it is
# there (the contract check asks this program what it would start).
DESKTOP_SCRIPT=/usr/local/lib/lumisca/desktop.sh

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

# The session bus the machine's own screen uses, at a FIXED path, not
# `dbus-launch --autolaunch`: the autolaunch address changes on every start,
# and the server enters the machine with `podman exec`, which inherits nothing
# from this script — it could never find the bus. The desktops start one each
# (desktop.sh); this one is what the image exports in
# DBUS_SESSION_BUS_ADDRESS, and the contract check proves it answers.
# A stale socket from a killed container would make dbus-daemon refuse to
# bind, so the directory is recreated.
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
# it. dconf is per user, so this one write covers every desktop's bus.
gsettings set org.gnome.desktop.interface toolkit-accessibility true

# SIGTERM is how `podman stop` ends this container. `wait` does not forward it
# to children, and without this trap a stop would sleep out podman's 10 second
# grace period and then SIGKILL, making every shutdown feel broken. A desktop
# started by desktop.sh is a child of its own `podman exec` (and of the
# container's process namespace), so it dies with the container rather than
# from this list.
trap 'kill $DBUS_PID $XVFB_PID 2>/dev/null; exit 0' TERM INT

wait
