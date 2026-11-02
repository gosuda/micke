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
# Point-of-use steering: three mission cycles show agents follow the envelope
# and the receipts but not the manual, so each known trap also gets ONE
# `micke:`-prefixed stderr line exactly where attention already is. stderr
# only — stdout (the envelope) and every exit code are unchanged.
#
# The real CLI lives under its own npm prefix (/opt/agent-desktop) so it keeps
# its symlinks and bundled native helper; AGENT_DESKTOP_REAL overrides it for
# tests.

real="${AGENT_DESKTOP_REAL:-/opt/agent-desktop/bin/agent-desktop}"

# First non-flag word of argv is the subcommand (global flags such as --headed
# may precede it). Used for the pre-execution warning only.
subcmd=""
for a in "$@"; do
    case "$a" in
        -*) ;;
        *) subcmd="$a"; break ;;
    esac
done

# press kills chromium only after the damage is done, so this warns BEFORE the
# call — and never blocks it.
if [ "$subcmd" = "press" ]; then
    echo "micke: warning: press can SIGSEGV chromium on this image (rc 139 kills the browser) — micke-key <combo> is the safe path; running your press anyway" >&2
fi

out=$("$real" "$@")
rc=$?
printf '%s\n' "$out"

ok=$(printf '%s' "$out" | jq -r 'if type == "object" then (.ok | tostring) else "na" end' 2>/dev/null) || ok=na

# ok:false — one remedy line for the refusals agents actually hit (headless
# type / set-value, find burning its budget on heavy pages). The envelope's
# own `command` field decides; argv is only the fallback when it is missing.
# Emitted before any exit: the real CLI reports some ok:false envelopes with
# rc 0 (find TIMEOUT) and others with rc!=0 (type POLICY_DENIED) — the hint
# must ride along on both.
if [ "$ok" = "false" ]; then
    cmd=$(printf '%s' "$out" | jq -r '.command // empty' 2>/dev/null) || cmd=""
    [ -n "$cmd" ] || cmd="$subcmd"
    code=$(printf '%s' "$out" | jq -r '.error.code // empty' 2>/dev/null) || code=""
    case "$cmd" in
        type|set-value)
            case "$code" in
                POLICY_DENIED|ACTION_NOT_SUPPORTED)
                    echo "micke: remedy: click the field, then micke-type '<text>' — or agent-desktop --headed type" >&2
                    ;;
            esac
            ;;
        find)
            echo "micke: hint: prefer micke-find <text> [--role R] (one filtered snapshot) — find spends its whole budget on heavy pages" >&2
            ;;
    esac
fi

[ "$rc" -ne 0 ] && exit "$rc"
[ "$ok" = "false" ] && exit 1
exit 0
