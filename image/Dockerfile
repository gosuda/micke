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
        # CJK pages (Korean/Japanese/Chinese) render as tofu boxes with only
        # the Latin fonts above; Noto CJK is Debian's package for them.
        fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Install under its own prefix: the real CLI keeps its npm symlinks and the
# bundled native helper, while /usr/local/bin/agent-desktop is the shim below.
RUN mkdir -p /opt/agent-desktop \
    && npm install -g --prefix /opt/agent-desktop agent-desktop \
    && /opt/agent-desktop/bin/agent-desktop version

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

# agent-desktop shim: `ok:false` in the JSON envelope becomes exit 1, so agents
# that gate on `$?` (set -e, &&) never proceed on a silent failure.
COPY image/agent-desktop-shim.sh /usr/local/bin/agent-desktop
RUN chmod 0755 /usr/local/bin/agent-desktop

# Content path for real pages (headless dump-dom -> small JSON). Interaction
# still goes through the AT-SPI tree; heavy pages time it out.
COPY image/page-text.sh /usr/local/bin/micke-page-text
COPY image/page_text.py /usr/local/lib/micke/page_text.py
RUN chmod 0755 /usr/local/bin/micke-page-text && chmod 0644 /usr/local/lib/micke/page_text.py

# Cheap verification channel: one line of JSON (alive/title/url/refs) from the
# a11y tree, so "did the click land?" never has to cost a screenshot.
COPY image/micke-state.sh /usr/local/bin/micke-state
RUN chmod 0755 /usr/local/bin/micke-state

# Safe key path: `agent-desktop press` SIGSEGVs chromium on this image (its
# AT-SPI DeviceEventController path); xdotool key --clearmodifiers delivers
# the same X events without killing the browser.
COPY image/micke-key /usr/local/bin/micke-key
RUN chmod 0755 /usr/local/bin/micke-key

# Text path: `agent-desktop type` is refused by real pages (ACTION_NOT_SUPPORTED
# on search containers, POLICY_DENIED on textfields); xclip daemon-mode +
# micke-key's ctrl+v delivers it.
COPY image/micke-type /usr/local/bin/micke-type
RUN chmod 0755 /usr/local/bin/micke-type

# Find a click target by name WITHOUT `agent-desktop find`, which needs two
# stable passes of a mutating tree and spends its whole budget. One compact
# snapshot plus a guest-side jq filter; retries only on truncated:true.
COPY image/micke-find /usr/local/bin/micke-find
RUN chmod 0755 /usr/local/bin/micke-find

# In-guest manual page: the desktop loop recipe + one line per helper.
# agent-desktop's skills are compiled into its binary (location "embedded"),
# so they cannot advertise the micke helpers — this is the in-guest entry
# point the session_shell description points at.
COPY image/micke-help /usr/local/bin/micke-help
RUN chmod 0755 /usr/local/bin/micke-help

USER $USERNAME
WORKDIR /home/$USERNAME

# Chromium needs >64MB of /dev/shm. Under gvx it defaults to half of host
# RAM; micke adds no tmpfs flag (explicit mounts at/below /dev are refused).
ENTRYPOINT ["/usr/local/bin/micke-driver"]
