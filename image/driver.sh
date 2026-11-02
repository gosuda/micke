#!/usr/bin/env bash
# micke guest driver — the image ENTRYPOINT under gvx.
#
# gvx has no exec and no detached containers: this process IS the sandbox's
# lifetime, and the shell channel is a TCP listener inside the guest (reached
# through `rungv -p`). It:
#
#   1. writes the per-connection bash handler (/tmp/handler.sh) — the
#      `__micke_run` framing wrapper, byte-equal to the old exec-channel INIT;
#   2. starts a supervised python3 TCP listener on ${MICKE_SHELL_PORT} (7801);
#      every connection gets a fresh bash (exec-channel semantics: cwd/env reset);
#   3. boots the desktop by running the real /usr/local/bin/micke-entrypoint as
#      a child (it re-execs itself under dbus-run-session);
#   4. waits for /tmp/session.env AND the noVNC port, then emits the ready line
#      the supervisor gates session_create on;
#   5. exits if either the desktop or the listener supervisor dies, so a dead
#      sandbox is an honest dead pidfile — never a half-live black hole.
#
# stdin is NEVER read: the TCP socket is the only shell channel.
set -u

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -m 700 -p "$XDG_RUNTIME_DIR" 2>/dev/null || true

SHELL_PORT="${MICKE_SHELL_PORT:-7801}"
export MICKE_SHELL_PORT="$SHELL_PORT"

# ---- handler.sh: per-connection bash (the old shell.ts INIT) ----------------
cat >/tmp/handler.sh <<'HANDLER_EOF'
__micke_after() {
    # $1 = rc of the evaluated command; idempotent (first rc wins)
    if [ ! -s "$rcfile" ]; then printf '%s' "$1" > "$rcfile"; fi
    printf '%s' "$PWD" > "$dfile"
    export -p | sort > "$after"
}
__micke_sig() { __micke_after "$1"; exit "$1"; }
__micke_run() {
    # $1 = timeout_ms (0 = none), $2 = max_output_bytes per stream, $3 = base64 command
    local tmo="$1" limit="$2" b64="$3"
    local cmd out err rc before after dfile rcfile flag cpid wpid osz esz
    cmd="$(printf '%s' "$b64" | base64 -d)"
    out="$(mktemp /tmp/.micke-out.XXXXXX)"
    err="$(mktemp /tmp/.micke-err.XXXXXX)"
    before="$(mktemp /tmp/.micke-env.XXXXXX)"
    after="$(mktemp /tmp/.micke-env2.XXXXXX)"
    dfile="$(mktemp /tmp/.micke-dir.XXXXXX)"
    rcfile="$(mktemp /tmp/.micke-rc.XXXXXX)"
    flag="$(mktemp /tmp/.micke-flag.XXXXXX)"
    export -p | sort > "$before"
    printf '===BEGIN===\n'
    (
        trap '__micke_sig 143' TERM
        trap '__micke_sig 130' INT
        trap '__micke_sig 129' HUP
        trap '__micke_after $?' EXIT
        eval "$cmd"
        __micke_after $?
    ) > "$out" 2> "$err" < /dev/null &
    cpid=$!
    wpid=""
    if [ "$tmo" -gt 0 ] 2>/dev/null; then
        local secs="$((tmo / 1000)).$(printf '%03d' $((tmo % 1000)))"
        (
            sleep "$secs"
            if [ ! -s "$rcfile" ]; then
                printf '1' > "$flag"
                kill -TERM -- "-$cpid" 2>/dev/null
                sleep 2
                kill -KILL -- "-$cpid" 2>/dev/null
            fi
        ) &
        wpid=$!
    fi
    wait "$cpid"; rc=$?
    if [ -n "$wpid" ]; then kill -TERM -- "-$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null; fi
    if [ -s "$rcfile" ]; then rc="$(cat "$rcfile")"; fi
    osz=$(wc -c < "$out"); esz=$(wc -c < "$err")
    if [ "$osz" -gt "$limit" ]; then
        head -c "$limit" "$out"; printf '\n…[truncated %s bytes]\n' "$((osz - limit))"
    else
        cat "$out"
    fi
    printf '\n===STDERR===\n'
    if [ "$esz" -gt "$limit" ]; then
        head -c "$limit" "$err"; printf '\n…[truncated %s bytes]\n' "$((esz - limit))"
    else
        cat "$err"
    fi
    if [ -s "$flag" ]; then printf '\n===TIMEOUT===\n'; fi
    printf '\n===END rc=%s===\n' "$rc"
    # Persist cwd + exported env, but only if the command completed (not killed)
    if [ -s "$rcfile" ] && [ -s "$dfile" ] && [ -s "$after" ] && [ ! -s "$flag" ]; then
        while read -r n; do
            case "$n" in ''|*[!A-Za-z0-9_]*|PWD|OLDPWD|SHLVL|_) continue ;; esac
            unset "$n" 2>/dev/null || true
        done < <(comm -23 "$before" "$after" | sed 's/^declare -[^ ]* \([^=]*\)=.*/\1/')
        while IFS= read -r l; do
            eval "$(printf '%s' "$l" | sed 's/^declare -x /declare -gx /')" 2>/dev/null || true
        done < <(comm -13 "$before" "$after" | grep -v -e 'PWD=' -e 'OLDPWD=' -e 'SHLVL=' -e '^[^ ]* _=')
        cd -- "$(cat "$dfile")" 2>/dev/null || true
    fi
    rm -f "$out" "$err" "$before" "$after" "$dfile" "$rcfile" "$flag"
}
# Desktop env (DISPLAY/D-Bus/AT-SPI) is published by the entrypoint; wait for it
# so agent-desktop works with no manual setup.
i=0
while [ "$i" -lt 100 ] && [ ! -f /tmp/session.env ]; do sleep 0.1; i=$((i+1)); done
. /tmp/session.env 2>/dev/null || true
set -m 2>/dev/null || true
echo '===SHELL_READY==='
# Serve one request line per command until the connection closes.
while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    eval "$line"
done
exit 0
HANDLER_EOF

