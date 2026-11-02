# micke server internals (M-min, gvx-only)

The supervisor + MCP daemon: one process, exactly four tools, MCP over
stateless Streamable HTTP. Stack: Bun + TypeScript (no build step), single
runtime dependency (`@modelcontextprotocol/sdk`); gvx is driven by shelling out
to the `rungv` CLI. The same process serves the static session dashboard on the
same loopback port (see below).

For how to run it, see the root [README.md](../README.md).

Requirements: Linux x86_64 or arm64 (the published image is multi-arch:
`linux/amd64` + `linux/arm64`) with `rungv` v0.4.x on `PATH`, and the micke
image in gvx's cache (`rungv pull -cache-dir ~/.cache/micke/gvx
ghcr.io/gosuda/micke:latest`). Docker is **not** a runtime dependency.

Environment:

| Variable                   | Default                          | Meaning                                    |
| :--                        | :--                              | :--                                        |
| `MICKE_IMAGE`              | `ghcr.io/gosuda/micke:latest`    | Default image for `session_create`         |
| `MICKE_GVX_CACHE`          | `$XDG_CACHE_HOME/micke/gvx` (`~/.cache/micke/gvx`) | EROFS layer cache (`-cache-dir` on image/run calls) |
| `MICKE_RUNGV`              | `rungv`                          | rungv binary path                          |
| `MICKE_STATE_DIR`          | `$XDG_STATE_HOME/micke` (`~/.local/state/micke`) | Pidfiles, per-session logs, instance lock  |
| `MICKE_SESSION_MEMORY`     | `2g`                             | Per-sandbox `rungv -m` guard               |
| `MICKE_BOOT_TIMEOUT_MS`    | `30000`                          | Wait for the driver's `micke: desktop ready` line |
| `MICKE_MIN_FREE_MB`        | `1024`                           | Free-RAM floor: refuse `session_create` when `MemAvailable` is below this many MiB (0 disables) |
| `MICKE_GUEST_UID`          | `1000`                           | Guest uid used for the `/workspace` writability check |
| `MICKE_GUEST_GID`          | `1000`                           | Guest gid used for the `/workspace` writability check |
| `MICKE_PORT`               | `7800`                           | Daemon port on 127.0.0.1 — MCP + dashboard (`0` = kernel-picked) |
| `MICKE_VNC_PASSWORD`       | unset                            | Optional classic-VNC password passed into the sandbox |

## Session state (the pidfile is the identity)

gvx has no labels, no `ps`, and no daemon state. A session is ONE foreground
`rungv run` child; everything micke knows about it is written atomically to:

```
<state dir>/
├── supervisor.lock                  flock
└── sessions/
    ├── <id>.json                    { session_id, rungv_pid, hostname,
    │                                  shell_host_port, novnc_host_port,
    │                                  image, workspace, screen, created_at }
    └── <id>.log                     child stdout+stderr (truncated at start)
