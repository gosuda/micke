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
    # No desktop settings daemon runs in this container, so Chromium needs
    # this to join the accessibility bus (agent-desktop docs, troubleshooting).
    ACCESSIBILITY_ENABLED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        # --- session stack -------------------------------------------------
        xvfb \
        openbox \
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

# The desktop session bootstrap: Xvfb + a11y bus + openbox + VNC/noVNC.
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
