# micke: flags chromium needs inside the gVisor sandbox, applied through the
# stock Debian mechanism — /usr/bin/chromium is a shell wrapper that sources
# every /etc/chromium.d/* fragment into CHROMIUM_FLAGS before exec'ing the
# real binary. Baking them here makes EVERY launch route correct:
# `agent-desktop launch chromium --arg=<url>` (launch resolves the desktop
# file's Exec= program, this wrapper, over PATH), the menu entry, or a bare
# `chromium <url>` from a shell.
#
# --no-sandbox: chromium's own sandbox cannot start under gVisor (no user
#   namespaces); launched raw it exits immediately.
# --force-renderer-accessibility: expose the renderer accessibility tree
#   AT-SPI carries; without it agent-desktop snapshots contain no refs.
export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --force-renderer-accessibility"
