# micke — a desk for AI agents.
#
# A headless Linux desktop for agent-desktop
# (https://github.com/vercel-labs/agent-desktop), which drives desktop apps
# through the AT-SPI accessibility tree instead of pixel matching.
#
# Base: Debian 12 (bookworm) — glibc 2.36 clears agent-desktop's 2.35 floor,
# ships a real (non-snap) chromium package, and at-spi2-core 2.46 avoids the
# Ubuntu 22.04 ATK-bridge bug (aborts on Action.GetActions).

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
        # --- helpers -------------------------------------------------------
        # python3 is the in-guest shell listener (image/driver.sh): a core
        # dependency, not an accident of websockify's package graph.
        python3 \
        xdotool \
        xclip \
        jq \
        file \
        # --- agent-desktop CLI (npm >= 18; the package bundles the native
        #     binary and the agent-desktop-linux-clipboard-owner helper) ----
        nodejs \
        npm \
        ca-certificates \
        curl \
        fonts-dejavu-core \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g agent-desktop && agent-desktop version

# agent-desktop's state root (~/.agent-desktop, mode 0700) and the session
# bus are per-user; never run the desktop as root.
RUN groupadd -g "$GID" "$USERNAME" \
    && useradd -m -u "$UID" -g "$GID" -s /bin/bash "$USERNAME"

COPY image/entrypoint.sh /usr/local/bin/micke-entrypoint
RUN chmod 0755 /usr/local/bin/micke-entrypoint

# The ENTRYPOINT under gvx: boots micke-entrypoint as a child and serves the
# shell channel over TCP (gvx has no exec). `rungv -p 7801` forwards it.
COPY image/driver.sh /usr/local/bin/micke-driver
RUN chmod 0755 /usr/local/bin/micke-driver

# Preferred chromium launch path: flags pre-baked (see micke-chromium.sh).
COPY image/micke-chromium.sh /usr/local/bin/micke-chromium
RUN chmod 0755 /usr/local/bin/micke-chromium

USER $USERNAME
WORKDIR /home/$USERNAME

# Chromium needs >64MB of /dev/shm: micke runs with `-tmpfs /dev/shm:size=1g`.
ENTRYPOINT ["/usr/local/bin/micke-driver"]
