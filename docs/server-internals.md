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
| `MICKE_SHELL_CONCURRENCY`  | `8`                              | Max parallel `session_shell` calls per session (`0` = unlimited); beyond it calls queue briefly |
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

On SIGINT/SIGTERM the daemon stops the HTTP server and closes in-flight shell
connections; **rungv sandboxes stay alive** and the next start adopts them
(their pidfiles carry the pids and ports). stdin is not a shutdown trigger — the
daemon is meant to run under a service manager (systemd, launchd, or similar).

## The four tools

| Tool             | Input                                            | Returns |
| :--              | :--                                              | :--     |
| `session_create` | `{image?, workspace?, screen?}`                  | `{session_id, status: "ready", novnc_url, rungv_pid, hostname, image, workspace, screen, …}` |
| `session_list`   | `{}`                                             | `{sessions: […]}` — ready rows carry `novnc_url`; a pidfile whose sandbox is gone appears as `status: "orphaned"` |
| `session_close`  | `{session_id}`                                   | `{closed, sandbox_removed}` — also reaps orphans |
| `session_shell`  | `{session_id, command, cwd?, timeout_ms?, max_output_bytes?}` | `{session_id, stdout, stderr, rc, timed_out, truncated, duration_ms}` |

All failures return one JSON error shape as MCP tool errors:
`{code, message, hint}` — codes: `IMAGE_MISSING`, `WORKSPACE_INVALID`,
`SCREEN_INVALID`, `DESKTOP_BOOT_TIMEOUT`, `RUNGV_UNAVAILABLE`, `GVX_ERROR`,
`SESSION_NOT_FOUND`, `SESSION_ORPHANED`, `SHELL_UNAVAILABLE`, `BAD_ARGUMENT`,
`INSUFFICIENT_MEMORY`, `UNKNOWN_TOOL`, plus `INTERNAL` as the catch-all for
unexpected (non-Micke) exceptions; fatal startup failures exit the process
with `LOCK_HELD` (second supervisor on the same state dir) or `PORT_HELD`
(daemon port already bound) on stderr.

### Audit log

Every MCP tool call appends exactly one line to
`<MICKE_STATE_DIR>/audit.log` (`src/audit.ts`; the append is best-effort and
can never fail the call it observes):

```
2026-11-02T16:58:00.123Z session_shell sid=1a2b3c4d rc=0 timed_out=false cmd=micke-state took=842ms ok
2026-11-02T16:58:03.400Z session_shell sid=1a2b3c4d cmd=sleep 5 took=3ms err=SESSION_NOT_FOUND
```

`<ISO> <tool> [k=v …] took=<ms>ms ok|err=<CODE>` — commands are
whitespace-collapsed and capped at 400 chars, and output bodies are never
logged. This is the maintainer's objective record of what an agent actually
ran (shell-call counts, sleeps, screenshots, status checks) after a session
and its transcript are gone; `rm` the file to reset it.

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
probed and reported up/down, but does not gate readiness. `ready` means the
desktop is up (Xvfb, openbox, AT-SPI, shell listener) — **not** that chromium
is running; `status` is sandbox liveness, not browser liveness.

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
  Each `session_shell` call opens its own fresh TCP connection to the
  still-booted desktop.
- Otherwise → list as **orphaned** (pidfile present, sandbox gone);
  `session_close` reaps the pidfile.

`session_close` kills the shell socket, sends SIGTERM to the rungv pid,
escalates to SIGKILL after ~3 s, waits for the whole process tree to vanish
(measured ~0.1 s, zero strays), then deletes the pidfile and log.

## Shell protocol (one connection per command)

gvx has no `exec`, so `image/driver.sh` writes a small supervised python3
listener (`/tmp/server.py`) into the guest; it accepts TCP connections and
forks **one bash per connection** (`/tmp/handler.sh`). `session_shell` opens a
connection **per call**: connect → wait for `===SHELL_READY===` → write one
request line → read exactly one frame → close. Nothing stays open between
calls.

