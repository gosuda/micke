# micke — a desk for AI agents.
#
# A headless Linux desktop for agent-desktop
# (https://github.com/vercel-labs/agent-desktop), which drives desktop apps
# through the AT-SPI accessibility tree instead of pixel matching.
#
# Base: Debian 12 (bookworm) — glibc 2.36 clears agent-desktop's 2.35 floor,
# ships a real (non-snap) chromium package, and at-spi2-core 2.46 avoids the
# Ubuntu 22.04 ATK-bridge bug (aborts on Action.GetActions).
#
# The agent-facing surface is STOCK: Debian's chromium, the stock
# agent-desktop CLI, nothing micke-specific on PATH. micke ships only infra
# (micke-entrypoint, micke-driver) and one /etc/chromium.d fragment baking in
# the flags chromium needs inside the sandbox, so the sanctioned URL route —
# `agent-desktop launch chromium --arg=<url>` — starts a browser that is both
# alive (--no-sandbox) and drivable (--force-renderer-accessibility) with no
# wrapper script in between.

FROM debian:bookworm-slim

ARG USERNAME=agent
ARG UID=1000
ARG GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/xdg-runtime \
    # Chromium's GTK layer looks at ACCESSIBILITY_ENABLED to join the a11y
    # bus (agent-desktop docs, troubleshooting). Kept even though the XFCE
    # session now runs xfsettingsd: the env var is deterministic at every
    # launch route, whatever the settings daemon did or didn't set yet.
    ACCESSIBILITY_ENABLED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        # --- session stack -------------------------------------------------
        xvfb \
        # Minimal XFCE desktop, replacing openbox (a9f9508 ran openbox):
        #   - GTK3, so apps register on AT-SPI natively — same toolkit
        #     family as chromium, the best agent-desktop compatibility.
        #   - xfwm4 is EWMH-compliant: agent-desktop's list-windows /
        #     focus-window need a real EWMH WM (openbox was minimal EWMH
        #     too, but gave no panel/desktop for human takeover).
        #   - xfce4-notifyd gives desktop notifications somewhere to be
        #     displayed: apps can post them and a human sees them over
        #     noVNC (with openbox they went nowhere). agent-desktop's own
        #     list-notifications is GNOME-Shell-only on Linux and returns
        #     PLATFORM_NOT_SUPPORTED here — an upstream attribution policy
        #     (it refuses any notification daemon the detected shell
        #     doesn't own), not a dead daemon.
        #   - xfce4-terminal + thunar are for human takeover over noVNC
        #     (SSO login flows, see docs/manual-intervention.md).
        # Deliberately NOT installed: the xfce4 metapackage (drag in
        # artwork/power/pulse extras) and gvfs (thunar degrades gracefully
        # without it: no trash/network volumes — irrelevant headless).
        xfce4-session \
        xfwm4 \
        xfce4-panel \
        xfce4-settings \
        xfdesktop4 \
        xfce4-notifyd \
        xfce4-terminal \
        thunar \
        dbus \
        dbus-x11 \
        at-spi2-core \
        # --- agent apps ----------------------------------------------------
        chromium \
        # --- remote view: x11vnc mirrors the Xvfb display on :5900,
        #     websockify serves the noVNC web client on :6080 ---------------
        x11vnc \
        novnc \
        websockify \
        # --- infra ----------------------------------------------------------
        # python3 is the in-guest shell listener (image/driver.sh): a core
        # dependency, not an accident of websockify's package graph. jq is
        # stock shell-toolbox, kept for one-line JSON handling in sessions.
        python3 \
        jq \
        # --- agent-desktop CLI (npm >= 18; the package bundles the native
        #     binary and the agent-desktop-linux-clipboard-owner helper) ----
        nodejs \
        npm \
        ca-certificates \
        curl \
        fonts-dejavu-core \
        fonts-liberation \
        # CJK pages (Korean/Japanese/Chinese) render as tofu boxes with only
        # the Latin fonts above; Noto CJK is Debian's package for them.
        fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Stock agent-desktop CLI, pinned (dist-tag latest at the time of writing).
# Plain npm -g puts the real CLI — its symlinks and bundled native helper
# intact — at /usr/local/bin/agent-desktop. The `version` call is the
# post-install sanity check.
RUN npm install -g agent-desktop@1.2.0 && agent-desktop version

# agent-desktop's state root (~/.agent-desktop, mode 0700) and the session
# bus are per-user; never run the desktop as root.
RUN groupadd -g "$GID" "$USERNAME" \
    && useradd -m -u "$UID" -g "$GID" -s /bin/bash "$USERNAME"

# Bake the sandbox-required chromium flags via Debian's own mechanism: the
# /usr/bin/chromium wrapper sources /etc/chromium.d/* into CHROMIUM_FLAGS
# before exec'ing the real binary, and agent-desktop launch runs that wrapper
# (it resolves the desktop file's Exec= program over PATH), so the flags ride
# along on every launch. See image/chromium-flags.sh for what and why.
COPY image/chromium-flags.sh /etc/chromium.d/00-micke.sh

# xfwm4 compositing OFF, baked as a system-wide xfconf default (the user
# account has no ~/.config/xfce4 yet, so the seeded channel file wins).
# Compositing is meaningless under Xvfb and costs CPU. Applied by xfconf's
# per-channel default lookup on the first read of the xfwm4 channel.
COPY image/xfwm4.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml

# The desktop session bootstrap: Xvfb + a11y bus + XFCE session + VNC/noVNC.
COPY image/entrypoint.sh /usr/local/bin/micke-entrypoint
RUN chmod 0755 /usr/local/bin/micke-entrypoint

# The ENTRYPOINT under gvx: boots micke-entrypoint as a child and serves the
# shell channel over TCP (gvx has no exec). `rungv -p 7801` forwards it.
COPY image/driver.sh /usr/local/bin/micke-driver
RUN chmod 0755 /usr/local/bin/micke-driver

USER $USERNAME
WORKDIR /home/$USERNAME

# Chromium needs >64MB of /dev/shm. Under gvx it defaults to half of host
# RAM; micke adds no tmpfs flag (explicit mounts at/below /dev are refused).
ENTRYPOINT ["/usr/local/bin/micke-driver"]
