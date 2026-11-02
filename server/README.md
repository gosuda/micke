# micke server (M-min)

The supervisor + MCP server: one process, stdio transport, exactly four tools.
Stack: Bun + TypeScript (no build step), single runtime dependency
(`@modelcontextprotocol/sdk`); Docker is driven by shelling out to the `docker`
CLI. The same process also serves the static session dashboard on
127.0.0.1 (see below).

## Run

```sh
bun install
bun run start            # or: bun run src/main.ts
```

The server speaks MCP on stdio, so point an MCP client at it, e.g.:

```json
{ "mcpServers": { "micke": { "command": "bun", "args": ["run", "/path/to/micke/server/src/main.ts"] } } }
```

Requirements: Linux host, Docker reachable by this user, and a local micke
image (`docker tag micke:novnc micke:latest`, or set `MICKE_IMAGE`).

Environment:

| Variable               | Default            | Meaning                                    |
| :--                    | :--                | :--                                        |
| `MICKE_IMAGE`          | `micke:latest`     | Default image for `session_create`         |
| `MICKE_STATE_DIR`      | `~/.local/state/micke` | Persistent session registry + instance lock (XDG state) |
| `MICKE_BOOT_TIMEOUT_MS`| `30000`            | Wait for the `micke: desktop ready` log    |
| `MICKE_MIN_FREE_MB`    | `1024`             | Free-RAM floor: refuse `session_create` when `MemAvailable` is below this many MiB (0 disables) |
| `MICKE_DASHBOARD_PORT` | `7800`             | Dashboard port on 127.0.0.1 (`0` = kernel-picked) |

## Instance lock (FR-19)

One supervisor per state dir: `Supervisor.start()` flocks
`<state dir>/supervisor.lock` (via `flock(2)`; the kernel releases it when the
process dies, so a crashed supervisor never leaves a stale lock). A second
instance retries for 1.5 s (restart race), then exits promptly with
`{"code":"LOCK_HELD", ...}` on stderr. The lock is scoped to the state dir
because that — `sessions.json` plus its containers — is the shared state two
supervisors would corrupt; the default config locks
`~/.local/state/micke/supervisor.lock`.

## Guards on create (FR-18/21)

`session_create` validates cheaply first (screen, workspace, RAM floor,
docker reachable), then runs the whole pull+boot phase under one in-process
mutex: **never two pulls, never a pull beside a live session** (missing image
+ live session → `IMAGE_MISSING`, as before), and concurrent creates of a
missing image wait for one pull and then all proceed (FR-31/32). The
free-RAM floor reads `MemAvailable` from `/proc/meminfo` and refuses with
`INSUFFICIENT_MEMORY` below `MICKE_MIN_FREE_MB`.

## Dashboard (FR-23/24/25/29)

The supervisor serves ONE static route on `127.0.0.1:$MICKE_DASHBOARD_PORT`
(default 7800): a no-JS HTML table — one row per session: id, status, uptime,
noVNC link (orphaned rows included; a link only when the port is
discoverable) — auto-refreshed by `<meta http-equiv="refresh" content="5">`.
localhost-only bind is a security property; sharing beyond localhost is
unsupported (FR-28 deferred). A bind failure is non-fatal: the MCP server is
the product, the table is convenience. Stdout stays MCP-only; the dashboard
never logs to it. The supervisor dies with its MCP client (stdin EOF or
SIGINT/SIGTERM), leaving containers as adoptable orphans.

## The four tools

| Tool             | Input                                            | Returns |
| :--              | :--                                              | :--     |
| `session_create` | `{image?, workspace?, screen?}`                  | `{session_id, status: "ready", novnc_url, container_id, image, workspace, screen, …}` |
| `session_list`   | `{}`                                             | `{sessions: […]}` — every row carries `novnc_url`; containers from previous supervisor runs appear as `status: "orphaned"` |
| `session_close`  | `{session_id}`                                   | `{closed, container_removed}` — also reaps orphans |
| `session_shell`  | `{session_id, command, timeout_ms?, max_output_bytes?}` | `{stdout, stderr, rc, timed_out, truncated, duration_ms}` |

