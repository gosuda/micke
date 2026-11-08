#!/usr/bin/env bash
# micke desktop session bootstrap.
#
# Starts, inside a single D-Bus session (dbus-run-session):
#   1. Xvfb       — headless X11 server (X11, not Wayland: window ops and
#                   focus control are unsupported on Wayland sessions)
#   2. a11y bus   — AT-SPI accessibility bus agent-desktop speaks; started
#                   BEFORE any app because an app that starts before the bus
#                   never registers on it. Started manually, not via
#                   xfsettingsd/autostart: it must win the race against
#                   everything xfce4-session spawns.
#   3. xfce4-session — minimal XFCE desktop session: spawns xfwm4 (EWMH WM),
#                   xfce4-panel, xfdesktop and xfsettingsd, and honours
#                   /etc/xdg/autostart (xfce4-notifyd rides in that way)
#   4. x11vnc     — mirrors the display on :5900 for remote view; optional
#                   VNC password via MICKE_VNC_PASSWORD
#   5. websockify — serves the noVNC web client on :6080, proxying
#                   ws://<host>:6080/websockify to localhost:5900
#
# 4–5 are remote view, not desktop infrastructure: if either fails the
# session stays up, the failure lands in /tmp/x11vnc.log or /tmp/novnc.log,
# and the ready line reports the actual state.
#
# The bus environment is published to /tmp/session.env; the gvx shell handler
# (image/driver.sh) sources it automatically, so agent-desktop works directly.
# For a manual check inside a session:
#
#   . /tmp/session.env && agent-desktop status
#
# Modeled on agent-desktop's own container smoke test
# (scripts/linux-container-smoke.sh in vercel-labs/agent-desktop), which
# boots openbox. micke runs a minimal XFCE session instead — the why is
# the session stack's comment in image/Dockerfile.
set -euo pipefail

# The runtime dir must exist before dbus-run-session starts the bus.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
export DISPLAY="${DISPLAY:-:99}"
mkdir -m 700 -p "$XDG_RUNTIME_DIR"

# Wait (up to ~5 s) for a local TCP listener to accept; used for the
# VNC/noVNC readiness check. Bash-only (/dev/tcp), no extra tools.
wait_port() {
    local port="$1" i
    for i in $(seq 1 50); do
        if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

if [ "${1:-}" = "--desktop" ]; then
    Xvfb "$DISPLAY" -screen 0 "${MICKE_SCREEN:-1280x800x24}" >/tmp/xvfb.log 2>&1 &
    until [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; do sleep 0.1; done

    /usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &

    # DISPLAY + the D-Bus session are inherited from dbus-run-session above;
    # xfce4-session is the session leader that spawns the rest of the DE.
    xfce4-session >/tmp/xfce4.log 2>&1 &

    printf "export XDG_RUNTIME_DIR=%s DISPLAY=%s DBUS_SESSION_BUS_ADDRESS='%s'\n" \
        "$XDG_RUNTIME_DIR" "$DISPLAY" "${DBUS_SESSION_BUS_ADDRESS:-}" >/tmp/session.env
    chmod 600 /tmp/session.env

    # Remote view (non-fatal). Both listeners bind all interfaces inside
    # the sandbox on fixed ports; host exposure is the runtime's job
    # (rungv -p, recorded in the session pidfile).
    vnc_state="down" novnc_state="down"
    if command -v x11vnc >/dev/null 2>&1; then
        if [ -n "${MICKE_VNC_PASSWORD:-}" ]; then
            x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 \
                -passwd "$MICKE_VNC_PASSWORD" >/tmp/x11vnc.log 2>&1 &
        else
            x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 \
                -nopw >/tmp/x11vnc.log 2>&1 &
        fi
        if wait_port 5900; then vnc_state="up"; fi
    fi
    if command -v websockify >/dev/null 2>&1; then
        websockify --web /usr/share/novnc 6080 localhost:5900 \
            >/tmp/novnc.log 2>&1 &
        if wait_port 6080; then novnc_state="up"; fi
    fi

    echo "micke: desktop ready on $DISPLAY (${MICKE_SCREEN:-1280x800x24}), vnc :5900 $vnc_state, novnc :6080 $novnc_state (UI: http://<host>:6080/vnc.html)"
    exec sleep infinity
fi

exec dbus-run-session -- "$0" --desktop