```

The log is a **file**, not a pipe: a sandbox must survive daemon death, and a
pipe whose reader died would make the guest's next log write kill its listener.
The file also keeps boot/port/ready parsing working after a crash and gives
post-mortem diagnostics.

## Instance lock

One supervisor per state dir: `Supervisor.start()` flocks
`<state dir>/supervisor.lock` (via `flock(2)`; the kernel releases it when the
process dies, so a crashed supervisor never leaves a stale lock). A second
instance retries for 1.5 s (restart race), then exits promptly with
`{"code":"LOCK_HELD", ...}` on stderr. The lock is scoped to the state dir
because that — pidfiles plus their sandboxes — is the shared state two
supervisors would corrupt.

## Guards on create

`session_create` validates cheaply first (screen, workspace existence and
guest writability, RAM floor, rungv binary), then runs the whole pull+boot
phase under one in-process mutex: **never two pulls, never a pull beside a live
session** (missing image + live session → `IMAGE_MISSING`), and concurrent
creates of a missing image wait for one pull and then all proceed. gvx has no
uid mapping, so an explicit workspace whose mode the guest (uid 1000) cannot
write is rejected with `WORKSPACE_NOT_WRITABLE` and a `chmod -R a+w` hint; the
auto-created workspace is chmod 0777. A gvx pull compiles layers in memory,
so this lock is the OOM-avoidance mechanism, not merely hygiene. The free-RAM
floor reads `MemAvailable` from `/proc/meminfo` (non-Linux hosts fail open) and refuses with
`INSUFFICIENT_MEMORY` below `MICKE_MIN_FREE_MB`.

## HTTP surface (transport)

One `Bun.serve` on `127.0.0.1:$MICKE_PORT` (default 7800; `0` =
kernel-picked), started AFTER the instance lock (flock first, then bind — a
second micke with a different state dir loses the port race, not the lock):

| Route | Method | Behavior |
| :-- | :-- | :-- |
| `/mcp` | POST | Stateless MCP: a **fresh** `WebStandardStreamableHTTPServerTransport` + fresh `Server` per request (the SDK forbids reusing a stateless transport; per-request instances carry zero cross-request state). JSON responses, no SSE — a tools-only server has no server-initiated messages. |
| `/mcp` | other | `405` with `Allow: POST`. GET is never delegated to the transport (stateless mode has no SSE stream; a GET would hang open). Clients treat the 405 as expected. |
| `/` | GET | The dashboard (below). |
| other | any | `404 not found`. |

Requests carrying an `Origin` header are answered `403` unless it is
`http://127.0.0.1:<port>` or `http://localhost:<port>` — the loopback bind
plus this check are the whole DNS-rebinding defense (browsers always send
`Origin` on cross-origin POSTs; MCP clients send none). A bind failure is
fatal: the port IS the product, so the daemon exits 1 with
`{"code":"PORT_HELD", ...}` on stderr naming the port. Request bodies are
capped at 4 MiB by the transport (answered 413); response bodies are not
capped. Clients come and go freely — a disconnect is a dropped TCP
connection; sessions live in the supervisor, keyed by micke session id, never
by client. Startup prints one parseable stderr line:
`micke: daemon at http://127.0.0.1:<port>/ (mcp: POST /mcp)`.

## Dashboard

The daemon serves ONE static route on `/`: a no-JS HTML table — one row per
session: id, status, uptime, noVNC link (orphaned rows included, but only
ready rows carry a link) — auto-refreshed by
`<meta http-equiv="refresh" content="5">`. localhost-only bind is a security
property; sharing beyond localhost is unsupported. Stdout
stays clean; the dashboard never logs to it.

On SIGINT/SIGTERM the daemon stops the HTTP server and kills all shell
channels; **rungv sandboxes stay alive** and the next start adopts them (their
pidfiles carry the pids and ports). stdin is not a shutdown trigger — the
daemon is meant to run under a service manager (systemd, launchd, or similar).

## The four tools

| Tool             | Input                                            | Returns |
| :--              | :--                                              | :--     |
| `session_create` | `{image?, workspace?, screen?}`                  | `{session_id, status: "ready", novnc_url, rungv_pid, hostname, image, workspace, screen, …}` |
| `session_list`   | `{}`                                             | `{sessions: […]}` — ready rows carry `novnc_url`; a pidfile whose sandbox is gone appears as `status: "orphaned"` |
| `session_close`  | `{session_id}`                                   | `{closed, sandbox_removed}` — also reaps orphans |
| `session_shell`  | `{session_id, command, timeout_ms?, max_output_bytes?}` | `{session_id, stdout, stderr, rc, timed_out, truncated, duration_ms}` |

All failures return one JSON error shape as MCP tool errors:
`{code, message, hint}` — codes: `IMAGE_MISSING`, `WORKSPACE_INVALID`,
`SCREEN_INVALID`, `DESKTOP_BOOT_TIMEOUT`, `RUNGV_UNAVAILABLE`, `GVX_ERROR`,
`SESSION_NOT_FOUND`, `SESSION_ORPHANED`, `SHELL_UNAVAILABLE`, `BAD_ARGUMENT`,
`INSUFFICIENT_MEMORY`, `UNKNOWN_TOOL`, plus `INTERNAL` as the catch-all for
unexpected (non-Micke) exceptions; fatal startup failures exit the process
with `LOCK_HELD` (second supervisor on the same state dir) or `PORT_HELD`
(daemon port already bound) on stderr.

