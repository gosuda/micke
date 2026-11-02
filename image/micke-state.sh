#!/bin/sh
# micke-state — one line of JSON describing the live chromium window.
#
# WHY: the cheap, honest answer to "did the click land / is the browser alive"
# is the window title, the address bar, and a ref count — not a PNG. A
# screenshot is evidence for a human; it is not an assertion, and nothing in
# the agent loop consumes the file. Two read-only a11y queries answer the
# question in ~2 s and write nothing.
#
# stdout (exactly one line, always):
#   {"alive":true,"title":"Npay 증권","url":"stock.naver.com","refs":547}
# title/url/refs are null when they cannot be obtained (a heavy page may hit
# the snapshot deadline; a missing title is not a dead browser).
# Exit 1 when no chromium window exists; stderr says why. Exit 0 otherwise.
#
# Ref count comes from ONE compact snapshot with a 2.4 s observation deadline,
# so it is a quick orientation signal (did the tree roughly double?) rather
# than a byte-exact assertion. Use `agent-desktop snapshot` directly when the
# actual tree matters.

set -u

emit_not_alive() {
    printf '%s\n' '{"alive":false,"title":null,"url":null,"refs":null}'
    echo "micke-state: $1" >&2
    exit 1
}

# One cheap call answers "is there a chromium window?" and gives the title.
wins=$(agent-desktop list-windows --app chromium 2>/dev/null) \
    || emit_not_alive "chromium is not running (list-windows failed)"
printf '%s' "$wins" | jq -e '(.data // []) | length > 0' >/dev/null 2>&1 \
    || emit_not_alive "chromium is running but exposes no window"

title=$(printf '%s' "$wins" | jq -r '(.data // []) | map(select(.title != null and .title != "")) | .[0].title // empty' 2>/dev/null) || title=""
# Window titles end in " - Chromium"; the app name is noise in a one-liner.
title=${title% - Chromium}

# One snapshot for the address bar and the ref count. On failure the browser
# is still alive, so keep title and null the rest instead of failing.
url=""
refs=""
snap=$(agent-desktop snapshot --app chromium -i --compact --timeout-ms 2400 2>/dev/null) || snap=""
if [ -n "$snap" ]; then
    url=$(printf '%s' "$snap" | jq -r '[.. | objects | select(.name? == "Address and search bar") | .value][] | select(. != null and . != "")' 2>/dev/null | head -n 1)
    refs=$(printf '%s' "$snap" | jq -r '.data.ref_count // empty' 2>/dev/null)
fi

jq -cn --arg t "$title" --arg u "$url" --arg r "$refs" '{
    alive: true,
    title: (if $t == "" then null else $t end),
    url: (if $u == "" then null else $u end),
    refs: (if $r == "" then null else ($r | tonumber?) end)
}'
