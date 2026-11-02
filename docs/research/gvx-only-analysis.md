# gvx-only analysis: could micke drop Docker?

Date: 2026-11-02. Question (owner): could micke support ONLY gvx as its runtime,
dropping Docker entirely? Analysis only — no code changed. Inputs read:
`docs/research/gvx-feasibility.md` (banked verified design), `docs/research/
http-daemon-design.md` §1/5/6 (JUST-APPROVED, not implemented), `docs/prd.md`
(L1–L7, FR-15/16/18/38/39, §5–8), `src/{dockerio,supervisor,shell}.ts`,
`image/{Dockerfile,entrypoint.sh}`, plus the local gvx clone `~/git/gvx`
(HEAD `c43053f`, v0.4.0) and its `docs/cli.md`, `CHANGELOG.md`, `pkg/oci/cache.go`.

Local re-verification done (trivial checks only, no sessions run):

- `rungv version` → `rungv v0.4.0, commit c43053f5ca68b15ac675e1c78d97ece18b598aab,
  go1.27.3 linux/amd64` — binary present at `/tmp/opencode/gvx/rungv-v0.4.0-linux-amd64/`,
  matches feasibility §4.
- Cache state: `/tmp/opencode/gvx/cache` = 1.4 GB on tmpfs (`/tmp` = 3.9 G total,
  1.8 G used) holding THREE tags: `micke:novnc`, `python:3.12-alpine`, `alpine:3.20`.
  The study's `micke:dev` (1.185 GB EROFS, feasibility §4.1) is **gone** — evicted
  with the tmpfs churn. `rungv images` against the DEFAULT cache dir
  (`~/.cache/gvx/layers` on Linux, `pkg/oci/cache.go:79-97`) returns EMPTY: the
  only populated cache on this host is a volatile one.
- gvx clone quotes re-verified: `docs/cli.md:11` (no exec/logs/`-d` "in this
  stage"), `docs/cli.md:210` (command table: `-d`/`ps`/`exec`/`logs`/`stop`/`rm`/
  `restart` "Not available. A run is in the foreground and has no state."),
  `docs/cli.md:164` (exit 137 = memory-limit guard), `CHANGELOG.md:92` (pre-1.0
  API/flags/on-disk-format churn).

## 1. Used Docker surface → gvx mapping

Every capability micke uses today, all of it via `docker` CLI in `src/dockerio.ts`
(96 lines; supervisor/shell call sites in brackets):

| # | Docker today | gvx equivalent (per feasibility) | Verdict |
| :-- | :-- | :-- | :-- |
| 1 | `docker version` health check — `dockerAvailable()` dockerio.ts:31-34 [supervisor.ts:117] | no daemon to check; binary + `rungv stub` sanity | trivial rewrite |
| 2 | `docker image inspect` — `imageExists()` :37-40 [supervisor.ts:235] | `rungv images` list parse (pull policy `missing`/`--pull=never` uses cache first, feasibility §2b) | clean map |
| 3 | `docker pull` — `pullImage()` :42-45 [supervisor.ts:243] | `rungv pull` (verified, PRD FR-33) — BUT pull = in-memory layer compile, a RAM spike (§4.8 below) | maps, worse semantics |
| 4 | `docker run -d --init --shm-size=1g --pull=never --name --label -e -p` — inline args supervisor.ts:128-136 | `rungv run -i` FOREGROUND child, no `-d`, no labels, no `--init` (Sentry is PID1), `/dev/shm` = half host RAM (feasibility §3 row 1) | structural change |
| 5 | `docker port` read-back — `hostPort()` dockerio.ts:48-53 [supervisor.ts:142, 343] | parse `rungv: publishing 127.0.0.1:PORT -> GUEST/tcp` stderr at LAUNCH ONLY; no re-query (feasibility §4.7) | different model |
| 6 | `docker logs` polled for `micke: desktop ready` — `containerLogs()` :88-91 [supervisor.ts:153] | child's stdout is a live pipe from t=0; readiness arrives as a frame | maps, simpler |
| 7 | `docker inspect {{.State.Running}}` — `containerRunning()` :93-96 [supervisor.ts:155] | child liveness (`proc.exited`) — in-process only, no cross-run inspect | partial |
| 8 | `docker rm -f` — `removeContainer()` :83-85 [supervisor.ts:144,156,162,183] | kill the rungv process tree (measured 0.52 s, zero strays, feasibility §3 row 5) | maps (child handle, not CLI) |
| 9 | `docker ps -a --filter label=micke.session` — `listLabeledContainers()` :62-81 [supervisor.ts:211, 331] | **NO equivalent** — no ps, no labels, no state outside the process (`docs/cli.md:210`) | **no equivalent** |
| 10 | `docker exec -i bash` — ShellChannel spawn shell.ts:175 | **NO exec** — stdin line-driver baked into the launch (feasibility §2a) | **no equivalent** |