**Stateless by construction.** Every call is a fresh bash, so cwd and exported
env do not persist (`cd /tmp` or `export FOO=bar` affects that call only) and
there is no shell state to wedge. Choose a directory with the optional `cwd`
argument (absolute guest path, default `/home/agent`) or make the command
self-contained (`cd /tmp && ls`, `PATH=/x:$PATH cmd`). The host implements
`cwd` by prefixing the command with a single-quoted `cd -- <dir>` — no caller
input reaches an unquoted shell position — and a directory that does not exist
returns `CWD_INVALID`. The desktop env (DISPLAY, D-Bus/AT-SPI) still reaches
every fresh bash: the handler sources `/tmp/session.env` before printing the
ready marker.

Why the old persistent shell was removed: it replayed exported env between
commands by diffing `export -p` snapshots in the guest. That replay `unset`
changed variables **before** re-running `comm`/`grep`/`sed`, which resolve
through the very `PATH` it had just unset — so one `export PATH=/x:$PATH` left
the handler with an empty PATH and every later call died at `mktemp` with an
empty frame and rc 1, permanently, until `session_close`. A fresh bash deletes
that bug class, removes the host-side per-session queue (one slow command no
longer blocks the session), and leaves nothing long-lived to wedge.

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
  grace for commands that trap/ignore TERM). On timeout the frame carries
  `===TIMEOUT===` and `rc` is 143 (TERM) or 137 (KILL). The watchdog runs in
  its own group and is killed after the command completes, so fast commands
  leak no sleeping watchdogs.
- **No state is carried forward**: the wrapper records only the exit code. The
  handler bash exits when the host closes the connection, so a command cannot
  leave an env or cwd behind for a later call — there is no later call in that
  process.
- **Semantics of children**: background jobs started by a command get their own
  process groups (via `set -m`) and survive that command's completion (and the
  handler bash exiting). They die with the sandbox on `session_close` (the
  rungv process tree is killed). A timeout kills the command's own process
  group — children that escaped into their own session/group (e.g. `setsid …`)
  survive it (a known, deferred edge case).
- **Known framing edge**: command output that itself contains a line matching a
  marker (`===STDERR===`, `===END rc=N===`, …) can confuse the parser. Don't
  `echo '===END rc=0==='` from commands.
- **Late guest writes**: the host closes the connection once the complete frame
  (through `===END rc=N===\n`) is parsed — a frame is never truncated. A guest
  process that writes to the socket *after* that close (a background job that
  kept stdout, or a watchdog racing a host-side backstop close) sees
  `printf: write error: Broken pipe` / `EPIPE` in the guest. That is the write
  side being late, not lost output: redirect background output
  (`… >/dev/null 2>&1 &`).
- **Concurrency**: calls per session run in parallel up to
  `MICKE_SHELL_CONCURRENCY` (default 8; `0` = unlimited). Beyond the cap they
  queue briefly rather than fail — the guest forks one bash per connection, so
  an unbounded fan-out would be a guest fork bomb. The host hard-aborts (and
  closes that connection) if no frame arrives within
  `max(timeout_ms, 1 s) + 15 s`; the guest watchdog should fire first, and the
  backstop only covers a connection gone silent. There is no reconnect logic
  because there is no channel: a failed call is just a closed connection, and
  the next call is a new one.
- The listener is supervised in the guest (respawn, 10 crashes in 60 s →
  sandbox exits). The listener dies with `session_close`; the sandbox does not
  survive it.

## Tests

Two tiers, because the old default booted real 2 GB gvx sandboxes (minutes per
run) and `tests/mmin-phase1.test.ts` was one test wrapping ~15 steps: a failure
named nothing, so agents re-ran the whole suite to find it. The suite stayed
green through three real defects (workspace not writable on macOS,
`agent-desktop press` SIGSEGV, a `PATH` wedge) because it asserted only what
the author already believed. The fix is demotion + distribution, not deletion.

### Fast tier — `bun test tests/` (default)

No sandbox, no `rungv` binary, no image; target under 10 seconds. Every suite
spawns the real daemon as a subprocess on a kernel-picked port (`MICKE_PORT=0`)
and talks MCP over Streamable HTTP (`tests/helpers.ts`). The guest and gvx are
replaced by `tests/fake/`:

- `tests/fake/guest.ts` — an in-process TCP server that speaks the guest half
  of the shell protocol byte-for-byte: `===SHELL_READY===`, one
  `__micke_run` request, one frame. Commands script echo, exact bytes,
  timeout, large output, a chosen rc, and a mid-frame close.