All failures return one JSON error shape as MCP tool errors:
`{code, message, hint}` — codes: `IMAGE_MISSING`, `WORKSPACE_INVALID`,
`SCREEN_INVALID`, `DESKTOP_BOOT_TIMEOUT`, `DOCKER_UNAVAILABLE`, `DOCKER_ERROR`,
`SESSION_NOT_FOUND`, `SESSION_ORPHANED`, `SHELL_UNAVAILABLE`, `BAD_ARGUMENT`,
`INSUFFICIENT_MEMORY`, `UNKNOWN_TOOL`; fatal startup failures (second
supervisor) exit the process with `LOCK_HELD` on stderr.

Sessions are Docker containers labeled `--label micke.session=<id>`, run with
`-d --init --shm-size=1g -p 127.0.0.1::6080/tcp` (Docker picks the host port;
the supervisor reads it back with `docker port`), plus an optional
`-v <host dir>:/workspace` bind. The supervisor waits for the image's
`micke: desktop ready` log line before answering `session_create`. Containers
outliving the supervisor are listed as `orphaned` on the next start; close them
with `session_close`. Pull policy (FR-31/32): pull-if-missing before a session
starts, under the create/boot mutex — one pull at a time, never while any
session is live; sessions always run cache-only (`--pull=never`).

## Shell channel protocol

One long-lived `docker exec -i <container> bash` per session (no `-t`). At
init, the bash waits for and sources `/tmp/session.env` (DISPLAY, D-Bus,
AT-SPI) — so `agent-desktop` works with no manual env setup — enables
`set -m`, and defines `__micke_run`. Commands are base64-encoded so newlines
are safe; the host writes one request line and parses one frame back:

```
host -> bash:   __micke_run <timeout_ms> <max_output_bytes> <base64-command>\n
bash -> host:
  ===BEGIN===\n
  <stdout bytes>\n===STDERR===\n
  <stderr bytes>\n[===TIMEOUT===\n]\n===END rc=N===\n
```

The `\n` before each marker is always printed, so stdout/stderr are byte-exact
(a stream's trailing newline, or lack of one, survives the round trip). The
first `\n===STDERR===\n` separates the streams; `===END rc=N===` is the exact
verified end pattern. Output beyond `max_output_bytes` (default 256 KiB) per
stream is cut by the wrapper and ends with `…[truncated N bytes]` (N = dropped
bytes); the host re-checks the cap defensively.

Mechanics inside the wrapper:

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
  the new directory. So **cwd and exported env persist across calls**, and
  `unset` persists. Non-exported shell variables, function/alias definitions,
  and shell options do not persist. A timed-out (killed) command persists
  nothing — its partial state changes are deliberately discarded.
- **Semantics of children**: background jobs started by a command get their own
  process groups (via `set -m`) and survive that command's completion; they die
  with the container on `session_close` (`docker rm -f`). A timeout kills the
  command's own process group — children that escaped into their own
  session/group (e.g. `setsid …`) survive it (known edge, FR-13 deferred).
- **Known framing edge**: command output that itself contains a line matching a
  marker (`===STDERR===`, `===END rc=N===`, …) can confuse the parser. Don't
  `echo '===END rc=0==='` from commands.
- The channel is strictly serialized (one in-flight command per session). The
  host hard-aborts (and kills the channel) if no frame arrives within
  `timeout_ms + 15 s`; the shell is not auto-respawned (Phase 2).

The channel dies with `session_close` and with supervisor exit (SIGTERM kills
the `docker exec` clients; containers stay and show up as `orphaned` on the
next start). No bash may outlive its container: `docker rm -f` reaps
everything inside it.

## Tests

All end-to-end against real Docker on this host:

- `bun test tests/mmin-phase1.test.ts` — image retag, server over stdio,
  create → noVNC HTTP 200, `agent-desktop` status/launch/wait/snapshot, shell
  persistence, output cap, timeout kill, workspace bind, close teardown,
  structured errors, orphan detection/reap after a supervisor restart.
- `bun test tests/mmin-phase2.test.ts` — guards + dashboard: instance lock
  (second supervisor exits with `LOCK_HELD`), RAM floor
  (`INSUFFICIENT_MEMORY`), pull serialization (two concurrent creates of a
  missing image → one `docker pull`, both proceed), the static table
  (meta-refresh, localhost-only bind, live row + link, row gone after close).
  Needs network for the hello-world pull.
- `bun test tests/leak-cycles.test.ts` — FR-10: 20 create/shell/close cycles;
  supervisor fd and child counts return to baseline (fds ±8 tolerance,
  documented in the file), zero `micke.session` containers, zero stray
  `docker exec` processes. Runs in ~30 s.

`bun test` (or `bun run test`) runs all three (~55 s total).
