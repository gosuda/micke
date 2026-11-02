#!/bin/sh
# micke-chromium — open chromium in a micke session, required flags pre-baked.
#
# Why a wrapper: chromium inside the micke container needs --no-sandbox (the
# container has no user namespaces for chromium's own sandbox) and
# --force-renderer-accessibility (expose the AT-SPI tree agent-desktop
# drives). Launched raw without them, chromium either exits immediately or
# snapshots come back with no refs to click. Baking the flags in here makes
# the correct launch the path of least resistance.
#
# Usage:
#   micke-chromium                       # about:blank
#   micke-chromium https://example.com   # ...at a URL
#   micke-chromium URL --arg=<flag> ...  # ...plus extra chromium flags,
#                                        #   e.g. --arg=--load-extension=/tmp/x
#
# The session shell auto-sources /tmp/session.env, so this works directly
# from session_shell. See docs/chromium-flags.md for the driving loop.

set -eu

url=""
case "${1:-}" in
    ""|--arg=*) ;;        # no URL given (bare call, or flags come first)
    *) url="$1"; shift ;; # first non --arg= word is the URL
esac

exec agent-desktop launch chromium \
    --arg=--no-sandbox \
    --arg=--force-renderer-accessibility \
    ${url:+"--arg=$url"} \
    "$@"
