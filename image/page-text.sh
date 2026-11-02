#!/bin/sh
# micke-page-text — read a web page as small JSON, without the AT-SPI tree.
#
# The a11y tree is the INTERACTION path (click/type/snapshot). For CONTENT it
# is the wrong tool: real pages blow the traversal budget and come back as
# TIMEOUT / locator_incomplete. This renders the page with headless chromium in
# a throwaway profile and extracts text + links with stdlib python3, so the
# 2 MB DOM never crosses the session_shell output cap.
#
# Runs beside a GUI chromium on :99 — the separate --user-data-dir is what
# keeps chromium from attaching to (and disturbing) it.
#
# Usage:
#   micke-page-text <url>                 # {url,title,text,chars,truncated}
#   micke-page-text <url> --links         # ...plus [{text,href}, ...]
#   micke-page-text <url> --max-chars 5000 --pretty
#
# See docs/chromium-flags.md ("Content vs. interaction").

set -eu

usage() {
    sed -n '12,19p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

case "${1:-}" in
    -h|--help) usage ;;
    ""|-*) usage >&2; exit 2 ;;
esac

url="$1"; shift

prof=$(mktemp -d "${TMPDIR:-/tmp}/micke-page-text.XXXXXX")
dom=$(mktemp "${TMPDIR:-/tmp}/micke-page-dom.XXXXXX")
trap 'rm -rf "$prof" "$dom"' EXIT INT TERM

if ! chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
        --no-first-run --no-default-browser-check --disable-extensions \
        --user-data-dir="$prof" --virtual-time-budget=8000 \
        --dump-dom "$url" >"$dom" 2>"$prof/chromium.log"; then
    echo "micke-page-text: chromium failed for $url" >&2
    tail -n 20 "$prof/chromium.log" >&2 || true
    exit 2
fi

if [ ! -s "$dom" ]; then
    echo "micke-page-text: empty DOM for $url (network or TLS failure?)" >&2
    tail -n 20 "$prof/chromium.log" >&2 || true
    exit 2
fi

exec python3 "${MICKE_PAGE_TEXT_PY:-/usr/local/lib/micke/page_text.py}" \
    --html "$dom" --url "$url" "$@"
