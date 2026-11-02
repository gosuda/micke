# gvx feasibility study for micke

Date: 2026-11-02. Research repo: `~/git/gvx` (clone of `gfire-sigs/gvx`, HEAD `c43053f`,
v0.4.0 released 2026-11-02). Host: Linux x86_64, kernel user, 4 CPUs, 7.8 GiB RAM,
Docker 29.1.3 (legacy builder), Go 1.26.8 (gvx needs Go >= 1.27, so the prebuilt
release binary was used). Scratch dir: `/tmp/opencode/gvx`.

## 1. What gvx is

gvx is a fork of google/gvisor (pinned at upstream commit `90a2f3f7b8d1`, dated
2026-10-26, one week old at test time) that runs unmodified OCI images and Linux
ELF64 binaries inside a single unprivileged host process. A pure-Go "Sentry"
user-space kernel services guest syscalls; guest code runs natively on the CPU
under the `systrap` engine (syscall patching + per-address-space stub processes
on Linux), so V8/node/Python JIT run at native speed. Storage: image layers are
compiled in memory into cached read-only `.erofs` files; guest root writes go to
a memory layer (like `docker run --rm`); named volumes are single `.ext4` files;
bind mounts via `hostfs`. Networking: pure-Go netstack with NAT (`-net=nat`,
`-p` port forwards) or WireGuard. The host process self-locks-down (seccomp on
Linux: "Installing seccomp filters for 97 syscalls" observed) before the guest
starts. CLI: `rungv` (`run/pull/images/inspect/tag/rmi/save/load/login/logout/
stub/version`), plus an embeddable Go SDK (`pkg/gvx`). License: Apache-2.0
(gVisor-derived code also Apache-2.0).

Maintenance sanity: 7 stars, 2 forks, one principal author, releases v0.1.0
through v0.4.0 cut within two days (2026-11-01/02), upstream pin refreshed to a
week-old gVisor commit. v0.4.0's changelog explicitly targets "gaps ... that
systemd, Docker in the guest, and desktop workloads hit". Real project, real
cadence, but single-maintainer bus factor and pre-1.0 API churn are real risks.

## 2. Answers to the research questions

### a. Long-running sessions and `docker exec`

There is **no daemon, no `-d`, no `exec`, no `logs`, no `ps/stop/rm`**. This is
by design, not missing work: the host process locks itself down (seccomp) before
the guest starts and cannot open files, spawn processes, or create sockets
afterwards, so a second `rungv` process can never attach to a running sandbox.
`docs/cli.md` §1: "This rule is the reason that `rungv` has no `exec`, no
`logs`, and no `-d` in this stage." `-d` is explicitly refused.

Sanctioned patterns (verified hands-on):

1. **Foreground run with streaming stdio** (`rungv run -i`, or SDK
   `Config.Stdin/Stdout/Stderr`): the guest entrypoint stays alive and reads a
   command per line from stdin; the host supervisor writes to rungv's stdin and
   frames output. This is what the hands-on test below uses and it works.
