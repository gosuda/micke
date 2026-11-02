# gvx runtime swap — design document

> **Implementation status (2026-11-02): SHIPPED.** The code below is now the
> real runtime: `src/gvxio.ts` replaces `src/dockerio.ts`, `src/supervisor.ts`
> uses pidfiles/adoption, `src/shell.ts` speaks TCP to `image/driver.sh`, and
> the tests run against gvx. One deviation found during implementation: rungv
> v0.4.1 rejects explicit tmpfs mounts at/below `/dev` ("the guest path must
> not be /dev or below it"), so the spawn omits `--tmpfs /dev/shm:size=1g` and
> relies on gvx's default `/dev/shm` (half host RAM). Child stdout/stderr go to
> a per-session **file**, not a pipe, so a daemon crash cannot break the
> surviving sandbox's next log write.

Date: 2026-11-02. Design only — no code changed for this document. Repo:
`~/git/micke`. Inputs read: `docs/research/gvx-only-analysis.md` (§10 owner
MUST; §1–§8 the OLD stdin-driver regressions), `docs/research/gvx-feasibility.md`
(§4.1 ingest, §4.5/§4.8 memory/OOM, §4.7 ports, §6 architecture),
`docs/research/http-daemon-design.md` (implemented — the stdio→HTTP daemon
migration landed; its §5 Docker re-attach is SKIPPED as throwaway per
analysis §10), `src/{dockerio,
supervisor,shell,mcp,main,dashboard}.ts`, `tests/*.ts`, `image/*`,
`docs/prd.md`, `docs/server-internals.md`, `README.md`,
`.github/workflows/image.yml`, and the JUST-COMPLETED socket-driver experiment
at `/tmp/opencode/gvx-socket-exp/` (RESULTS.md + all logs — **/tmp is
ephemeral; this document is the permanent receipt**).

## 1. Decision & rationale

**Owner MUST (2026-11-02, analysis §10): Docker is removed as a runtime;
gvx is the only runtime.** The owner's three rebuttals (build → ghcr/save-load
distribution; exec → socket channel; RAM → owner-managed with FR-18/31/32
hygiene) were each proven by the socket-driver experiment run the same day.
This design implements that decision; it does not re-litigate it.

### 1.1 Experiment verdict table (preserved from RESULTS.md, 2026-11-02)

Question: can the shell channel be a TCP listener inside the sandbox (reached
via rungv `-p`), such that the sandbox survives micke-daemon death and a NEW
daemon re-attaches to the still-booted desktop — with NO exec equivalent?

Setup: rungv v0.4.0 (`c43053f5`), image `micke:novnc` from
`-cache-dir /tmp/opencode/gvx/cache --pull=never` (no pulls ever). Guest
driver: `socket-driver.sh` (Appendix A, verbatim) — boots the desktop via the
REAL `/usr/local/bin/micke-entrypoint` as a child, then a `python3` TCP
listener on guest :7801, one bash per connection running the `__micke_run`
handler adapted from `src/shell.ts` INIT. Host client: `client.py`
(parseFrame mirror). Fake daemon: `start-session.sh` (spawns rungv, parses
ports from stderr, writes `session.json`).

| P | Verdict | Key evidence (log) |
|---|---------|--------------------|
| P0 listener inventory | PASS | python3 (`/usr/bin/python3`) + node v18.20.4 present; socat/ncat/nc/netcat/tmux/sshd MISSING — and NOT needed. Fallback proven: `apt-get install -y socat` works under gvx as `-u 0:0` (socat 1.7.4.4, `apt-root.log`). Image can listen with NO change. |
| P1 boot + channel | PASS | `. /tmp/session.env && agent-desktop status` over TCP 127.0.0.1:38357 → accessibility granted (`p1-status.log`). No `-i`; stdin `/dev/null`. |
| P2 framing + persistence | PASS | Same connection: `cd /tmp && export SOCKETEXP=gvx42` then `pwd`→`/tmp`, `echo`→`gvx42`; `exit 7` → rc=7 with stderr routed; `sleep 30` @tmo 1500 → `===TIMEOUT===` rc=143 and the shell survived the next command (`p2-framing.log`). **`__micke_run` works VERBATIM over TCP under systrap, per-command process-group timeout included.** |
| P3 daemon-death survival | PASS | `kill -9` on the spawner → rungv (pid 901654) SURVIVED, reparented ppid=1; desktop alive (status granted, Xvfb+openbox running); shell port serving frames; noVNC port http 200 (`p3-after-kill.log`). **rungv has NO parent-death semantics.** |
| P4 re-attach | PASS | Fresh controller process → same port: fresh bash (pwd=`/home/agent`, env unset — Docker-exec parity), `agent-desktop launch chromium …example.com` → wait "Example Domain" found in **121 ms** → snapshot **ref_count=83** (Docker baseline parity; `p4-reattach2.log`). Reconnect = fresh shell (cwd/env reset) — same contract as Docker's fresh `docker exec`. |
| P5 discovery primitives | PASS | stderr line `rungv: publishing 127.0.0.1:38357 -> 7801/tcp` (identical shape for 6080); pidfile `session.json` {rungv_pid, shell_host_port} + `/proc/<pid>` liveness + cmdline-contains-rungv identity guard + negative control (pid 999999); `pgrep -f 'rungv run'` cross-check (beware probe self-match); `/dev/tcp` connect check. |
| Bonus memory | ~372 MiB | Host `free` delta for desktop+chromium (9 guest chromium procs). Tree sums mislead: naive RSS 8.14 GiB (stub share-mapping inflation), smaps PSS sum 4.98 GiB (overcounts — exceeds total host used 4.4 GiB). **Keep feasibility's ~1.8–2 GiB/session as the planning budget.** |

