#!/usr/bin/env bash
# micke desktop session bootstrap.
#
# Starts, inside a single D-Bus session (dbus-run-session):
#   1. Xvfb       — headless X11 server (X11, not Wayland: window ops and
#                   focus control are unsupported on Wayland sessions)
#   2. a11y bus   — AT-SPI accessibility bus agent-desktop speaks; started
#                   BEFORE any app because an app that starts before the bus
#                   never registers on it
#   3. openbox    — minimal EWMH window manager
#
# The bus environment is published to /tmp/session.env; source it in any
# later `docker exec` shell before running agent-desktop:
#
#   docker exec micke bash -c '. /tmp/session.env && agent-desktop status'
#
# Modeled on agent-desktop's own container smoke test
# (scripts/linux-container-smoke.sh in vercel-labs/agent-desktop).
set -euo pipefail

# The runtime dir must exist before dbus-run-session starts the bus.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
export DISPLAY="${DISPLAY:-:99}"
mkdir -m 700 -p "$XDG_RUNTIME_DIR"

if [ "${1:-}" = "--desktop" ]; then
    Xvfb "$DISPLAY" -screen 0 "${MICKE_SCREEN:-1280x800x24}" >/tmp/xvfb.log 2>&1 &
    until [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; do sleep 0.1; done

    /usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &

    openbox >/tmp/openbox.log 2>&1 &

    printf "export XDG_RUNTIME_DIR=%s DISPLAY=%s DBUS_SESSION_BUS_ADDRESS='%s'\n" \
        "$XDG_RUNTIME_DIR" "$DISPLAY" "${DBUS_SESSION_BUS_ADDRESS:-}" >/tmp/session.env
    chmod 600 /tmp/session.env

    echo "micke: desktop ready on $DISPLAY (${MICKE_SCREEN:-1280x800x24})"
    exec sleep infinity
fi

exec dbus-run-session -- "$0" --desktop