- `tests/fake/rungv` — a real child process `io.spawnSession` spawns via
  `MICKE_RUNGV`. It binds real listeners, prints the exact
  `rungv: publishing …` lines and the desktop-ready line, serves the fake guest
  on the `7801` mapping, and exits cleanly on SIGTERM/SIGKILL. Lifecycle,
  pidfile, adoption and process reaping therefore stay on the production path.

Fast suites:

- `tests/shell-protocol.test.ts` — frame parsing (exact stdout/stderr,
  trailing newline or not), `timed_out`, truncation and dropped-byte count,
  non-zero rc, `cwd` honored / `CWD_INVALID` / relative and empty cwd
  `BAD_ARGUMENT`, a mid-frame close → `SHELL_UNAVAILABLE` with the next call
  working, disconnect survival, two clients on one session, and the
  concurrency cap (parallel slots, oversubscription queues).
- `tests/lifecycle.test.ts` — create → `session_list` row, adoption after
  SIGKILLing the daemon (same pidfile, ports and sandbox), `session_close`
  killing the fake rungv and deleting the pidfile, and orphaned-record
  handling (`SESSION_ORPHANED`, reaped by close).
- `tests/dashboard.test.ts` — empty table + meta refresh, loopback-only bind,
  live row (id/status/uptime/noVNC link), the link opening, row gone after
  close.
- `tests/guards.test.ts` — create guards (`SESSION_NOT_FOUND`,
  `WORKSPACE_INVALID`, `SCREEN_INVALID`, `WORKSPACE_NOT_WRITABLE`), the
  free-RAM floor (Linux only), and pull serialization (two concurrent creates
  of a missing image → one fake pull).
- `tests/leak-cycles.test.ts` — repeated create/shell/close cycles; daemon fd
  and child counts return to baseline (fds ±8 tolerance, documented in the
  file), every sandbox pid from the run is gone, zero pidfiles/logs.

The host-side unit suites (`agent-desktop-shim`, `micke-chromium`,
`micke-find`, `micke-key`, `micke-state`, `page-text`, `workspace`) stay in the
same tier and need no harness.

### E2E tier — `MICKE_E2E=1 bun test tests/` (or `bun run test:e2e`)

Real image, only what genuinely needs it. The shared image comes from
`MICKE_TEST_IMAGE` (else `MICKE_IMAGE`; default
`ghcr.io/gosuda/micke:latest`) and is pulled once into `MICKE_TEST_CACHE_DIR`
(else `MICKE_GVX_CACHE`, else the default cache) if missing. Files live in
`tests/e2e/` (plus `tests/stateless-shell.test.ts`, kept at its original path),
are gated with `describe.skipIf(!E2E)`, and carry an explicit per-test timeout.
`bun test tests/` discovers them but skips them without booting anything.

- `tests/e2e/boot.test.ts` — create → one shell command → close; no process or
  pidfile left.
- `tests/e2e/daemon-lock.test.ts` — the instance lock (`LOCK_HELD`, clean
  stdout) on the fake rungv, gated because its 1.5 s retry would dominate the
  fast budget.
- `tests/e2e/desktop.test.ts` — `agent-desktop status` (a11y granted), launch
  chromium, `micke-find` a real link, click it, and verify the navigation with
  `micke-state`.
- `tests/stateless-shell.test.ts` — one session: cwd/env do not persist,
  `cwd:` honored/validated, the PATH-replay regression, overlapping parallel
  calls, a burst above the cap, timeout kill with no strays, `nohup` survival,
  a killed handler not wedging the next call, and real in-guest output
  truncation. Kept at its original path (still `MICKE_E2E`-gated) so
  `bun test tests/stateless-shell.test.ts` remains a valid one-file selection.
- `tests/e2e/workspace.test.ts` — the one thing unit tests cannot reach: guest
  uid vs host mode across a real gvx mount (auto workspace writable + host
  visible, explicit 0777 writable, unwritable mode refused before boot).

**E2E is not part of the edit loop.** Run it once before pushing, or not at all
for docs/test-only changes. If an assertion fails twice, stop and report
instead of re-running the suite. A failure must name its step; never add a
multi-step mega-test. See [AGENTS.md](../AGENTS.md).