# ---- server.py: TCP listener, fork+dup2+exec bash per connection -----------
cat >/tmp/server.py <<'SERVER_EOF'
import os, socket, sys
port = int(os.environ.get("MICKE_SHELL_PORT", "7801"))
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", port))
srv.listen(16)
sys.stderr.write("socket-driver: listening on 0.0.0.0:%d\n" % port)
sys.stderr.flush()
while True:
    c, addr = srv.accept()
    sys.stderr.write("socket-driver: conn from %s:%s\n" % addr)
    sys.stderr.flush()
    pid = os.fork()
    if pid == 0:
        srv.close()
        os.dup2(c.fileno(), 0)
        os.dup2(c.fileno(), 1)
        c.close()
        os.execv("/bin/bash", ["bash", "/tmp/handler.sh"])
        os._exit(127)
    c.close()
    while True:  # reap finished handlers (no zombies across connections)
        try:
            wp, _ = os.waitpid(-1, os.WNOHANG)
            if wp == 0:
                break
        except ChildProcessError:
            break
SERVER_EOF

# Wait (up to ~5 s) for a local TCP listener to accept; bash-only, no tools.
wait_port() {
    local port="$1" i
    for i in $(seq 1 50); do
        if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

# ---- supervised listener (the channel's SPOF) ------------------------------
# A human may have logged in over noVNC; a python blip must not destroy that
# desktop. Respawn, but never crash-burn: 10 crashes in 60 s kills the sandbox
# so the supervisor sees an honest dead pidfile.
listener_supervisor() {
    local crashes=0 window_start now rc
    window_start=$(date +%s)
    while :; do
        python3 /tmp/server.py
        rc=$?
        now=$(date +%s)
        if [ $((now - window_start)) -ge 60 ]; then
            crashes=0
            window_start=$now
        fi
        crashes=$((crashes + 1))
        echo "socket-driver: listener exited rc=$rc, respawning ($crashes/10 in 60s)" >&2
        if [ "$crashes" -ge 10 ]; then
            echo "socket-driver: listener crash loop, exiting" >&2
            exit 1
        fi
        sleep 0.5
    done
}
listener_supervisor &
listener_pid=$!

# ---- boot the desktop via the real image entrypoint (as a child) -----------
/usr/local/bin/micke-entrypoint >/tmp/entrypoint.log 2>&1 &
entry_pid=$!

i=0
while [ "$i" -lt 300 ] && [ ! -f /tmp/session.env ]; do sleep 0.1; i=$((i+1)); done
if [ ! -f /tmp/session.env ]; then
    echo "socket-driver: /tmp/session.env not published within 30 s (see /tmp/entrypoint.log)" >&2
    kill "$listener_pid" "$entry_pid" 2>/dev/null || true
    exit 1
fi

if ! wait_port "$SHELL_PORT"; then
    echo "socket-driver: shell listener :$SHELL_PORT not up (see listener log above)" >&2
    kill "$listener_pid" "$entry_pid" 2>/dev/null || true
    exit 1
fi
if wait_port 6080; then
    novnc_state="up"
else
    novnc_state="down"
fi
echo "micke: desktop ready on ${DISPLAY:-:99} (${MICKE_SCREEN:-1280x800x24}), shell tcp :${SHELL_PORT}, novnc :6080 ${novnc_state}" >&2

# Either death ends the sandbox: a listener crash loop or a dead desktop must
# never leave a pidfile pointing at a half-live session.
while kill -0 "$listener_pid" 2>/dev/null && kill -0 "$entry_pid" 2>/dev/null; do
    sleep 1
done
echo "socket-driver: desktop or listener exited; stopping sandbox" >&2
kill "$listener_pid" "$entry_pid" 2>/dev/null || true
exit 1