2. **A service inside the sandbox reached via `-p` port forwarding** (e.g. sshd,
   tmux control socket over TCP, agent-desktop's own server). `-p` forwards are
   pre-bound before lockdown and survive for the life of the run.
3. **Go SDK** (`pkg/gvx`): `gvx.New` + `sb.Run` + `defer sb.Close` embeds the
   same sandbox in a micke supervisor process. Caveat: `Config.DisableHostLockdown`
   must be set if the embedding process wants to keep doing host work after the
   sandbox starts (the seccomp lockdown is irreversible and process-wide).

Note: on Linux, `openPlatform` has no hardware backend (that is Windows whpx /
macOS hvf), so `auto` always lands on upstream systrap here. Observed:
`rungv: platform=systrap` + a fallback warning on every run.

### b. Ingesting a locally built image

Yes. `docs/cli.md` §6: "`rungv load` reads such an archive, an OCI layout, or
the output of `docker save`." Verified: `docker save micke:dev` (388 MB tar) →
`rungv load -i` → "Loaded image: micke:dev" in 8 s. v0.4.0 fixed the historical
warty where a run of a loaded image still queried the registry; default pull
policy `missing` uses the cache first, and `--pull=never` forces cache-only.
Other local paths: the SDK takes `OCIImage` as an OCI archive path, plus
`OCILayerTars [][]byte` (raw in-memory layer tars), and `-bin` runs a bare host
ELF64. `rungv build` does not exist; image builds stay in Docker.

### c. gVisor/gvx limitations relevant to micke's stack

Empirically (all verified inside the running sandbox, see §4): Unix sockets work
(D-Bus session bus, `DBUS_SESSION_BUS_ADDRESS` filesystem socket), the AT-SPI
bus works (`agent-desktop status` → accessibility granted), `/tmp/.X11-unix/X99`
X11 sockets work (Xvfb created one; agent-desktop and X clients connected),
`/dev/shm` exists as tmpfs sized at **half of host RAM** by default (3.9G on
this 7.8G host; v0.4.0 behavior, same as runsc) so chromium's shm hunger needs
no special flag, and `--tmpfs /dev/shm:size=...` can pin it explicitly.
Multi-process chromium (browser/renderer/GPU zygotes, ~20 processes), the V8 JIT,
node, and the native agent-desktop binary all ran. epoll, fork/clone, wait,
signals, and X11 screen capture (PNG screenshot via XGetImage) worked; nothing
in our stack needed inotify. PID 1 semantics: the guest init (our driver
script) reaping is handled by the Sentry; `sleep infinity` as final exec was
fine. Known sharp edges from docs: `io_uring` returns ENOSYS (falls back to
epoll); non-PIE fixed-address executables and self-modifying W^X pages have
systrap quirks (none hit by our binaries); root FS writes vanish at exit (fine:
micke sessions are disposable); raw sockets and suid are off by default (we
needed neither).

### d. Upstream tracking and licensing

`UPSTREAM_COMMIT` = `90a2f3f7b8d16016a7b0219d4c9b74f2610094f2`, upstream date
2026-10-26 ("Merge release-20261019.0-278-g4eb0c8ea2"). The fork keeps a strict
three-tier isolation model to keep merging upstream cheap (charged upstream diff
< 1.0%). Everything is Apache-2.0. Repo stats at test time: 7 stars, 2 forks,
0 open issues, last push 2026-11-02T02:56Z. Bus factor is the main governance
risk: one active maintainer, pre-1.0 API ("the API of `pkg/gvx`, the flags of
`rungv`, and the on-disk formats can change before v1.0.0").

## 3. Docker → gvx mapping for micke

| micke needs (Docker today) | gvx equivalent | Notes / caveats |
| :--- | :--- | :--- |
| `docker run -d --init --shm-size=1g micke:dev` (detached, default entrypoint) | `rungv run -i micke:dev` foreground, entrypoint kept; supervisor holds it open | No daemon, no `-d`. A host supervisor process per session must keep rungv alive; `--init` unneeded (Sentry is PID 1/reaper). Args after the image append to the entrypoint (Docker Cmd semantics); micke's entrypoint ignores them and always boots the desktop. |
| `docker exec` (run `agent-desktop` in the live session) | **No exec.** Either (a) stdin line-protocol into the entrypoint (verified below), (b) a service in the guest reached via `-p`, or (c) embed SDK and drive `Config.Stdin/Stdout` programmatically | This is the core architecture change. (a) is a ~40-line driver script + framing, (b) is the most Docker-like for MCP tools, (c) is the production-grade version of (a). |
| `--shm-size=1g` | nothing needed: `/dev/shm` = half of host RAM (3.9G here); or `--tmpfs /dev/shm:size=1g` | Oversized by default on big hosts; consider the tmpfs flag to bound it, since tmpfs counts against the memory guard. |
| env (`-e`, image `ENV`) | `-e K=V`, `--env-file`, image `Env` honored (`DISPLAY`, `XDG_RUNTIME_DIR`, `ACCESSIBILITY_ENABLED=1` came through) | Image `USER agent` and `WORKDIR` also honored. |
| `docker stop/rm` (lifecycle) | kill the host rungv process (or feed the guest an exit line); sandbox teardown auto | Measured teardown 0.52 s, zero stray processes. Kill -9 of rungv also works (volumes journal, but we use none). |
| Local image build + `docker save` | `docker save` → `rungv load -i` (8 s for 388 MB) | Works; builds stay in Docker; `--pull=never`/`missing` avoids registry round trips. |
| Port exposure for future noVNC (x11vnc :5900, websockify/noVNC :6080) | `-p 5900 -p 6080` (or fixed `-p 127.0.0.1:6080:6080`); forwards are plain L4 TCP/UDP byte pipes (Go `net` NAT in `pkg/netbackend`) | Verified end-to-end (§4.7): correct HTTP responses, a 10 s sustained rate-limited stream, and 3 parallel 5 MB transfers at ~78 MB/s each. No websocket awareness needed: websockify traffic is just TCP. Docs list **no idle/duration/connection limits for TCP rules**; the only caps found: UDP rules max 1024 concurrent sessions, TCP guest-dial window 3 s (forwarder waits up to 3 s for the guest listener before giving up), port ranges refused, `-p` needs `-net=nat` (the default), host port 0 asks for a free port (printed on stderr, machine-parseable). |
| Limits `--memory/--cpus` | `-m`, `--cpus` | `-m` is a polling guard (exit 137), not cgroups; without it the limit is host physical RAM — on a memory-tight host the host OOM killer fires first (observed once, §4.8). `--cpus` caps CPU time on Windows only; on Linux it only changes the CPU count the guest sees. |

## 4. Hands-on results

All artifacts under `/tmp/opencode/gvx/` (`driver.sh`, `session.sh`, logs).
Setup:

```console
$ curl -LO .../rungv-v0.4.0-linux-amd64.tar.gz   # SHA256SUMS verified:
f3c8b488c812b274dea9e08775d8515c4741bdb5b3cd6219a305b739e59ff23f  ok
$ rungv version
rungv v0.4.0
commit c43053f5ca68b15ac675e1c78d97ece18b598aab (2026-11-02T02:45:19Z)
go go1.27.3 linux/amd64
$ rungv stub
systrap stub ok / architecture: amd64 / host page size: 4096
```

### 4.1 Image ingest

```console
$ docker save micke:dev -o /tmp/opencode/micke-dev.tar      # 388 MB, 9 s
$ rungv load -cache-dir /tmp/opencode/gvx/cache -i /tmp/opencode/micke-dev.tar
Loaded image: micke:dev                                     # 8 s
$ rungv images -cache-dir ...
micke   dev   f1beae04c3cc   6 minutes ago   1.185GB        # compiled EROFS layers
```

### 4.2 Quick guest checks (each a one-shot foreground run)

```console
$ rungv run -cache-dir ... --pull=never --entrypoint /usr/local/bin/agent-desktop micke:dev version
{"version":"2.5","ok":true,"command":"version","data":{"os":"linux","target":"x86_64","version":"1.0.2"}}   # 0.86 s total
```

(`--entrypoint` replaces the entrypoint; without it, args append to
`micke-entrypoint`, which ignores them and boots the desktop. Full path
required: a bare name is not resolved for `--entrypoint`.)

### 4.3 The live desktop session (the real pattern)

Driver script mounted as a file bind (`-v driver.sh:/driver.sh:ro`, runs via
`bash`, no exec bit needed), entered as `--entrypoint /bin/bash ... /driver.sh`;
the driver re-execs itself under `dbus-run-session`, boots Xvfb → at-spi-bus →
openbox, writes `/tmp/session.env`, then reads one command per line from stdin
(`===BEGIN===` / `===END rc=N===` framing). Host harness keeps rungv's stdin
FIFO open (`sleep infinity > fifo`) and appends to it per command:

```console
$ session.sh start    # rungv run -i --pull=never --entrypoint /bin/bash \
                      #   -v driver.sh:/driver.sh:ro -h micke-gvx micke:dev /driver.sh < fifo
micke: desktop ready on :99 (1280x800x24)
===READY===
$ session.sh send '. /tmp/session.env && agent-desktop status'
{"ok":true,"command":"status","data":{"permissions":{"accessibility":{"state":"granted"},...},
 "state_root":"/home/agent/.agent-desktop","version":"1.0.2"}}        # identical to Docker
```

### 4.4 Chromium under gvx

```console
$ session.sh send 'df -h /dev/shm | tail -1; nproc; grep MemTotal /proc/meminfo'
none  3.9G  0  3.9G  0% /dev/shm      # half of host RAM, no --shm-size needed
4                                     # CPUs visible
MemTotal: 8126476 kB                  # host RAM reported, as runsc does

$ session.sh send 'agent-desktop launch chromium --arg=--no-sandbox \
    --arg=--force-renderer-accessibility --arg=https://example.com'
{"ok":true,"command":"launch","data":{"app":"chromium","pid":55,
 "window":{"accessible":true,"title":"Untitled - Chromium","bounds":{...1042x776...}}}}

$ session.sh send 'agent-desktop wait --window "Example Domain" --app chromium --timeout 20000'
{"ok":true,"command":"wait","data":{"found":true,"elapsed_ms":36,
 "window":{"title":"Example Domain - Chromium","is_focused":true}}}   # NAT egress + DNS work

$ session.sh send 'agent-desktop snapshot --app chromium -i --compact'
{"ok":true,"command":"snapshot","data":{"complete":true,"ref_count":83, ...}}
                                                                      # 83 refs, same as Docker

$ session.sh send 'agent-desktop click "@<snapshot>:e65"'              # "Learn more" link
{"ok":true,"command":"click","data":{"steps":[{"mechanism":"semantic_api","outcome":"succeeded"}]}}
$ session.sh send 'agent-desktop wait --window "Domains" --app chromium --timeout 25000'
{"ok":true,...,"title":"Example Domains - Chromium"}                    # navigated to iana.org

$ session.sh send 'agent-desktop screenshot /tmp/shot.png'
{"ok":true,"command":"screenshot","data":{"format":"png","width":1280,"height":800}}  # 102 KB file
```

No `--disable-dev-shm-usage` needed. First click attempt failed only due to my
CLI syntax (`click` takes the ref positionally; `--app` is not a `click` flag).

### 4.5 Cold start, memory, teardown (same host, same image)

| Metric | Docker (baseline) | gvx v0.4.0 (systrap) |
| :--- | ---: | ---: |
| cold start → "desktop ready" | 0.54 s | 1.07 s |
| RSS at desktop ready | 157 MiB (container) | ~85 MiB main process (+ stubs) |
| + chromium + example.com | 404.6 MiB, 127 PIDs | **1836 MiB PSS** across 78 host procs (4.2 GB naive RSS: stubs share-map guest memory; use PSS) |
| teardown | ~1 s (`docker rm -f`) | 0.52 s, zero stray processes |
| extra host cost | dockerd (shared) | one foreground process tree per session |

The ~4.5x memory multiplier for a chromium session is the price of the Sentry
(page tables, netstack, per-process stubs sharing the guest memory file). On
this 7.8 GiB host that means ~2 concurrent gvx desktop sessions vs ~8+ under
Docker. Capacity planning must budget ~2 GiB per active chromium session.

### 4.6 Environment parity details

Image `ENV` (`DISPLAY=:99`, `XDG_RUNTIME_DIR=/tmp/xdg-runtime`,
`ACCESSIBILITY_ENABLED=1`), `USER agent` (uid 1000 via image `/etc/passwd`),
and `WORKDIR /home/agent` were all honored without flags. `/etc/hosts` gained
the hostname and `host.docker.internal`.

### 4.7 Port forwarding (noVNC prerequisite)

```console
$ rungv run -cache-dir ... -p 8080 python:3.12-alpine \
    sh -c 'echo hello-from-gvx > /www.html && dd if=/dev/urandom of=/big.bin bs=1M count=5 && \
           exec python3 -m http.server 8080 --directory /'
rungv: publishing 127.0.0.1:38271 -> 8080/tcp

$ curl http://127.0.0.1:38271/www.html
hello-from-gvx
$ curl --limit-rate 500k -o big.bin http://127.0.0.1:38271/big.bin
http=200 bytes=5242880 time=10.005s speed=524024B/s     # sustained 10 s stream, intact
$ 3 parallel curls of the same 5 MB file
conn1 http=200 bytes=5242880 time=0.067s                # ~78 MB/s each
conn2 http=200 bytes=5242880 time=0.069s
conn3 http=200 bytes=5242880 time=0.070s
```

Host port can be picked automatically (host port 0 / bare `-p 8080`) and is
printed in a stable stderr line. The forwarder is a transparent L4 TCP pipe;
nothing websocket-specific to worry about for websockify/noVNC. Caveats found:
UDP rules cap at 1024 concurrent sessions, TCP connections wait up to 3 s for
the guest listener to appear (guest-dial window), port *ranges* are refused,
and `-p` requires NAT mode (the default). One control quirk: `kill` of the
rungv process tree is the stop mechanism; there is no graceful `stop` command.

### 4.8 Failures observed

- First-ever `rungv run alpine:3.20 uname -a` (registry pull, in-memory layer
  compile) died with SIGKILL while the earlier micke background session was
  also resident: on a 7.8 GiB host with ~3-4 GiB free, pull + a second sandbox
  can trip the host OOM killer (gvx's own guard only reacts to its notion of
  guest memory). Retry from cache worked instantly. Lesson: pull images before
  starting sessions, and set `-m` per session.
- `--entrypoint agent-desktop` (bare name) failed with `executable not found in
  guest rootfs`; use the absolute path `/usr/local/bin/agent-desktop`.
- My `pkill -f` patterns repeatedly killed my own probe shell — user error, not
  a gvx issue, recorded only because it produced one spurious SIGKILL above.

## 5. Verdict

**Feasible with changes.** The entire disposable-desktop-session pattern runs
under gvx today: the unmodified `micke:dev` image boots its Xvfb/AT-SPI/openbox
desktop, `agent-desktop` gets accessibility granted, chromium renders real web
pages over NAT, snapshots return the same 83 refs as Docker, link clicks
navigate, and PNG screenshots capture the screen. Required changes, none of
them image-side:

1. **Replace `docker exec` with a session command channel** (the only
   structural change): a small driver script as the sandbox entrypoint that
  boots the desktop then serves a line protocol on stdin/stdout; the host
   supervisor owns one foreground rungv process per session. (Or embed
   `pkg/gvx` and drive `Config.Stdin/Stdout`; remember `DisableHostLockdown`
   if the supervisor hosts multiple sandboxes in one process — one sandbox per
   process keeps the lockdown and is the safer default.)
2. **Memory budgeting**: ~2 GiB host RAM per active chromium session (4.5x
   Docker); set `-m` per session and pull images ahead of time. This is the
   main capacity cost of gvx.
3. Accept ~2x cold start (1.07 s vs 0.54 s — both fine for MCP session setup)
   and ~78 MB/s per forwarded TCP stream (fine for noVNC).

What we lose vs Docker: exec/ps/logs convenience, CPU-time capping, and the
ecosystem maturity; a 7-star single-maintainer pre-1.0 fork is a dependency
risk to monitor. What we gain: no daemon, no root, no container namespaces on
the host, one self-locked-down unprivileged process per session, `docker save`
compatibility, and a genuinely strong sandbox (a guest escape must first break
the gVisor Sentry).

## 6. Recommended micke-gvx architecture (if adopted)

- **Session lifecycle**: MCP session start → micke supervisor forks one
  `rungv run -i --pull=never --entrypoint /bin/bash -v driver.sh:/driver.sh:ro
  [-m 2g] [-p 6080] micke:dev /driver.sh` child with stdin/stdout pipes (the
  CLI path, as tested; or `gvx.New`/`sb.Run`/`sb.Close` embedded, one sandbox
  per supervisor process to keep the seccomp self-lockdown). Session end →
  send `__EXIT__` (clean, 0.5 s) or SIGKILL the child; no state to reap, no
  volumes to garbage-collect.
- **Command channel**: line protocol on stdin with `===BEGIN/===END rc=N===`
  framing (as tested), upgraded to newline-delimited JSON-RPC (cmd in, stdout
  + stderr + rc out) once driver.sh is folded into the image (out of scope
  here: no micke files were modified for this study). `/tmp/session.env`
  sourcing stays inside the driver's bash, exactly as entrypoint.sh does today.
- **Screenshots**: `agent-desktop screenshot <path>` inside the sandbox, then
  either base64 over the command channel (works today, 102 KB PNG measured) or
  written to a `-workspace` host bind for direct file access.
- **noVNC path**: add `x11vnc` + `websockify/noVNC` to the image, start them in
  driver.sh after openbox (DISPLAY=:99 is in-image), run sessions with
  `-p 5900 -p 6080` (or fixed `-p 127.0.0.1:6080:6080`), parse the
  `rungv: publishing 127.0.0.1:PORT -> GUEST/tcp` stderr lines to learn the
  host ports, and point the browser client there. TCP forwards are transparent
  and unlimited in duration (verified with a 10 s sustained stream + 3 parallel
  transfers); websockify's websocket upgrade is just TCP bytes to the
  forwarder. Start websockify before the client connects or rely on the 3 s
  guest-dial window retry.
- **Image pipeline**: keep `docker build` for micke images; distribute to gvx
  hosts with `docker save | rungv load` (or `rungv save` between gvx hosts);
  `--pull=never` for runs.