## Sandbox lifecycle

`session_create` spawns:

```
rungv run -cache-dir <cache> -pull=never \
  -h micke-<id> -m <MICKE_SESSION_MEMORY, default 2g> \
  -e MICKE_SCREEN=<screen> -e MICKE_SHELL_PORT=7801 \
  -p 7801 -p 6080 \
  [-e MICKE_VNC_PASSWORD] [-v <host dir>:/workspace] \
  <image>
```

There is no `-d`, no `--init`, and no `--entrypoint` override: the image
entrypoint **is** `micke-driver` (`image/driver.sh`), and gvisor's Sentry is
the guest PID 1/reaper. `rungv` pre-binds both host ports before guest start
and prints `rungv: publishing 127.0.0.1:<host> -> <guest>/tcp`; the supervisor
polls the session log for those lines and persists them in the pidfile. It then
waits for the driver's `micke: desktop ready` line. That line is emitted only
after `/tmp/session.env` exists and the shell listener is dialable; noVNC is
probed and reported up/down, but does not gate readiness.

`/dev/shm`: gvx defaults it to half of host RAM (large enough for chromium);
`rungv` (v0.4.x) refuses explicit tmpfs mounts at or below `/dev`, so micke
does not add one. The `-m` value is a **polling guard**, not cgroups: a sandbox
that exceeds it exits with 137 mid-task and shows up as a dead pidfile.

**Daemon death does not kill sandboxes.** `rungv` has no parent-death
semantics, so the child is reparented and keeps the desktop, its windows, and
any human noVNC login alive. On the next `Supervisor.start()`, every pidfile is
a candidate:

- `/proc` (or `ps`) says the pid is alive **and** its command line is
  `rungv … micke-<id>` → register as **ready**, with the ports from the file.
  `session_shell` opens a fresh TCP connection to the still-booted desktop.
- Otherwise → list as **orphaned** (pidfile present, sandbox gone);
  `session_close` reaps the pidfile.

`session_close` kills the shell socket, sends SIGTERM to the rungv pid,
escalates to SIGKILL after ~3 s, waits for the whole process tree to vanish
(measured ~0.1 s, zero strays), then deletes the pidfile and log.

## Shell channel protocol

One TCP connection per session, opened lazily on the first `session_shell` and
held for the session's life. The guest driver forks **one bash per
connection**; a dropped connection is therefore recoverable (the next call
reconnects with a fresh shell, cwd/env reset — exec parity), while the
desktop keeps running.

At connection start the guest bash waits for and sources `/tmp/session.env`
(DISPLAY and the D-Bus session bus; AT-SPI is discovered through it) — so
`agent-desktop` works with no manual env setup — enables `set -m`, defines
`__micke_run`, and prints `===SHELL_READY===`.
Commands are base64-encoded so newlines are safe; the host writes one request
line and parses one frame back:

```
host -> guest:  __micke_run <timeout_ms> <max_output_bytes> <base64-command>\n
guest -> host:
  ===BEGIN===\n
  <stdout bytes>\n===STDERR===\n
  <stderr bytes>\n[===TIMEOUT===\n]\n===END rc=N===\n
```

The `\n` before each marker that follows a payload is always printed, so
stdout/stderr are byte-exact (a stream's trailing newline, or lack of one,
survives the round trip). The first `\n===STDERR===\n` separates the streams;
`===END rc=N===` is the exact verified end pattern. Output beyond
`max_output_bytes` (default 256 KiB) per stream is cut by the wrapper and ends
with `…[truncated N bytes]` (N = dropped bytes); the host re-checks the cap
defensively.

Mechanics inside the wrapper (baked into the image at `/tmp/handler.sh`):

- The command runs via `eval` inside a **background subshell**, which `set -m`
  puts in its **own process group**, with stdout/stderr redirected to temp
  files and stdin from `/dev/null`. After `eval` returns (or the subshell
  exits/signals), the wrapper cats the files back between the markers.
