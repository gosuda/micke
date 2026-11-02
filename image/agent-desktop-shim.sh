#!/bin/sh
# agent-desktop shim — make the JSON envelope's `ok:false` a FAILURE in $?.
#
# agent-desktop reports application-level failures inside a successful process:
#   {"version":"2.5","ok":false,"error":{"code":"TIMEOUT",...}}   -> rc 0
# so any agent gating on `$?` (set -e, &&, ||) proceeds after a failure. This
# shim keeps stdout byte-identical (pipes into jq keep working) and maps
# `ok:false` to exit 1. Process-level non-zero codes pass through untouched.
#
# Non-JSON output (`version`, `--help`, plain text) leaves the exit code alone.
#
# The real CLI lives under its own npm prefix (/opt/agent-desktop) so it keeps
# its symlinks and bundled native helper; AGENT_DESKTOP_REAL overrides it for
# tests.

real="${AGENT_DESKTOP_REAL:-/opt/agent-desktop/bin/agent-desktop}"

out=$("$real" "$@")
rc=$?
printf '%s\n' "$out"
[ "$rc" -ne 0 ] && exit "$rc"

ok=$(printf '%s' "$out" | jq -r 'if type == "object" then (.ok | tostring) else "na" end' 2>/dev/null) || ok=na
[ "$ok" = "false" ] && exit 1
exit 0