**Consequence recorded in RESULTS.md:** socket channel + daemon-crash
survival + re-attach: VIABLE. The gvx-only analysis §2 regressions ("daemon
dies → every desktop dies", "black hole", "re-attach has no meaning") are all
**overturned by construction**.

### 1.2 Exact invocation (receipt, verbatim from the experiment)

```
rungv run \
  -cache-dir /tmp/opencode/gvx/cache --pull=never \
  --entrypoint /bin/bash \
  -v /tmp/opencode/gvx-socket-exp/socket-driver.sh:/socket-driver.sh:ro \
  -h micke-gvx-sock \
  -p 7801 -p 6080 \
  micke:novnc /socket-driver.sh \
  </dev/null >rungv.out 2>rungv.err
```

Child stderr (verbatim, `rungv.err` — the two `publishing` lines are the port
record; ports are pre-bound before seccomp lockdown and guest start, so they
appear within ~1 s of spawn):

```
rungv: platform=systrap
rungv: warning: the hardware hypervisor is not available, so the guest runs on systrap, which is slower: gvx: execution platform unavailable: no hypervisor backend for linux
rungv: publishing 127.0.0.1:38357 -> 7801/tcp
rungv: publishing 127.0.0.1:40021 -> 6080/tcp
socket-driver: listening on 0.0.0.0:7801
```

Image gaps at experiment time: (1) the cached `micke:novnc` is an OLD build
without `/usr/local/bin/micke-chromium` — **cache refresh required before any
implementation verification** (§6.3); (2) no socat/nc — irrelevant, python3 is
the listener.

### 1.3 Kill-semantics probes (run for this design, 2026-11-02)

The experiment proved spawner-death survival (P3) but never killed the rungv
pid itself; `session_close` needs exactly that. Two probes
(`/tmp/opencode/gvx-kill-probe/`, script deleted after; same cached image,
`--pull=never`, socket driver bind-mounted, desktop-only — no chromium):

| Probe | Signal | Result |
| :-- | :-- | :-- |
| A | SIGTERM rungv pid | dead in **111 ms**, `wait` rc=1, stderr tail `rungv run: context canceled`; port refused after; **zero stray processes** |
| B | SIGKILL rungv pid | dead in **114 ms**, rc=137; port refused; **zero stray processes** |

Both probes: 18 rungv children (systrap stubs) observed alive before the kill,
**all gone after** — the process tree dies WITH the rungv pid. Guest root
writes are an ephemeral memory layer (feasibility §1), so teardown leaves
nothing on disk. Conclusion: **kill = SIGTERM with a short SIGKILL escalation;
disposable teardown; ~0.11 s measured.** Cleanup verified: `pgrep -af rungv`
empty, probe ports released, micke supervisor (pid 897901) and all Docker
containers untouched.

### 1.4 Why this design is now sound

Every gvx-only blocker named in analysis §9 is answered by a receipt, not an
expectation: exec → socket channel (P1/P2/P4); detached survival → P3 (no
parent-death semantics, pidfile discovery P5); re-attach → P4 (fresh bash per
connection, desktop + logins survive); memory → owner-managed with the
feasibility numbers kept as planning budget; builds → ghcr workflow (live,
`.github/workflows/image.yml`) + save→load fallback (feasibility §4.1).
Remaining risks are enumerated in §13 and accepted by the owner (§10 of the
analysis).

## 2. Architecture — the runtime seam

`src/dockerio.ts` (96 lines) is the de-facto runtime shim; it dies and is
replaced by `src/gvxio.ts`. Function-by-function mapping (line numbers from
today's file):

| # | Docker today (dockerio.ts) | Call sites | gvx replacement | Verdict |
| :-: | :-- | :-- | :-- | :-- |
| 1 | `docker()` :13-28 — captured CLI spawn | all | `rungv()` — same shape, spawns the `rungv` binary (path from `PATH`; `MICKE_RUNGV` override for dev) | trivial rename |
| 2 | `dockerAvailable()` :31-34 — daemon health | supervisor :117 | `rungvAvailable()` — `rungv version` rc==0 (no daemon exists; binary sanity only) + `rungv stub` optional; error code `DOCKER_UNAVAILABLE` → `RUNGV_UNAVAILABLE` | ~8-line rewrite |
| 3 | `imageExists(ref)` :37-40 — `docker image inspect` | supervisor :235 | `rungv images -cache-dir <dir>` table parse (REPOSITORY/TAG docker-like; empty list = missing) | ~15-line rewrite |
| 4 | `pullImage(ref)` :42-45 | supervisor :243 | `rungv pull -cache-dir <dir> <ref>` — BUT a pull is an in-memory layer compile (feasibility §4.8 OOM incident), so FR-31/32 serialization is now the OOM-avoidance mechanism, not hygiene | maps, keep lock |
| 5 | `hostPort()` :48-53 — `docker port`, re-queryable any time | supervisor :142, :343 | **deleted.** Ports are knowable at LAUNCH ONLY, from the child's stderr `rungv: publishing 127.0.0.1:<host> -> <guest>/tcp` lines — parsed once at spawn AND re-readable from the pidfile after daemon restart (P5). No re-query exists or is needed: forwards are pre-bound and live for the run (feasibility §4.7) | different model, simpler |
| 6 | `listLabeledContainers()` :62-81 — label scan (session identity) | supervisor :211, :331 | **deleted.** Identity becomes the per-session pidfile `<state>/sessions/<id>.json` (§3.1); "scan" = readdir + `/proc` check + cmdline guard | pidfile scan |
| 7 | `removeContainer()` :83-85 — `docker rm -f` | supervisor :144, :156, :162, :183 | **deleted.** Kill the rungv pid: SIGTERM, escalate SIGKILL after ~3 s (§1.3: 111 ms / 114 ms, zero strays, tree dies with the pid) | child kill |
| 8 | `containerLogs()` :88-91 — polled for the ready line | supervisor :153 | **deleted.** The child's stderr is a live pipe from t=0; a reader task parses publish lines, watches for the ready line, keeps a 4 KiB tail for error hints (same pattern as shell.ts `stderrTail`). No polling CLI | simpler |
| 9 | `containerRunning()` :93-96 — `docker inspect` | supervisor :155 | split: own children → `proc.exited` promise; adopted children (post-restart) → `/proc/<pid>` existence + cmdline guard (P5, pid-reuse safe) | two cheap paths |

New in `gvxio.ts` (no Docker counterpart): the spawn itself (today's `docker
run` is inline in supervisor.ts :128-136) — `spawnSession({...})` builds and
starts the foreground child (§3.2); `readPidfile`/`writePidfile`/`listPidfiles`
+ `procMatches(pid, sessionId)` (the `/proc/<pid>/cmdline` guard: argv[0]
basename `rungv` AND argv contains `-h micke-<id>` — the hostname embeds the
session id, so pid reuse cannot fool adoption).

**Session identity:** Docker's `--label micke.session=<id>` dies; identity =
session id → pidfile (rungv_pid + both ports + metadata). The pidfile IS the
label: it survives daemon death (P3), is discoverable by the next daemon (P5),
and `session_close` resolves it to a killable pid (§1.3).

## 3. Session lifecycle

### 3.1 State layout

```
<state dir>/                       (MICKE_STATE_DIR, default ~/.local/state/micke)
├── supervisor.lock                (flock, FR-19 — unchanged)
└── sessions/
    └── <id>.json                  ONE file per session, the pidfile:
        { "session_id": "<8-hex>", "rungv_pid": 12345,
          "shell_host_port": 38357, "novnc_host_port": 40021,
          "hostname": "micke-<id>", "image": "...", "workspace": null,
          "screen": "1280x800x24", "created_at": 1790000000000 }
```

`sessions.json` (single flat file, supervisor.ts :322-365) is **replaced** by
the per-session files. Reasons: (a) `writeFileSync` of one aggregate file
means a crash mid-write destroys EVERY session record — the pidfile is the
adoption source of truth, so per-file atomic writes (write temp + rename) are
the honest shape; (b) the orphan/adoption scan is a natural readdir; (c) the
shape matches the experiment's `session.json` receipt (P5). `loadState`/
`saveState`/`scanOrphans` collapse into `writePidfile`/`readPidfile`/
`scanSessions` (~net −20 lines).

`LiveSession` fields change: `container_id`/`container_name` → `rungv_pid`/
`hostname`; add `shell_host_port`. `SessionRow` follows (dashboard.ts uses
only session_id/status/uptime/novnc_url — unaffected).

### 3.2 create

`createSession` (supervisor.ts :103-121) keeps its order: cheap validation
(screen regex, workspace absolute+exists, `checkMemoryFloor`) →
`rungvAvailable()` → `withBootLock(bootSession)` (FR-18/19/31/32 all
unchanged). `bootSession` (:123-174) is rewritten around one foreground child:

1. `ensureImage(image)` — `imageExists` → `rungv pull` under the lock
   (identical policy, new verbs; hint text says `rungv pull`).
2. `id = randId()`; spawn (Bun.spawn, `stdin: "ignore"`, `stdout: "pipe"`,
   `stderr: "pipe"`):
   ```
   rungv run -cache-dir <cache> --pull=never \
     -h micke-<id> -m <MICKE_SESSION_MEMORY, default 2g> \
     --tmpfs /dev/shm:size=1g \
     -e MICKE_SCREEN=<screen> \
     [-v <workspace>:/workspace] \
     -p 7801 -p 6080 \
     <image>
   ```
   No `--entrypoint` override (the driver is the image ENTRYPOINT, §5); no
   `-d`, no `--init` (Sentry is PID 1/reaper), no `--shm-size` (bounded via
   `--tmpfs` instead — §7). `-p 7801`/`-p 6080` with auto host ports.
3. A stderr reader task (started immediately) parses the two
   `rungv: publishing 127.0.0.1:<port> -> <guest>/tcp` lines (regex receipt:
   `^rungv: publishing 127\.0\.0\.1:(\d+) -> (7801|6080)/tcp$`). Both lines or
   bust within ~5 s (ports are pre-bound before guest start — §1.2); missing →
   `GVX_ERROR`, kill child, no pidfile.
4. Readiness: wait for the driver's `micke: desktop ready` line on the SAME
   stderr pipe (driver emits it after session.env + noVNC port are up — §5.3;
   the string is today's `READY_LINE` supervisor.ts :71, unchanged) within
   `MICKE_BOOT_TIMEOUT_MS` (default 30 s). Child exit during boot →
   `DESKTOP_BOOT_TIMEOUT` with the stderr tail (replaces the `containerLogs`
   slice). Belt-and-braces: the first TCP connect also gates on
   `===SHELL_READY===` (handler-side, P1) — but the ready line remains the
   session_create contract, same as today.
5. Write the pidfile; register the LiveSession (`shell: null` — lazy);
   return the row (novnc_url from `novnc_host_port`).

### 3.3 The ONE persistent connection model (shell contract)

- The host `ShellChannel` connects ONCE per session — lazily, on the first
  `session_shell` (the lazy-open contract of supervisor.ts :203-206 survives).
  It HOLDS that TCP connection for the session's life.
- **Fresh bash per CONNECT, not per command.** Each TCP connection is served
  by a new `bash /tmp/handler.sh` (driver forks per connection — Appendix A).
  Within one connection, cwd + exported env persist per command (P2 receipt:
  `/tmp` + `SOCKETEXP=gvx42` both survived; the `__micke_run` env-diff
  machinery, unchanged).
- **Reconnect = fresh shell**: new connection, cwd/env reset to the image
  defaults + `/tmp/session.env`. Exactly Docker's fresh-`docker exec` contract
  (P4 receipt: pwd=/home/agent, env unset) — and exactly the http-daemon
  design §5 "what re-attach does NOT restore" list. Documented, not silent.
- One in-flight command per session (the promise queue, shell.ts :268-274)
  is unchanged.

### 3.4 close

`closeSession` (:176-188): resolve live-or-pidfile state → kill shell socket →
SIGTERM `rungv_pid`, escalate SIGKILL after ~3 s (§1.3) → await exit (both
probes < 120 ms) → delete pidfile → row gone. Guest root writes were a memory
layer; nothing else to clean ("disposable teardown" — FR-4's
bit-for-bit-next-session property holds by construction). Tool result field
`container_removed` → `sandbox_removed` (same meaning, honest name).

### 3.5 Daemon death = children survive (documented FEATURE)

P3 receipt: SIGKILL the daemon → rungv reparents to ppid=1, desktop alive,
both ports serving. The old analysis §2 regression is inverted and becomes the
product contract: **sessions outlive the daemon** — desktops, chromium
windows, and human noVNC logins (FR-47) survive micke crashes, upgrades, and
systemd restarts. Graceful shutdown (main.ts :86-94) kills shell SOCKETS only;
rungv children stay, mirroring today's "containers stay and become adoptable
orphans" semantics — except adoption now really re-attaches (§3.6).

### 3.6 Daemon restart adoption (replaces the skipped Docker §5 machinery)

On `Supervisor.start()`, AFTER flock and BEFORE main.ts binds HTTP (startup is
single-threaded and pre-bind, so the http-daemon design's `adoptLocks` race
cannot exist by construction — two clients can never hit adoption
concurrently):

1. `readdir(<state>/sessions/*.json)` — every pidfile is a candidate.
2. Liveness: `/proc/<pid>` exists AND cmdline guard matches (`rungv` +
   `micke-<id>`, §2). P5 receipt, pid-reuse safe (negative control: pid 999999
   rejected).
3. Alive → register as **ready** with the pidfile's ports (`shell: null`;
   novnc_url known — the port record survived the crash IN THE FILE, which is
   what Docker needed `docker port` re-query for). First `session_shell` opens
   a fresh TCP connection = fresh bash into the STILL-BOOTED desktop (P4:
   chromium wait 121 ms, ref_count 83).
4. Dead pid → row listed as `orphaned` (close-only; honest — the sandbox is
   gone), `session_close` reaps the pidfile. `SESSION_ORPHANED` now means
   exclusively "pidfile present, sandbox dead".

Mid-run death (rungv killed behind our back): `listSessions`' cross-check
(:210-217, today a label scan) becomes the `/proc` guard per row — dead rows
are dropped from the live map exactly as "container crashed" rows are today.

## 4. Shell channel rewrite (host side, shell.ts)

**What survives VERBATIM:** the frame parser `parseFrame` :129-153 (P2 proved
the byte protocol identical over TCP; client.py's mirror parsed every frame
first try) and the whole `run`/`runOnce` body :268-327 — queueing, request
line format `__micke_run <tmo> <limit> <b64>\n`, host-side backstop
(`timeout + 15 s`), defensive re-cap, `ShellResult` shape. The `__micke_run`
wrapper itself moves into the image (Appendix A, already byte-equivalent to
INIT :29-111 minus the readiness tail).

**What changes:**

| shell.ts today | gvx shape |
| :-- | :-- |
| `INIT` constant :29-111 (written to the exec'd bash at start) | **deleted from the host** — the handler lives in the image (`/tmp/handler.sh` written by the driver, Appendix A). Host sends ONLY `__micke_run` request lines. |
| `start()` :173-195 — `Bun.spawn(["docker","exec","-i",…,"bash"])` :175 | `connect()` — `await Bun.connect({ hostname: "127.0.0.1", port: shell_host_port })`; readiness = first `===SHELL_READY===\n` marker on the socket (per-connection, handler-side; replaces INIT's marker). Connect retries during early boot (~30×1 s proven in client.py) — though session_create's ready-line gate means the desktop is up before any connect. |
| proc stdout/stderr pipes :197-224 | socket `data`/`close`/`error` events; the ready-marker consumption and `tryExtract` flow are unchanged (same buffer, same `frameWaiter`) |
| `write()` :247-252 (`proc.stdin.write`) | `socket.write` + `flush` |
| `kill()` :329-340 (end stdin, kill(9) the exec child, reap) | `socket.end()` + `socket.destroy()` — no child exists; the SANDBOX is not touched (channel death ≠ session death, same as today) |
| `die()` :254-266 | same, plus: the channel becomes **reconnectable** — see below |

**Reconnect policy (new, better than Docker):** because the desktop survives
channel death (P3/P4), a dropped connection is recoverable: the in-flight
command rejects with `SHELL_UNAVAILABLE` (honest — its bash died mid-frame),
the NEXT `run()` lazily reconnects (fresh bash, cwd/env reset — the §3.3
contract). Today a dead channel requires close+recreate of the session; under
gvx the supervisor keeps the row `ready` and the channel self-heals. FR-14's
"no silent half-state" is honored: the reset is documented in the tool
description and the error message says "reconnected with a fresh shell; cwd/
env were reset".

**Listener SPOF supervision — chosen: in-guest respawn loop.** The python
listener is now the channel's single point of failure. Two options were on the
table: (a) supervise/respawn inside the driver; (b) host-side detect-only
(connect-refused + `/proc` liveness → honest `SESSION_ERROR`). **Pick (a),
with (b) as the free backstop.** Justification: the listener is tiny and
stateless (state lives in per-connection bashes), so respawn is cheap and
correct; and the entire POINT of P3/P4 is that a human may have logged into
that desktop over noVNC (FR-47 — the credential never entered a transcript) —
letting a python crash (OOM blip, fd exhaustion, bug) destroy a logged-in
desktop re-introduces the daemon-death regression through the back door.
Respawn shape (driver, §5.3): a bash `while` loop around `python3 server.py`
with a 0.5 s delay and a stderr notice (`socket-driver: listener exited rc=N,
respawning`); if it crashes >10 times in 60 s the driver exits 1 (sandbox
dies, supervisor reports honestly — no infinite crash-burn). The host-side
backstop covers the other failure mode for free: connect-refused while
`/proc/<pid>` says alive → one retry after the respawn delay, then
`SHELL_UNAVAILABLE` with the stderr tail (which will contain the respawn
notices).

## 5. Driver placement

**Decision: BAKE the driver into the image.** `image/driver.sh` (new, the
productionized Appendix A) is COPYed and becomes the image ENTRYPOINT;
the `-v` bind-mount stays a DEV-ONLY escape hatch (the rungv flag works
regardless; the micke daemon never adds it — one code path, minimalism).

Rationale against bind-at-spawn (the experiment's shape): (1) the distribution
unit is the registry image — a user who `rungv pull`s ghcr.io/gosuda/micke has
no repo checkout to bind; shipping driver.sh alongside the daemon is a
packaging surface for zero product benefit; (2) one less hostfs mount in every
session (the file bind is a verified gvx feature, but it is one more runtime
surface — and §13 flags directory binds as unverified); (3) what CI builds and
what sessions run are the same artifact — tests exercise the shipped driver;
(4) the build pipeline exists NOW (`.github/workflows/image.yml`, live,
rebuilds on every `image/**` push — a driver tweak is a pushed commit, ~2 min
to a fresh `sha-<sha>` tag). The cost — rebuild-per-driver-iteration during
development — is paid only by maintainers, who keep the trivial local
`docker build -t micke:dev -f image/Dockerfile .` + `rungv load` loop
(feasibility §4.1: 8 s).

**Productionized `image/driver.sh` — deltas from the experiment version
(Appendix A):**

1. **Supervised listener** (§4): no `exec python3`; a `while` respawn loop,
   0.5 s delay, stderr notice, 10-crashes-in-60 s → exit 1.
2. **Port from env, not hardcoded 7801**: listener binds
   `${MICKE_SHELL_PORT:-7801}`; the daemon passes `-e MICKE_SHELL_PORT=7801`
   (single source of truth for the guest port; the `-p 7801` pair on the
   spawn line references the same constant in gvxio.ts).
3. **Ready line**: after `/tmp/session.env` appears, additionally `wait_port`
   the shell and noVNC ports (reusing entrypoint.sh :36-45's `/dev/tcp` helper shape)
   before `echo 'micke: desktop ready …' >&2` — so session_create's READY_LINE
   (supervisor.ts :71, unchanged) implies the noVNC forward is dialable.
4. **Early listener**: start the listener BEFORE the entrypoint finishes (the
   per-connection handler self-gates on `/tmp/session.env`, Appendix A :95-99)
   — removes the 3 s guest-dial window from the shell path entirely; the
   desktop ready line still gates session_create.
5. Everything else VERBATIM: handler.sh (`__micke_run` — byte-equal to shell.ts
   INIT), server.py (fork+dup2+exec bash per connection, zombie reaping),
   entrypoint-as-child boot, `/tmp/session.env` sourcing.

`image/Dockerfile`: `COPY image/driver.sh /usr/local/bin/micke-driver` +
chmod + `ENTRYPOINT ["/usr/local/bin/micke-driver"]` (replaces the
micke-entrypoint entrypoint :72; `micke-entrypoint` itself stays in the image,
invoked BY the driver as a child — unchanged file). Note in §11.

## 6. Image & distribution

- **Source of truth: `ghcr.io/gosuda/micke`** (workflow live: tags `latest` +
  `sha-<sha>`, linux/amd64, GHA cache). Docker's ONLY remaining product roles:
  CI build tool and the `docker save | rungv load` ingest fallback. Never a
  runtime dependency.
- **`MICKE_IMAGE` default: `ghcr.io/gosuda/micke:latest`** (was `micke:latest`,
  supervisor.ts :69). Rationale: a gvx-only host has no docker to build with —
  the registry ref is the only zero-Docker path for users; local-tag workflows
  (dev, this host) set `MICKE_IMAGE=micke:<tag>` explicitly. This fires L5's
  "unlocked until the second non-owner user" clause in the honest direction
  (the registry default arrives WITH the swap); digest pinning stays FR-30
  (deferred, unchanged trigger).
- **Cache location: `~/.cache/micke/gvx`** (XDG_CACHE_HOME-aware), passed as
  `-cache-dir` on EVERY rungv invocation (run/pull/images/load). NOT the gvx
  default `~/.cache/gvx/layers` (cache.go:79-97) and NOT a tmpfs: micke owns
  its image lifecycle, the name says whose ~1.4 GiB it is (EROFS per tag;
  document the disk need), FR-37's future disk-reporting has one obvious
  place, and a reboot must not force a re-pull (today's only populated cache
  is `/tmp/opencode/gvx/cache` on a 3.9 G tmpfs — volatile by construction).
- **Bootstrap**: first create with a missing image → `rungv pull` under the
  boot lock (once the ghcr package is public); air-gapped/this-host fallback →
  `docker save micke:novnc -o micke.tar && rungv load -cache-dir <cache> -i
  micke.tar` (verified: 8 s / 388 MB, feasibility §4.1).
- **Runs are ALWAYS cache-only**: `--pull=never` on every `rungv run` (§3.2).
- **Never pull beside a live session (FR-31/32)**: policy unchanged, verb
  becomes `rungv pull`; `withBootLock` (:314-318) and `ensureImage`'s
  live-session refusal (:236-242) survive verbatim. This stops being hygiene
  and becomes the OOM-avoidance mechanism (feasibility §4.8: the host-OOM
  incident was EXACTLY a pull beside a live sandbox; a pull is an in-memory
  layer compile).
- **This host's stale-cache refresh (pre-verification step, required)**: the
  cache holds an OLD `micke:novnc` without `/usr/local/bin/micke-chromium`.
  With 2.2 G free on the 3.9 G tmpfs and ~1.4 GB per tag: `rungv rmi
  -cache-dir /tmp/opencode/gvx/cache micke:novnc` first, then re-`load` the
  fresh build (or point MICKE_GVX_CACHE at the new persistent dir). The
  verification run must confirm `command -v micke-chromium` in-session (the
  P4 receipt shows it missing today).

## 7. Deletion inventory (everything Docker that dies)

| Dies | Where | Replacement |
| :-- | :-- | :-- |
| `docker` CLI wrapper + 8 docker calls | dockerio.ts :13-96 (whole file) | `src/gvxio.ts` (§2) |
| `docker run -d --init --shm-size=1g --pull=never --name --label -e -p` inline args | supervisor.ts :128-136 | foreground `rungv run` child (§3.2); `--init` unneeded (Sentry is PID 1); `--shm-size=1g` → `--tmpfs /dev/shm:size=1g` (gvx default is HALF HOST RAM — 3.9 G here, oversized and counted against `-m` only when used; the tmpfs bound restores the Docker flag's meaning) |
| label orphan scan (`docker ps --filter label=…`) | supervisor.ts :330-354 | pidfile scan + `/proc` guard (§3.6) |
| `docker port` re-query | dockerio.ts :48-53 | pidfile port record (§2 #5) |
| docker retag test bootstrap (`docker images/tag micke:novnc micke:latest`) | phase1 :43-48, phase2 :34-38, leak-cycles :68-72, http-daemon :39-43 | ensure the gvx cache holds the image (`rungv load` once; suites share it) |
| `docker ps` post-close/orphan assertions | phase1 :190, :229; phase2 :133, :169 | `pgrep -f 'rungv run .*micke-<id>'` empty + pidfile gone |
| stray `docker exec` pgrep assertions | phase1 :192; leak-cycles :116-122 | stray-socket check (daemon fd count) + zero rungv processes |
| `docker events` one-pull receipt | phase2 :159-165 | receipt loss accepted (§10): assert both creates pass the image gate (not `IMAGE_MISSING`) + `rungv images` shows the ref; the mutex itself is unchanged code |
| README docker-run quick start + noVNC docker block | README.md :30-47, :71-77 | gvx daemon instructions (`bun start`, MICKE_IMAGE from ghcr; manual `rungv run` example kept as the escape hatch :79-86 already is) |
| server-internals Docker wording ("shelling out to the docker CLI", `docker tag` note, `docker rm -f`, docker-exec protocol header) | server-internals.md passim | gvx equivalents (this design is its source) |
| `MICKE_IMAGE=micke:latest` default | supervisor.ts :69 | `ghcr.io/gosuda/micke:latest` (§6) |
| tool description strings ("Docker image", "removes the container (docker rm -f)") | mcp.ts :32, :45 | OCI-image wording |
| `DOCKER_UNAVAILABLE`/`DOCKER_ERROR` codes | supervisor.ts :118, :138, :145 | `RUNGV_UNAVAILABLE`/`GVX_ERROR` |
| exit-line "containers stay; they become orphaned" | main.ts :90 | "sandboxes survive; the next start adopts them" |

Docker KEEPS: `.github/workflows/image.yml` (build leg) and the save→load
fallback path (docs only — no code). `docs/prd.md` changes are PROPOSED in
§12, not made here.

## 8. Concurrency & guards

- **FR-18 free-RAM floor: unchanged mechanism** (`checkMemoryFloor` :292-311,
  `MICKE_MIN_FREE_MB` default 1024, `/proc/meminfo`, 0 disables). The hint
  text (:308) is WRONG for gvx — "each chromium session holds ~500 MiB" →
  "**under gvx budget ~2 GiB per chromium session (PSS)**". One-line fix.
- **`-m` per session: NEW env `MICKE_SESSION_MEMORY`, default `2g`**, passed
  to every spawn (§3.2). Rationale: feasibility's honest budget is ~1.8 GiB
  PSS measured + headroom; `-m` is a POLLING guard (guest exceeding → exit
  137 with a memory-limit message, docs/cli.md:164), not cgroups — a session
  that grows past it dies mid-task and surfaces as a dead-pid row
  (`SESSION_ORPHANED` on next shell) rather than being throttled. Documented
  contract; tmpfs `/dev/shm` usage counts toward it.
- **Floor × budget interplay**: the floor still guards the HOST, the `-m`
  guards the GUEST. On the 7.8 GiB class host the honest planning cap remains
  ~2 concurrent chromium sessions (feasibility §4.5; bonus RSS measurement
  agrees, §1.1); FR-20 (max-sessions knob) stays deferred with its trigger.
  Operators of small hosts should raise `MICKE_MIN_FREE_MB`; documented next
  to the env.
- **Pull serialization**: `withBootLock` (:314-318) verbatim; `ensureImage`
  refuses while `sessions.size > 0` (:236-242) verbatim. See §6 (this is the
  OOM-avoidance mechanism under gvx).
- **Per-session serialization** (shell queue) and multi-client behavior: the
  http-daemon design §6 contracts are runtime-agnostic and carry over
  unchanged (the parallel implementation owns them).

## 9. noVNC

- Spawn carries `-p 6080`; the host port comes from the publish line at spawn
  (§1.2) and lives in the pidfile — recoverable after daemon death (the exact
  gap PRD FR-16's shrink note flagged: "the gvx stderr parse defers with gvx" —
  the pidfile is what makes it not defer).
- `novnc_url` shape UNCHANGED: `http://127.0.0.1:<novnc_host_port>/vnc.html`
  (supervisor.ts :372). Forwards are plain L4 TCP pipes — websockify is just
  bytes (feasibility §4.7: sustained streams + 3 parallel transfers, ~78
  MB/s, no duration/idle limits).
- The driver's ready line gates on the noVNC listener being up (§5.3 #3), so
  every URL micke ever hands out is dialable at hand-out time — closing the
  3 s guest-dial window concern for the noVNC forward too.
- Dashboard rows come from the same rows as `session_list` (pidfile-backed
  live/orphaned states); dashboard.ts needs ZERO changes (it renders
  session_id/status/uptime/novnc_url only).

## 10. Test migration

All four suites move to gvx sessions (same harness — `spawnDaemon` +
Streamable HTTP client, unchanged; the runtime is behind the supervisor).

| Suite | Changes |
| :-- | :-- |
| `mmin-phase1` | Image prep: retag block (:43-48) → cache-ensure (skip if `rungv images` shows the ref). §10 close assertions: `docker ps` (:190) → `pgrep -f 'rungv run .*micke-<id>'` rc≠0 + pidfile gone; stray check (:192) stays (pgrep). §13 orphan block (:212-232) becomes the **adoption proof**: create → launch chromium + wait window → SIGKILL daemon → restart → `session_list` shows `ready` (adopted, novnc_url present) → `session_shell` works → `agent-desktop wait --window "Example Domain"` still found (desktop survived — in-product P3+P4) → `pwd` = `/home/agent` (fresh-shell receipt) → close. (+~35 lines net) |
| `mmin-phase2` | Cache prep swap (:34-38). Floor test's no-container check (:133) → no rungv processes. Pull-serialization (:140-172): image `hello-world` → pull via `rungv pull` into a THROWAWAY `-cache-dir` (needs network; same as today), drop the `docker events` count (receipt loss, §7), keep the both-pass-the-gate + image-present assertions. Dashboard tests unchanged. |
| `http-daemon` | Cache prep swap only; both tests are runtime-agnostic. |
| `leak-cycles` | Baselines RE-BASELINED: the daemon's children are now one rungv process per live session (plus its stubs are the RUNGV's children, not the daemon's — `childCount()` counts direct children only, so post-close must return to EXACT baseline, same assertion stronger); "zero micke.session containers" (:112) → zero `rungv run` processes; "stray docker exec" (:116-122) → stray-socket check via fd count (already covered by FD_TOLERANCE ±8 — sockets close deterministically; re-baseline only if the run disagrees, documented in-file as today). |
| NEW (folded into phase1 §13, no new file) | daemon-death survival, re-attach + desktop survival, adoption-after-restart — one block covers all three (P3/P4 in-product). Dead-pidfile → `orphaned` row + close-reaps gets a 5-line case. |

**Runtime impact:** gvx cold start ~1.07 s vs Docker 0.54 s (feasibility §4.5)
→ 20 leak cycles +~10 s; the adoption block adds a boot + daemon restart +
chromium session (~+15-20 s); everything else neutral. Estimate: **~70-80 s →
~95-115 s** for `bun test`. The only network dependency stays the one
hello-world pull (phase2).

## 11. File-by-file change plan

| File | Change | Est. lines |
| :-- | :-- | ---: |
| `src/gvxio.ts` (NEW ~110) | `rungv()` spawn helper; `rungvAvailable`; `imageExists` (images-table parse); `pullImage`; `parsePublishLines`; pidfile write/read/list; `procMatches` guard; `spawnSession` argv builder | +110 |
| `src/dockerio.ts` (96) | DELETE | −96 |
| `src/supervisor.ts` (381) | `bootSession` rewrite (spawn, stderr reader, publish parse, ready wait, pidfile) ~70; SessionState/Row fields ~15; `scanOrphans`→`scanSessions` (adoption) ~35; `closeSession` kill path ~10; `listSessions` `/proc` cross-check ~10; `ensureImage`/hints ~8; DEFAULT_IMAGE ~1 | ~150 touched |
| `src/shell.ts` (341) | Delete INIT (−85); `start`→`connect` (TCP + ready marker) +40; socket read/write/kill ~30; reconnect-on-next-run ~15; parseFrame/queue/runOnce untouched | ~170 touched, net ~0 |
| `src/mcp.ts` (153) | Tool description strings (image, close, orphan wording) | ~8 |
| `src/main.ts` (96) | Shutdown log wording | ~2 |
| `src/dashboard.ts` (73) | NONE | 0 |
| `image/driver.sh` (NEW ~175) | Productionized experiment driver (§5.3 deltas over Appendix A) | +175 |
| `image/Dockerfile` (72) | COPY + chmod driver, ENTRYPOINT swap | +4 −1 |
| `image/entrypoint.sh` (83) | NONE (driver invokes it verbatim as child) | 0 |
| `tests/mmin-phase1.test.ts` (235) | §10 | ~+40 |
| `tests/mmin-phase2.test.ts` (172) | §10 | ~+25 |
| `tests/http-daemon.test.ts` (113) | cache prep | ~+5 |
| `tests/leak-cycles.test.ts` (125) | baselines + stray checks | ~+20 |
| `README.md` (142) | Quick start → daemon/gvx; noVNC block; rungv install note | ~+30 |
| `docs/server-internals.md` (199) | Runtime sections rewrite (this doc is the source); env table +`MICKE_SESSION_MEMORY`/`MICKE_GVX_CACHE`/`MICKE_RUNGV`; lifecycle/adoption; protocol note (handler in-image) | ~+70 |
| `.github/workflows/image.yml` (70) | NONE (already the gvx-only distribution leg) | 0 |
| `docs/prd.md` | NOT EDITED HERE — amendments proposed in §12 | 0 |

Totals: **src ≈ +70 net** (~340 touched across gvxio+supervisor+shell+mcp/
main, −96 deleted), **image ≈ +180**, **tests ≈ +90 net**, **docs ≈ +100**.
Overall ≈ **+440 net / ~740 touched** against the ~1,700-line codebase — the
same order as the http-daemon migration, concentrated in exactly the two
files that design deliberately left alone (analysis §3 said so).

## 12. PRD amendment PROPOSAL (prd.md NOT edited by this document)

| Item | Today | Proposed |
| :-- | :-- | :-- |
| **FR-2** (runtime selector, deferred) | "Runtime selector on create: docker (default) or gvx (opt-in)" — deferred (trigger: gvx ships) | **CUT.** "One runtime, no selector: gvx is the only runtime (owner MUST 2026-11-02, analysis §10). A `runtime` parameter is a non-goal permanently." |
| **FR-15** (one host process per session) | "One host process per session owning the runtime child (Docker container, or foreground rungv run -i)" | Keep, reworded: "Each session is ONE foreground `rungv run` child spawned by the daemon. The daemon is the spawn-of-record (pidfile: pid + ports), not the lifetime parent — children intentionally SURVIVE daemon death (experiment P3) and are re-adopted by the next start (P4/P5)." |
| **FR-16** (per-session port allocation) | "Docker `-p` with host-chosen ports … shrunk: Docker `-p` only; the gvx stderr parse defers with gvx" | Un-shrink, reworded: "Per-session ports via gvx `-p 7801 -p 6080` (host port auto-assigned); host ports parsed from the `rungv: publishing 127.0.0.1:<port> -> <guest>/tcp` stderr lines at spawn and persisted in the per-session pidfile — the URL record survives daemon death (no re-query exists under gvx; none is needed)." |
| **FR-38** (Docker default runtime) | "Docker is the default runtime (`--shm-size=1g` …~8 sessions/8 GiB)" | **INVERTED:** "gvx (rungv v0.4.0, pinned) is the ONLY runtime: unprivileged, daemonless, seccomp self-lockdown; `/dev/shm` bounded via `--tmpfs …size=1g`; `-m 2g` default (`MICKE_SESSION_MEMORY`); ~2 concurrent chromium sessions per 8 GiB host (planning number ~2 GiB PSS each). Docker is not a runtime dependency — it survives only as the CI build tool and the `docker save → rungv load` ingest fallback." |
| **FR-39** (gvx opt-in, deferred) | "gvx is an opt-in runtime … deferred (trigger: a user who cannot run dockerd, or gvx v1.0)" | **FIRED → P0:** "gvx is the runtime (see FR-38). The deferral trigger was fired by OWNER DECISION 2026-11-02, not by the upstream events it anticipated; the v0.4.0 API-stability risk is ACCEPTED (pinned binary, §13)." |
| L6 (locked table) | "Docker primary — locked; gvx demoted to verified design, deferred backend" | "gvx-only — locked (owner MUST 2026-11-02); Docker removed as a runtime, retained as CI build tool + save→load fallback" |
| L7 (locked table) | "Supervisor: one host process per session, owns ports/URL discovery, serves dashboard" | Amend the discovery clause: "owns port/URL discovery (launch-time publish-line parse persisted in the pidfile) and post-restart adoption" |

Ripple amendments (secondary, same edit): FR-8 (Docker-exec backend) →
rewritten as the socket-channel backend (FR-9's mechanism, TCP form); FR-9
(gvx framing, deferred) → un-deferred, becomes THE shell channel definition
(socket driver, not stdin); FR-40 (parity) → moot as a standing promise
(single runtime; the 83-ref parity receipt stays banked as evidence);
FR-30/34 (image defaults) → default ref `ghcr.io/gosuda/micke:latest`
(L5's unlocked clause exercised); FR-31/32 verbs → `rungv pull` (semantics
unchanged, now the OOM-avoidance mechanism); FR-18 hint text → ~2 GiB/session.

## 13. Risks & unknowns + out of scope

1. **gvx v0.4.0 pinned (`c43053f5`), pre-1.0 API churn — ACCEPTED by owner**
   (analysis §10). Exposure surfaces in THIS design: the CLI flags (§3.2
   argv), the `rungv: publishing …` stderr line format (parsed at every
   spawn), the EROFS cache format (invalidation = full re-load), `rungv
   images` table shape. All are behind gvxio.ts; a v0.5 break is one file +
   the pinned-binary bump. Single-maintainer bus factor stands (PRD risk 9)
   with the Docker-primary mitigation now gone — the owner accepted this.
2. **Verification cache is on a quota'd tmpfs** (3.9 G total, 2.2 G free,
   ~1.4 GB per tag): the refresh (§6) must `rungv rmi` the stale tag first or
   point at a fresh cache dir; production uses `~/.cache/micke/gvx` on real
   disk (documented ~1.4 GiB/tag need — FR-37 relevance rises).
3. **Workspace directory bind via `-v` is UNVERIFIED under gvx on this host**
   (the experiment bound a single FILE read-only; FR-45 needs a directory
   bind, rw, with the guest writing back). Also unknown: `flock` semantics
   over hostfs binds (agents run git in /workspace). Mitigation: one
   pre-implementation probe (create + write-back + `git init` in a bound dir)
   gates the FR-45 test; if hostfs is unfit, the fallback is the SDK's
   ext4lite volume or deferring FR-45 — an owner call if it fires.
4. **`-m` is a polling guard, not cgroups** (exit 137 mid-task), and
   `--cpus` caps CPU only on Windows. A session that balloons dies rather
   than throttles — documented contract (§8); the FR-18 floor is the host's
   real protection.
5. **Listener SPOF** — mitigated by the respawn loop + crash cap (§4); the
   residual is a driver-level death (bash PID-equivalent dies → sandbox
   exits → dead-pid row, honest `SESSION_ORPHANED`), covered by the host-side
   backstop.
6. **Child/fd baselines shift** (rungv + 18 stubs vs docker exec) — leak
   tests re-baseline (§10); the kill probes show zero strays, so the stronger
   exact-children assertion should hold.
7. **systrap-only on this host** (no hypervisor backend on Linux — the
   warning on every run, §1.2): ~2x cold start and the memory multiplier are
   the permanent local reality; a future KVM-capable host changes only
   performance, not design.
8. **State-dir wipe leaks sandboxes**: pidfiles are the only adoption record;
   deleting the state dir while sessions live orphans them irrecoverably-by-
   micke (still killable via `pgrep -f 'rungv run .*micke-'`). Documented as
   an ops hazard next to the state dir; no sweep code (minimalism).

**Out of scope (explicit):** the HTTP transport layer (owned by the parallel
http-daemon implementation — this design touches only supervisor/shell/
gvxio/mcp-wording); image content changes beyond the driver (chromium,
agent-desktop versions); digest pinning (FR-30) and cache hygiene tooling
(FR-37); max-sessions knob (FR-20); cgroup-style limits; multi-host; a
micke-internal daemon-restart supervisor (systemd's job — and P3 makes
restarts cheap now); upgrading gvx past v0.4.0 (pinned).

## Appendix A — experiment's socket-driver.sh (VERBATIM receipt)

Source: `/tmp/opencode/gvx-socket-exp/socket-driver.sh` (2026-11-02; /tmp is
ephemeral — this copy is the record). The productionized `image/driver.sh`
(§5.3) differs ONLY by: supervised listener loop instead of `exec python3`,
`MICKE_SHELL_PORT` env instead of hardcoded 7801, the desktop-ready stderr
line gated on the noVNC port, listener started before the entrypoint wait.

```bash
#!/usr/bin/env bash
# gvx socket-driver experiment — guest entrypoint (P1/P2).
#
# Boots the micke desktop by running the REAL image entrypoint
# (/usr/local/bin/micke-entrypoint) as a child (it re-execs itself under
# dbus-run-session, boots Xvfb/AT-SPI/openbox/x11vnc/websockify, writes
# /tmp/session.env, then sleeps forever). Then serves the micke shell
# protocol on TCP :7801: ONE bash per connection, running handler.sh —
# an adaptation of src/shell.ts INIT (__micke_run framing wrapper).
#
# stdin is NEVER read: the TCP socket is the only shell channel.
set -u

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -m 700 -p "$XDG_RUNTIME_DIR" 2>/dev/null || true

# ---- handler.sh: per-connection bash, adapted from src/shell.ts INIT ----
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

# ---- server.py: TCP listener, fork+dup2+exec bash per connection ----
cat >/tmp/server.py <<'SERVER_EOF'
import os, socket, sys
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 7801))
srv.listen(16)
sys.stderr.write("socket-driver: listening on 0.0.0.0:7801\n")
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

# ---- boot the desktop via the real image entrypoint (as a child) ----
/usr/local/bin/micke-entrypoint >/tmp/entrypoint.log 2>&1 &

i=0
while [ "$i" -lt 300 ] && [ ! -f /tmp/session.env ]; do sleep 0.1; i=$((i+1)); done

exec python3 /tmp/server.py
```