Also load-bearing today: `--label micke.session=<id>` is the session identity
that survives the supervisor (supervisor.ts:3-4, 130; PRD §1 "container IS the
session identity" in the daemon design §1). gvx has no labels; identity
degrades to "the daemon's child pid + whatever sessions.json remembers".

## 2. Session lifetime model — the regression that decides the question

Docker: **the docker daemon owns containers**. micke supervisor death (crash,
SIGKILL, upgrade) leaves containers alive; they are rediscoverable via the label
scan (`scanOrphans` supervisor.ts:330-354) and — in the approved HTTP-daemon
design §5 — re-attachable: liveness check, port rediscovery (`docker port` again),
promote the row, **open a FRESH `docker exec` shell into the surviving
container** (design §5 steps 1-4). The design's three promises (design §1):
sessions outlive clients, orphan re-attach ("the container is the session
identity (it carries `micke.session=<id>` and survives us)"), multi-client.

gvx: **no daemon, no `-d`, no detach, no state** (`docs/cli.md:210`: "A run is in
the foreground and has no state"). The micke daemon must be the parent of every
rungv child (PRD FR-15 "one host process per session owning the runtime child";
feasibility §6). Consequences, each a broken promise:

- **Daemon dies → every desktop dies.** SIGKILL/EOF on the daemon kills or
  orphans-then-breaks all rungv children. The Xvfb, chromium windows, and any
  human SSO login performed over noVNC (PRD FR-47, §6 R2 flow) are destroyed.
  Regression vs the approved design: daemon crash loses **100% of sessions**
  (0% under Docker); even a *graceful* restart (design §3 "containers STAY and
  become adoptable orphans") becomes total session loss, so every micke upgrade
  or systemd `Restart=on-failure` (design §8) wipes all desks and logins.
- **Orphan re-attach has no meaning.** Re-attach requires opening a NEW shell in
  a SURVIVING session; gvx refuses second attaches by design — the host process
  seccomp-locks itself before the guest starts, "so a second `rungv` process can
  never attach to a running sandbox" (feasibility §2a; `docs/cli.md:11`). No
  exec-equivalent exists or is committed upstream (§7 below). Design §5's whole
  transition diagram (orphaned → ready) and its planned `adoptLocks` mutex have
  nothing to attach TO.
- **Worse than dead: a black hole.** If the daemon is SIGKILLed while an
  independent stdin-holder (the feasibility test's `sleep infinity > fifo`
  pattern, §4.3) keeps a child alive, that sandbox keeps ~2 GiB RAM and its
  forwarded noVNC port but can NEVER again be driven or queried by a new daemon
  — no exec, no ps, no port re-discovery (stderr line is gone with the dead
  daemon's pipe). The only management primitive is finding and killing the pid.
  A gvx-only supervisor must therefore kill its children on EVERY exit path
  (making session-death-on-daemon-death the documented contract) or leak
  uncontrolled sandboxes.
- **Client-disconnect survival still works** (that pain is solved at the HTTP
  layer, design §1 pain 1) — the regression is specifically daemon-death
  survival and re-attach, i.e. design §1 pain 2 and its §5 fix.

Quantified against the approved design's promises: of the three §1 promises,
two degrade — "orphan re-attach" becomes void (no mechanism, upstream-refused),
and "sessions survive micke death" becomes false for the daemon process itself
(survive clients only). PRD FR-47's human-login flow survives agent/client
restarts but not daemon restarts — the credential-never-in-transcript story now
requires the daemon to never restart mid-login.

## 3. Shell channel: stdin-driver replaces `docker exec`

Today (shell.ts, 341 lines): ONE `docker exec -i bash` per session, opened
lazily on first `session_shell` (supervisor.ts:203-206), killed independently of
the session (closeSession :182, listSessions :214, shutdown :228), `__micke_run`
wrapper with `set -m` process groups so a per-command watchdog TERM/KILLs only
the command's group (shell.ts:51-75) while the persistent bash (and the
container) survive.

Under the banked stdin-driver pattern (feasibility §4.3, §6; PRD FR-9), exactly
this changes:

- **The shell is piped through the rungv process stdin from launch.** The
  driver script IS the entrypoint (`--entrypoint /bin/bash -v driver.sh:…
  /driver.sh`): it boots D-Bus/Xvfb/AT-SPI/openbox (entrypoint.sh's job today),
  writes `/tmp/session.env`, then serves one command per line with
  `===BEGIN===`/`===END rc=N===` framing. entrypoint.sh and shell.ts's INIT
  sequence merge into one guest-side script.
- **One shell, baked into the launch command, forever.** Lazy open is
  impossible; a second shell can never be opened (no exec). Shell death =
  driver death = sandbox exit = session death. Today a dead channel leaves a
  live container (server-internals.md:134-141); under gvx the distinction
  disappears. FR-14's dropped-channel semantics degrade to "the session died".
- **What survives verbatim:** the `__micke_run` wrapper body (it is just bash
  inside the sandbox), the base64 request-line encoding, and the host-side
  frame parser (`parseFrame` shell.ts:129-153) — the feasibility's framing is
  the same shape. What must be redesigned: `ShellChannel.start()` (spawn
  `docker exec` → own the session child from t=0), stdout multiplexing (boot
  logs + command frames on ONE pipe, needing framing discipline from t=0),
  `kill()` (channel kill now kills the session), and the lazy-open contract in
  `Supervisor.runShell`.
- **Does gvx-only force a shell.ts redesign? Yes.** The HTTP-daemon design §8
  explicitly budgeted "`shell.ts`/`dockerio.ts` (437 lines, the risky parts)
  are untouched" — its whole cost estimate leans on that. gvx-only rewrites
  both files (§8 below). This is the single biggest scope collision with the
  approved-but-unbuilt daemon work.

## 4. Memory: the honest numbers

From feasibility §4.5 (same host, same image, measured):

| Metric | Docker | gvx v0.4.0 |
| :-- | ---: | ---: |
| RSS/PSS at desktop ready | 157 MiB | ~85 MiB main (+ stubs) |
| + chromium + example.com | 404.6 MiB, 127 PIDs | **1836 MiB PSS**, 78 host procs (4.2 GB naive RSS — stubs share-map; PSS is the honest number) |
| multiplier | 1x | **~4.5x** |
| sessions per 7.8-8 GiB host | ~8+ | **~2** |
| cold start | 0.54 s | 1.07 s |

`-m` is a **polling guard** (guest exceeds → exit 137 with a memory-limit
message, `docs/cli.md:164`), not cgroups: without it the limit is host physical
RAM; with it, a session that grows past `-m` dies mid-task (137) rather than
being throttled. `--cpus` caps CPU time on Windows only (feasibility §3).

**Host-OOM incident (feasibility §4.8):** the first-ever `rungv run alpine:3.20
uname -a` (registry pull + in-memory layer compile) died with SIGKILL while the
micke background session was resident — on the 7.8 GiB host with ~3-4 GiB free,
pull + a second sandbox tripped the host OOM killer; "gvx's own guard only
reacts to its notion of guest memory". Retry from cache was instant. This
incident is why FR-18's free-RAM floor exists; note its hint text says "each
chromium session holds ~500 MiB" (supervisor.ts:308) — true for Docker, 4x off
for gvx.

Honest per-host comparison on this class (8 GiB): Docker ~8 concurrent chromium
sessions; gvx ~2 — a **4x capacity loss**, with a weaker guard (polling vs
cgroups) underneath it. PRD §7's guardrail targets state this exactly
("gvx ≤ ~2.2 GiB (PSS)").

## 5. noVNC port forwarding

Verified under gvx (feasibility §4.7): `-p` forwards are pre-bound before
seccomp lockdown and survive for the run; plain L4 TCP pipes (websockify is
just TCP bytes); correct HTTP responses; a 10 s sustained rate-limited stream
intact; 3 parallel 5 MB transfers at ~78 MB/s each; **no idle/duration/connection
limits for TCP rules**; host port 0 → free port, printed on a stable stderr
line (`rungv: publishing 127.0.0.1:38271 -> 8080/tcp`). Caveats: UDP rules cap
at 1024 sessions, 3 s guest-dial window (start websockify before the client
connects), port *ranges* refused, `-p` needs `-net=nat` (default).

**Does it compose with N sessions + dynamic ports? Yes, but on a different
discovery model.** N sessions = N independent rungv processes, each with its own
`-p 6080` → per-session host port via port 0, exactly like Docker's
`-p 127.0.0.1::6080/tcp` (supervisor.ts:132). The difference: Docker's mapping
is re-queryable at ANY time (`docker port`, used at create supervisor.ts:142 AND
at orphan re-attach design §5 step 2 and orphan scan supervisor.ts:343); gvx's
is knowable only at launch, from the child's stderr, by the process that owns
the child. Lose the daemon → lose the port record → the noVNC URL is
unrecoverable even for a still-alive sandbox. (PRD FR-16 already noted "the gvx
stderr parse defers with gvx".)

## 6. Image & cache

- **Same image: yes, verified.** `docker save micke:dev` (388 MB tar, 9 s) →
  `rungv load -i` ("Loaded image" in 8 s) → compiled EROFS cache 1.185 GB
  (feasibility §4.1); parity proven behaviorally — same 83 snapshot refs on
  example.com under both runtimes (§4.4; PRD FR-40).
- **But builds stay in Docker.** "`rungv build` does not exist; image builds
  stay in Docker" (feasibility §2b/§3). "Drop Docker entirely" is therefore not
  literally achievable today: the maintainer pipeline remains `docker build` →
  `docker save | rungv load` (feasibility §6), and today's tests retag via
  `docker tag micke:novnc micke:latest` (tests/mmin-phase1.test.ts:45-46 etc.).
  gvx-only drops Docker from the *user's session path*, not from the project.
- **Cache reality (re-verified today):** the only populated cache is
  `/tmp/opencode/gvx/cache` — 1.4 GB on a 3.9 G tmpfs, holding `micke:novnc` +
  `python:3.12-alpine` + `alpine:3.20`; the study's `micke:dev` is gone. The
  default dir `~/.cache/gvx/layers` (`pkg/oci/cache.go:79-97`) is EMPTY on this
  host. So today's story is: cache on volatile tmpfs → lost on reboot → every
  image needs an 8 s re-load (or a network re-pull) after reboot. A gvx-only
  micke must pin `-cache-dir` to persistent disk and own its size (each micke
  image ≈ 1.2 GB EROFS; PRD FR-37 cache hygiene, currently deferred, becomes
  load-bearing).
- **"Never pull beside a live session" gets worse.** Under Docker the FR-31/32
  rule (supervisor.ts:233-247) is policy hygiene; under gvx a pull is an
  in-memory layer compile — the §4.8 host-OOM incident is EXACTLY a pull beside
  a live sandbox. The rule stops being conservative and becomes the
  OOM-avoidance mechanism, on a host class where ~2 live sessions already
  consume half the RAM.

## 7. Upstream risk

Facts (feasibility §1/§2d, re-verified in clone): v0.4.0 released 2026-11-02
(same day as this analysis); v0.1.0→v0.4.0 cut within two days; 7 stars, 2
forks, ONE principal author; upstream gVisor pin one week old; `CHANGELOG.md:92`:
"The API of `pkg/gvx`, the flags of `rungv`, and the on-disk formats of the
image store and of `ext4lite` volumes can change before `v1.0.0`."

Roadmap for the missing pieces — **nothing found in the clone**: no exec, no
`-d`, no daemon, no cgroups anywhere in `CHANGELOG.md` or `docs/`; `docs/cli.md:11`
says only "in this stage" (a door ajar, no commitment, 0 open issues to track).
The v0.4.0 changelog's own target list is guest-side (systemd, Docker in the
guest, desktop workloads — feasibility §1), not host-side lifecycle.

Betting the product's ONLY runtime on this means concretely: a v0.5 flag/cache
format change breaks micke at three layers at once (CLI flags, the port-publish
stderr parse, the EROFS cache format — cache invalidation = full re-load of
every image); security fixes chain through one maintainer refreshing a weekly
gVisor pin; and PRD FR-39's own trigger ("gvx v1.0 API stability") is precisely
unmet — v0.4.0 < v1.0. PRD risk 9 already names this ("gvx bus factor …
mitigated by Docker primary / gvx opt-in and the pinned version") — gvx-only
removes the mitigation and keeps the risk.

## 8. Code impact estimate

`dockerio.ts` (96) is the de-facto runtime shim; the honest seam already exists.

| Function | gvx-only fate |
| :-- | :-- |
| `docker()` :13-28 | keep (spawns `rungv` instead) |
| `dockerAvailable` :31-34 | ~5-line rewrite (binary + stub) |
| `imageExists` :37-40 | ~8-line rewrite (`rungv images` parse) |
| `pullImage` :42-45 | maps (rungv pull) |
| `hostPort` :48-53 | **replaced** by launch-time stderr capture |
| `listLabeledContainers` :62-81 | **delete** — no equivalent |
| `removeContainer` :83-85 | replaced by child.kill(9) in supervisor |
| `containerLogs` :88-91 | replaced by child stdout streaming from t=0 |
| `containerRunning` :93-96 | in-process child liveness only |

- `dockerio.ts`: ~60-70 of 96 lines deleted/rewritten; remainder + a new thin
  `rungv` launcher ≈ 40-60 lines. Net ≈ **-96/+60**.
- `supervisor.ts` (381): `bootSession` :123-174 rewritten (foreground child,
  `-m`, stderr port parse, streamed readiness — ~60-80 lines); lazy-shell branch
  :203-207 deleted; `scanOrphans` :330-354 **deleted** (~25 lines) — the orphan
  concept dies with nothing surviving to scan; `shutdown` :226-229 changes
  semantics (kill children = kill sessions, vs "containers stay"); memory-floor
  hint :308 wrong for gvx. ≈ **120-160 lines touched**.
- `shell.ts` (341): `__micke_run` wrapper :29-111 and `parseFrame` :129-153
  survive ~verbatim; `start()` :173-195, lifecycle, `kill()` :329-340, and the
  lazy-open contract redesigned into an own-the-child-from-t=0 channel.
  ≈ **100-150 lines touched**, plus a NEW guest-side `driver.sh` (~40-80 lines,
  folded into the image — an image change every prior design avoided).
- Tests (583): orphan block (phase1), pull-serialization (phase2, hello-world
  via `rungv pull`), leak-cycles' "zero micke.session containers / docker exec
  strays" assertions (child-count based instead). ≈ **60-100 lines touched**.
- The approved HTTP-daemon design's §5 (+35 planned lines, `adoptLocks`) simply
  never gets built — a savings in lines, a loss of its core promise.

Rough total: **~300-400 lines of the 1,685-line codebase touched (~20-25%)**,
an image-side addition, and a rewrite of exactly the two files ("the risky
parts", design §8) both prior designs deliberately left untouched.

## 9. Verdict

**(c) Blocked on gvx itself** — not on micke engineering. The happy path is
proven (feasibility §5: "feasible with changes" — and it is, as a *secondary*
runtime), but gvx-ONLY requires gvx-side pieces that do not exist and are not
committed: an attachable second channel (exec-equivalent) for re-attach and
fresh shells; detached/stateful runs (`-d`+`ps`+`rm`) for daemon-death survival;
cgroup-backed memory limits (vs a polling 137 guard); any Docker-free image
build path; v1.0 API stability (FR-39's own trigger). Until then gvx-only
converts the approved daemon design's three promises into one and cuts capacity
4x, while still needing Docker for image builds.

**Recommendation: keep Docker primary, gvx behind the FR-39 trigger (current
locked design L6 — it is correct).** A middle option worth naming: treat
`dockerio.ts`'s function set as the runtime interface and bank the verified
driver.sh pattern as a second image entrypoint — cheap optionality, no dual
runtime in the product. If a locked-down-host user appears (FR-39/FR-2's
trigger), gvx ships as the opt-in backend with "sessions live and die with the
daemon" documented as its contract and re-attach explicitly unsupported — never
as the only runtime while the pieces above are missing.

## 10. Owner decision (2026-11-02, after this analysis)

The verdict above was "(c) blocked on gvx — keep Docker primary". The owner
reviewed it and **overrode with a MUST: Docker support is removed; gvx is the
only runtime.** The owner's rebuttals, accepted on the evidence:

1. **Build** — not a user-scenario concern (the product is pull-only). Image
   distribution has two verified paths: `rungv pull` (registry) and
   `docker save` → `rungv load` (8 s / 388 MB, §6). Builds stay on the
   maintainer/CI side. This "blocker" is withdrawn.
2. **exec** — needed only for re-attach, not the happy path (stdin driver is
   verified). Feasibility's alternative (b) — a guest service reached via
   `-p` forwarding — makes a socket-based shell channel that can restore
   re-attach without exec. Port forwarding itself is verified; the
   socket-driver-as-shell-channel combination gets a dedicated experiment.
3. **RAM** — owner-managed. The FR-18 floor and FR-31/32 pull-serialization
   rules stay as hygiene.

Consequences: the FR-39 deferral trigger is fired by owner decision (not by
the upstream events it anticipated); the PRD will be amended when the runtime
swap lands. The HTTP-daemon migration (transport layer, runtime-agnostic)
proceeds in parallel; its Docker-specific orphan re-attach (§5 of the daemon
design) is SKIPPED as throwaway — the gvx swap rewrites that machinery.