- **Timeout**: a watchdog subshell `( sleep T; kill -TERM -- -CPID; sleep 2; kill -KILL -- -CPID ) &`
  kills exactly the command's process group (TERM, then KILL after a 2 s
  grace for commands that trap/ignore TERM). The persistent bash is in a
  different process group and survives; the next command works normally.
  On timeout the frame carries `===TIMEOUT===` and `rc` is 143 (TERM) or 137
  (KILL). The watchdog itself runs in its own group and is killed after the
  command completes, so fast commands leak no sleeping watchdogs.
- **Persistence**: before the command the wrapper snapshots `export -p`; the
  subshell re-dumps it (plus `pwd`) on normal exit or `exit N`. The wrapper
  diffs the two (added/changed → `declare -gx`, removed → `unset`) and `cd`s to
  the new directory. So **cwd and exported env persist across calls within one
  connection**, and `unset` persists. Non-exported shell variables,
  function/alias definitions, and shell options do not persist. A timed-out
  (killed) command persists nothing — its partial state changes are
  deliberately discarded.
- **Semantics of children**: background jobs started by a command get their own
  process groups (via `set -m`) and survive that command's completion; they die
  with the sandbox on `session_close` (the rungv process tree is killed). A
  timeout kills the command's own process group — children that escaped into
  their own session/group (e.g. `setsid …`) survive it (a known, deferred
  edge case).
- **Known framing edge**: command output that itself contains a line matching a
  marker (`===STDERR===`, `===END rc=N===`, …) can confuse the parser. Don't
  `echo '===END rc=0==='` from commands.
- The channel is strictly serialized (one in-flight command per session). The
  host hard-aborts (and kills the channel) if no frame arrives within
  `max(timeout_ms, 1 s) + 15 s` (the guest watchdog should fire first; the
  backstop covers a channel gone silent). Unlike the old exec channel, a dead
  socket is **self-healing**: the next `session_shell` reconnects and resets
  cwd/env.
- The listener is supervised in the guest (respawn, 10 crashes in 60 s →
  sandbox exits). The channel dies with `session_close`; the sandbox does not
  survive it.

## Tests

All end-to-end against real gvx on this host; every suite spawns the real
daemon as a subprocess on a kernel-picked port (`MICKE_PORT=0`) and talks MCP
over Streamable HTTP (`tests/helpers.ts`). The shared image comes from
`MICKE_TEST_IMAGE` (else `MICKE_IMAGE`; default
`ghcr.io/gosuda/micke:latest`) and is pulled once into `MICKE_TEST_CACHE_DIR`
(else `MICKE_GVX_CACHE`, else the default cache) if missing:

- `bun test tests/mmin-phase1.test.ts` — daemon over HTTP, create → noVNC
  HTTP 200, `agent-desktop` status/launch/wait/snapshot, shell persistence,
  output cap, timeout kill, dropped-channel reconnect (fresh shell), workspace bind, close teardown, structured errors,
  and the **adoption proof** (SIGKILL the daemon, restart, session is `ready`,
  a fresh shell re-attaches, the pre-crash chromium window is still there).
- `bun test tests/mmin-phase2.test.ts` — guards + dashboard: instance lock
  (second supervisor exits with `LOCK_HELD`), RAM floor
  (`INSUFFICIENT_MEMORY`), pull serialization (two concurrent creates of a
  missing image → one `rungv pull`, both proceed), the static table
  (meta-refresh, localhost-only bind, live row + link, row gone after close).
  Needs network for the hello-world pull.
- `bun test tests/http-daemon.test.ts` — daemon shape: disconnect survival
  (client A leaves, fresh client B drives the same session) and two clients on
  one shared session (concurrent shells serialize; both see the same row).
- `bun test tests/leak-cycles.test.ts` — 20 create/shell/close cycles;
  daemon fd and child counts return to baseline (fds ±8 tolerance, documented
  in the file), zero live `rungv run … micke-` processes, zero pidfiles.

`bun test` (or `bun run test`) runs all four.
