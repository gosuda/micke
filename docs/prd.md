# micke — Product Requirements Document (PRD)

Date: 2026-11-02 · Status: M-min shipped (supervisor + four tools + persistent shell + dashboard, verified end-to-end) · Owner: micke project

> **Revised 2026-11-02:** M-min (minimalist audit) adopted as MVP scope; see `docs/research/minimalist-cut.md`. One override: FR-45 simple bind included in M-min.

Sources (ground truth; every requirement below traces to one): `README.md`,
`docs/research/gvx-feasibility.md` (measured numbers), `docs/research/user-scenarios-dev-tooling.md`
(Direction A revision: R1–R3 + pull-only model), plus owner handoff 2026-11-02 for current-state
verification details. This PRD formalizes locked design decisions; it does not re-litigate them.

---

## 1. Summary / vision

**micke — a desk for AI agents.** micke is a local-first developer tool that gives an AI coding agent (or a CI script) a disposable, real Linux desktop in seconds: one MCP call boots a containerized Xvfb/AT-SPI desktop with chromium, driven through `agent-desktop`'s accessibility-tree snapshots and stable `@ref`s, mirrored live to the operator's browser via per-session noVNC. Each session is a deterministic, digest-pinned fixture — teardown leaves nothing behind. The product is the harness around that desk: a supervisor, a four-tool MCP surface with one persistent shell per session, a session dashboard, and a pull-only registry image model. micke is the "sandbox with a screen" the 2026 coding-agent landscape lacks: local, real-GUI, receipt-driven, with a human hand available one browser tab away.

**Current state (2026-11-02, updated after M-min shipped).** The image layer AND the product layer are built and verified.

- Image: Debian bookworm + Xvfb/openbox/AT-SPI + chromium + `agent-desktop` v1.0.2 + x11vnc/noVNC, non-root `agent` user; built locally and by CI (`.github/workflows/image.yml` → `ghcr.io/gosuda/micke`), verified.
- Entrypoint: D-Bus session → Xvfb `:99` → AT-SPI bus → openbox → x11vnc `:5900` + websockify/noVNC `:6080` (non-fatal) → publishes `/tmp/session.env`.
- Image/runtime verified end-to-end under Docker AND gvx v0.4.0: accessibility granted, 83 snapshot refs on example.com, link-click navigation, PNG screenshots, noVNC live (vnc.html 200, RFB banner over websocket), clean teardown.
- Product layer (M-min, shipped 2026-11-02): supervisor (flock instance lock, free-RAM floor, serialized pulls, orphan detection/reap), the four MCP tools over a persistent Streamable-HTTP daemon on `127.0.0.1:7800`, the persistent shell channel (`docker exec -i` + framing), and the static dashboard — verified end-to-end against real Docker by four test suites (`bun test tests/`).
- Still not built: registry-default image model (FR-30 deferred; default stays the local tag), the gvx-only runtime swap (owner MUST, see the L6 note below), variants/signing/cache tooling (deferred).
- MVP scope = **M-min** (§8) — shipped.

**Locked design decisions** (owner decisions, 2026-11-02; formalized here, not open for re-litigation):

| # | Decision | Where formalized |
| :-- | :-- | :-- |
| L1 | Direction A: developer tooling — the disposable real-GUI harness for AI coding agents (GUI testing/QA: inner loop, CI regression, human-in-the-loop review). Direction B (security product) and C (consumer butler) are non-goals | §2, §4 |
| L2 | R1 session dashboard, supervisor-served | §5.4 |
| L3 | R2 manual VNC intervention as a designed flow | §5.9, §6 |
| L4 | R3 MCP surface = exactly four tools incl. one persistent shell for ALL CLI | §5.1, §5.2 |
| L5 | Pull-only image model, split: **no image builds in user flows** — locked; **default = pinned registry ref** — unlocked until the second non-owner user exists (M-min's image model = local tag; FR-34 absorbed into the default) | §5.5 |
| L6 | Docker primary — locked; gvx demoted to **verified design, deferred backend** (resurrect on first can't-run-dockerd user, or gvx v1.0 API stability) — **superseded 2026-11-02 by owner MUST: gvx-only** (`research/gvx-only-analysis.md` §10) | §5.6 |
| L7 | Supervisor: one host process per session, owns ports/URL discovery, serves dashboard | §5.3, §5.4 |

L1–L7 owner-approved 2026-11-02; L5/L6 renegotiated to the split forms above as part of adopting M-min. L6 was superseded later the same day by the gvx-only owner MUST (`research/gvx-only-analysis.md` §10) — the runtime swap is designed (`research/gvx-runtime-design.md`) but NOT yet implemented; the shipped code and §5.6 below remain Docker-primary, and the PRD amendment lands with the swap (proposal: `research/gvx-runtime-design.md` §12).

## 2. Problem & opportunity

Every coding-agent sandbox in 2026 (E2B, OpenHands, Sandvault, Sculptor — scenario study market scan) is a headless terminal. `playwright-mcp` — the de-facto standard a11y loop (~200–400 tokens/snapshot, default in Copilot's coding agent) — covers headless web pages only. Neither can test what actually breaks shipping software:

- browser extensions, WebGL, and font rendering, which headless chromium hides;
- packaged/native Linux apps (GTK/Qt/Tauri) — today a manual VM (Priya) or untested `.deb`/AppImage artifacts (Marcus);
- login-gated flows — CI grids cannot hold login state; auth-state tests are the flaky ones;
- failure evidence — grids produce videos nobody scrubs; issue screenshots prove nothing about *sequence* (Tomasz).

The slot — *a local, throwaway, real GUI that an agent or CI script drives through the standardized snapshot → act-on-ref → verify loop, with live human oversight* — is open. micke's expensive components (disposable desktop image, AT-SPI driver with JSON receipts, bidirectional noVNC, daemon-free gvx option) are already built and verified end-to-end under both runtimes; the plumbing that remained (supervisor, MCP, dashboard) shipped with M-min (§1) — what's left is the image pipeline (registry distribution) and the pending gvx-only runtime swap, not research.

## 3. Target users

- **P1 — Priya**, product engineer at a 12-person SaaS startup (Tauri/GTK desktop app + web app; codes with Claude Code over MCP). Wants every session visible on one page (R1) and to do the staging SSO login herself inside the sandbox so the credential never reaches the agent or transcript (R2). Runs `micke:gtk`.
- **P2 — Marcus**, QA/platform engineer owning nightly + per-release E2E on a self-hosted runner. Wants the whole run at one localhost URL with no SSH (R1), human login mid-run without breaking it (R2), and digest-pinned variant images pre-pulled by runner warmup.
- **P3 — Tomasz**, solo maintainer of a 4k-star GTK4 utility, zero budget. Needs CI that can actually click a Linux GUI app and produce sequence evidence (receipts), not screenshots pasted into issues.

## 4. Goals / Non-goals

**Goals**

1. Ship the MCP layer (exactly four tools, R3) and supervisor that turn the verified image into a product.
2. Real-GUI agent/QA workflow: `snapshot -i` → `click @ref` → `wait --window` → re-snapshot, asserting on JSON receipts on a real X server — no pixel matching.
3. Human-in-the-loop by design: R1 dashboard for at-a-glance oversight, R2 manual noVNC intervention for credentials and judgment calls.
4. Pull-only image model, phased: zero builds in user flows now; registry distribution (pinned refs, hermetic-CI warmup) deferred to the second-user trigger.
5. Runtimes, phased: Docker now; gvx verified design, deferred backend (parity run banked as evidence, not a shipping obligation).

**Non-goals (explicit, for now)**

- **Image building in user flows** — no `docker build`/`rungv build` anywhere a user or agent touches; builds are project CI. Maintainer escape hatch (`docker build`, `docker save | rungv load`) exists out-of-scope.
- **Consumer packaging / butler product (Direction C)** — micke is developer tooling, not a personal assistant desktop.
- **Security-product features (Direction B)** — no egress filtering, credential broker, or action-level command interception. Deferred.
- **Multi-host / cloud orchestration** — one host, one supervisor, local-first; no telemetry.
- **Firefox/WebKit engines** — chromium-only image; other engines later.
- **Model/skill layer curation** — micke provides the desk and the shell; agent behavior is the agent's (and its user's) business.

## 5. Functional requirements

Status legend: **implemented** (ships today — in the image or in the daemon), **verified** (mechanism measured hands-on; integration planned), **planned** (design agreed, not built). Priorities (post-M-min): **P0** = in M-min, MVP-blocking; **deferred** = out of M-min, resurrectable by its named trigger; **cut** = removed. The **M-min** column carries the audit verdict — 18 keep / 12 shrink / 15 defer / 3 cut, plus one owner override (FR-45 in).

### 5.1 Session lifecycle & MCP surface (R3)

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-1 | P0 | `session.create {image}` boots a session and returns session id + noVNC URL; pull policy per FR-31/32. | R3; A1, B1 | implemented (`session_create`; 0.54 s Docker boot measured) | **in** (shrunk: no `runtime` param — one runtime, one code path) |
| FR-2 | deferred | Runtime selector on create: `docker` (default) or `gvx` (opt-in). | locked design 6 | planned | deferred (trigger: gvx ships — FR-39) |
| FR-3 | P0 | `session.list` returns live sessions with id, runtime, status, uptime, and noVNC URL (no hand-copied rungv stderr). | R3; C1 | implemented (no `runtime` field — one runtime) | **in** |
| FR-4 | P0 | `session.close` tears the session down and discards all state; the next session gets the same digest-pinned desk bit-for-bit. | R3; A7 | implemented (`docker rm -f` ~1 s; gvx kill 0.52 s, zero strays — measured) | **in** |
| FR-5 | P0 | The MCP surface is **exactly four tools**: `session.create`, `session.list`, `session.close`, one persistent shell tool (working name `session.shell`). No per-command proxy tools, ever. | R3 (locked) | implemented (`session_create/list/close/shell` over Streamable HTTP) | **in** |

### 5.2 Persistent shell tool (R3)

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-6 | P0 | One long-lived shell (PTY) per session; environment and working directory persist across tool invocations. | R3; A2, B3 | implemented (pipelined `docker exec -i` bash, no PTY; env/cwd persist — tested) | **in** |
| FR-7 | P0 | ALL CLI usage — every `agent-desktop` call, builds, `jq`, anything in the image — goes through this one shell. | R3 (locked) | implemented (the shell is the only CLI path; tool docs say so) | **in** |
| FR-8 | P0 | Docker backend: wraps `docker exec`, auto-sources `/tmp/session.env` so `agent-desktop` works with no manual env setup. | R3; README | implemented (shell init waits for + sources `/tmp/session.env`) | **in** |
| FR-9 | deferred | gvx backend: session stdin line channel with `===BEGIN===` / `===END rc=N===` framing (gvx has no exec by design). | R3; feasibility §4.3 | verified | deferred (trigger: first locked-down-host user) |
| FR-10 | P0 | Shell state is destroyed on `session.close` and on supervisor restart; no PTY, process, or FIFO leaks (verifiable by fd/process count after repeated create/close cycles). | scenario risk 7 | implemented (`tests/leak-cycles.test.ts`: 20 cycles, fds ±8, exact child count) | **in** |
| FR-11 | P0 | Each command returns framed stdout, stderr, and exit code; output is capped (truncate with explicit marker) so a runaway command cannot blow the MCP response. | R3 | implemented | **in** |
| FR-12 | P0 | Per-command timeout kills the offending command only — never the shell or the session. | R3 | implemented (watchdog TERM→KILL on the command's process group only) | **in** |
| FR-13 | deferred | Background jobs have documented semantics: killed on close, and either listed or killed on per-command timeout; no orphaned children. | scenario risk 7 | planned | deferred (trigger: a real orphaned-child bug report) |
| FR-14 | deferred | Defined behavior for a dropped/reconnected channel: transparent resume or explicit state-reset receipt; no silent half-state. | scenario risk 7 | planned | deferred (trigger: an actual half-state confusion after an MCP client reconnect) |

### 5.3 Supervisor

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-15 | P0 | One host process per session owning the runtime child (Docker container, or foreground `rungv run -i`). | locked design 7; feasibility §6 | implemented (consolidated in M-min: ONE supervisor owns all sessions; containers are dockerd children tracked by the `micke.session` label) | **in** |
| FR-16 | P0 | Per-session port allocation: Docker `-p` with host-chosen ports; fixed 5900/6080 must not collide at N>1. | scenario mapping; feasibility §4.7 | implemented (`-p 127.0.0.1::6080/tcp`, read back via `docker port`) | **in** (shrunk: Docker `-p` only; the gvx stderr parse defers with gvx) |
| FR-17 | P0 | Discovered noVNC URLs are published via `session.list` and the static dashboard table — no relay, no third surface. | R1; C1 | implemented | **in** (shrunk: `session.list` + static table only) |
| FR-18 | P0 | Memory guard: supervisor refuses new sessions when host free RAM is below a safe floor (host-OOM incident observed when this was missing). | feasibility §4.8, §6 | implemented (`MICKE_MIN_FREE_MB` floor on `MemAvailable`) | **in** (shrunk: free-RAM floor refuse; the elaborate guard was a gvx problem) |
| FR-19 | P0 | One supervisor per host (instance lock); it owns port allocation and pull serialization — no second supervisor racing it. | pull-only; risk 6 | implemented (flock on `<state dir>/supervisor.lock`, 1.5 s restart-race retry) | **in** |
| FR-20 | deferred | Configurable max concurrent sessions per host (memory-derived default: ~8 Docker / ~2 gvx per 8 GiB). | B1 | planned | deferred (trigger: degradation reported at high N on a big host; FR-18's floor is the cap until then) |
| FR-21 | P0 | `session.create` failures return one structured, machine-readable error shape (image missing, insufficient memory, ports exhausted). | R3 | implemented (one `{code, message, hint}` shape on every failure) | **in** (shrunk: one error shape, not three engineered receipt cases) |
| FR-22 | cut | ~~Optional single relay origin for all noVNC URLs (vs N raw host ports) once traffic/proxy shape is decided.~~ | scenario mapping; OQ-2 | planned | **cut** (remote/multi-host sharing is a locked non-goal; localhost ports are the product) |

### 5.4 Session dashboard (R1)

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-23 | P0 | Supervisor-served static, no-JS HTML table at `127.0.0.1:7800`; localhost-only bind is a security property, not a convenience. No framework, no build step. | R1; risk 6 | implemented | **in** (shrunk: static table only) |
| FR-24 | P0 | One row per session: id, status, uptime, noVNC URL. | R1; B2 | implemented | **in** (shrunk: runtime/memory/windows columns out — constant or decoration) |
| FR-25 | P0 | Per-row noVNC link opens that session's live desktop. | R1; R2 entry point | implemented (noVNC serving works today: vnc.html 200, RFB over websocket) | **in** |
| FR-26 | cut | ~~Optional embedded noVNC iframe per row.~~ | R1; A5 | planned | **cut** (saves one click, costs a frontend; a browser tab is the honest UI) |
| FR-27 | deferred | Memory column warns before a host (especially gvx) tips into the OOM killer. | B2 | planned | deferred (trigger: first Docker host OOM observed) |
| FR-28 | deferred | Auth (token or similar) before a dashboard is shareable beyond localhost; until shipped, sharing is documented as unsupported. | risk 6; OQ-1 | planned | deferred (trigger: first request to share beyond localhost) |
| FR-29 | P0 | Dashboard auto-refreshes via `<meta http-equiv="refresh" content="5">` — one line, zero JavaScript. | R1 | implemented | **in** (shrunk: meta-refresh only) |

### 5.5 Image policy (pull-only)

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-30 | deferred | Default image is a pinned registry ref (`ghcr.io/…/micke:<tag>`), digest-pinned; supply-chain control until signing exists. | pull-only; risk 9 | planned (pipeline) | deferred (trigger: the first user who isn't the owner) |
| FR-31 | P0 | Pull-if-missing before a session starts — one `docker pull` behind the supervisor lock; sessions always run cache-only (`--pull=never` / Docker equivalent). | pull-only; B1 | implemented (boot-lock serialized pull-if-missing; runs always `--pull=never`) | **in** (shrunk: one pull behind the lock) |
| FR-32 | P0 | The supervisor NEVER initiates a pull while any session is live — serialized behind FR-31's lock (host OOM was observed once when a pull overlapped a sandbox). | feasibility §4.8 | implemented | **in** (shrunk: folded into FR-31's lock) |
| FR-33 | deferred | Warmup/pre-pull hook (supervisor startup option or explicit command) so CI runners can fetch all needed variants before the suite starts. | B1 | planned (`docker pull` / `rungv pull` verified) | deferred (trigger: a self-hosted-runner owner materializes) |
| FR-34 | P0 | M-min's default image model is a locally tagged image — the local-ref override is absorbed into the default until FR-30's registry ref exists. | pull-only | implemented (default `micke:latest`) | **in** (shrunk: absorbed into the default) |
| FR-35 | deferred | Official variants with baked toolchains: `micke:latest` (base), `micke:gtk`, `micke:node`; users pick a tag, still pull-only — removes the per-session `apt-get` tax. | scenario mapping | planned | deferred (trigger: a measured apt-get tax slowing a real loop) |
| FR-36 | deferred | Image signing (e.g. cosign). | risk 9 | planned | deferred (trigger: FR-30 resurrects — distribution to non-owner machines) |
| FR-37 | deferred | Cache hygiene: report local image-cache disk usage (Docker layers + gvx EROFS cache) and support pruning. | pull-only ops | planned | deferred (trigger: first disk-full incident) |

CI already builds and pushes the image on every `image/**` change to main
(`.github/workflows/image.yml` → `ghcr.io/gosuda/micke`, tags `latest` +
`sha-<sha>`); that is the maintainer build leg of the pull-only model. The
registry ref is not yet the `session_create` default — FR-30's trigger stands.

### 5.6 Runtimes

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-38 | P0 | Docker is the default runtime (`--shm-size=1g` for chromium; ~8 concurrent chromium sessions per 8 GiB host). | locked design 6 | implemented (manual), verified | **in** |
| FR-39 | deferred | gvx is an opt-in runtime: unprivileged, no daemon/root/host namespaces, seccomp self-lockdown; ~2 GiB/chromium session → ~2 per 8 GiB host; `-m` per FR-18. | locked design 6; feasibility | verified end-to-end | deferred (trigger: a user who cannot run dockerd, or gvx v1.0 API stability) |
| FR-40 | deferred | Same image runs under both runtimes with verified parity (identical snapshot ref counts: 83 on example.com under both). | locked design 6 | verified | deferred (trigger: gvx ships — then one parity run, not standing CI) |

> **Pending amendment (owner decision 2026-11-02, `research/gvx-only-analysis.md`
> §10):** Docker is removed as a runtime; gvx becomes the only one. The swap is
> designed (`research/gvx-runtime-design.md`) but NOT yet implemented — this
> section still describes the shipped (Docker-primary) code. The PRD amendment
> lands with the swap; the proposal is `research/gvx-runtime-design.md` §12
> (FR-2 cut, FR-15/16 reworded, FR-38 inverted, FR-39 fired → P0, L6/L7
> amended).

### 5.7 Desktop stack in-image

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-41 | P0 | `agent-desktop` v1.0.2 present and functional in-image: `ACCESSIBILITY_ENABLED=1`, `/tmp/session.env` published with DISPLAY/D-Bus/AT-SPI addresses; a11y granted at boot. | README; A3 | implemented, verified | **in** |
| FR-42 | P0 | Chromium launch requirements documented: `--no-sandbox`, `--force-renderer-accessibility`, `--arg=` passthrough (e.g. `--load-extension`); real Xvfb 1280x800, not headless. | B4; README | implemented, verified | **in** |
| FR-43 | P0 | Per-session x11vnc `:5900` + websockify/noVNC `:6080`; startup failure is non-fatal to the session; optional `MICKE_VNC_PASSWORD`. | README; R2 mechanism | implemented, verified | **in** |

### 5.8 Artifacts

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-44 | P0 | Screenshot and snapshot-JSON retrieval through the shell channel (`agent-desktop screenshot` + base64 out; 102 KB PNG measured). | A6, B6 | implemented, verified (shell channel shipped; 102 KB PNG measured) | **in** |
| FR-45 | P0 | Workspace host bind chosen at `session.create` time — a simple `-v` bind only: repo staging in, artifacts out — no base64 for large files. Larger-file strategy stays lean. | A2, B6 (GAP) | implemented (`-v <host dir>:/workspace` at create; host round-trip tested) | **in** (simple `-v` bind at create; owner override of the audit's deferral, 2026-11-02) |
| FR-46 | cut | ~~Artifact convention (path layout, naming, report integration) so CI evidence bundles are uniform.~~ | scenario mapping (PARTIAL); OQ-4 | planned | **cut** (the user's CI layout, not the desk's job — micke exports files, not opinions) |

### 5.9 Manual VNC intervention (R2)

| ID | Pri | Requirement | Source | Status | M-min |
| :-- | :-- | :-- | :-- | :-- | :-- |
| FR-47 | P0 | Documented intervention flow on one doc page: agent pauses (announced) → human opens that session's noVNC from the dashboard → acts (e.g. SSO login; the credential never enters the transcript) → agent resumes and verifies via receipts. One example prompt shipped. | R2; A5, B5 | implemented ([manual-intervention.md](manual-intervention.md): pause contract + one example prompt) | **in** (shrunk: one doc page + one example prompt) |
| FR-48 | P0 | Human-vs-agent input arbitration on the shared X display is documented as a known unsolved hazard; users are told to intervene only while the agent is paused. | R2; scenario risk 7 | implemented (hazard section in [manual-intervention.md](manual-intervention.md)) | **in** |

## 6. User experience flows

**Inner-loop GUI testing (P1, interactive).**
1. Agent calls `session.create` (`micke:gtk`, pulled if missing) → dashboard row flips `ready` with its noVNC link.
2. Agent stages the repo (workspace bind) and builds through the persistent shell — env/cwd persist, toolchain pre-baked, untrusted output stays in the sandbox.
3. `agent-desktop launch` → `snapshot -i` → `click @ref` → `wait --window` → re-snapshot; assertions read JSON receipts (window titles, ref counts, states), not pixels.
4. Login wall → agent pauses, human logs in via the dashboard noVNC link, agent resumes (R2; FR-47).
5. Screenshot + receipts to the PR; `session.close`; row disappears; nothing persists.

**CI nightly regression (P2, headless-of-headless).** *(M-min note: the scale features this flow leans on — warmup, variants, memory warnings, N-session capacity — are deferred with named triggers; this flow describes the end state, not the first shipped scope.)*
1. Warmup pre-pulls digest-pinned variants before any session starts (FR-33).
2. Supervisor boots N sessions cache-only (~8 per 8 GiB on Docker, ~2 on gvx); dashboard shows the grid with memory warnings.
3. Each session runs one scripted, non-LLM bash + agent-desktop group over the shell channel: `jq` assertions on receipts, non-zero exit with receipt attached on failure.
4. On failure: screenshot + last snapshot JSON out via shell/base64 or workspace bind — the report says *which ref* vanished, not a video timestamp.
5. Teardown kills all sessions; report = receipts + screenshots + exit codes; hermetic, local, zero vendor CI minutes.

**Human-login intervention (R2 core).**
1. Agent hits SSO/CAPTCHA, announces a pause (agent-side contract, documented).
2. Human opens the session's noVNC link from the dashboard.
3. Human performs the login — the credential never enters any transcript.
4. Agent resumes, `wait --window` confirms the authenticated state, the script continues.
5. While both human and agent drive, arbitration is the documented hazard (FR-48).

## 7. Success metrics

| Metric | Target | Baseline / source |
| :-- | :-- | :-- |
| Session boot (`session.create` → desktop ready) | < 2 s | 0.54 s Docker / 1.07 s gvx measured (feasibility §4.5) |
| Teardown (`session.close` → gone) | < 2 s, zero stray processes | ~1 s `docker rm -f` / 0.52 s gvx kill, zero strays measured |
| Shell command round-trip overhead vs raw exec | < 200 ms P95 | Framing channel measured informally; target is a product decision, not a measured baseline |
| Dashboard page load | < 1 s | Shipped (static table, meta-refresh); no measured baseline |
| Snapshot parity across runtimes | Identical ref count on the same page | 83 refs on example.com, identical Docker/gvx (feasibility §4.4) |
| Session memory guardrail | Docker chromium session ≤ ~500 MiB; gvx ≤ ~2.2 GiB (PSS) | Measured 404.6 MiB / 1836 MiB PSS (feasibility §4.5); targets add headroom |
| Leak-free cycling | fd + process counts return to baseline after repeated create/close cycles | Implemented: `tests/leak-cycles.test.ts` — 20 cycles, fd Δ ≤ 8, exact child-count match |
| CI acceptance scenario | A scripted agent-desktop test runs green on a freshly pulled image with networking disabled after warmup | End-to-end flow verified manually under both runtimes (research §4) |

## 8. Milestones

Revised 2026-11-02: M1–M4 replaced by **M-min (MVP)** and a trigger-driven deferred backlog (owner adoption of `docs/research/minimalist-cut.md`, with one override: FR-45's simple bind is in). Scope vs the old plan: ≈ 55% of M1, ≈ 15% of M2, M3 killed outright (one serialized pull-if-missing line rides along in step 4), M4 shrunk to ~20% — roughly a third of the build scope buys the entire core loop.

**M-min (MVP)** — build order; each step depends on the previous. *(Status: all six steps shipped 2026-11-02 — supervisor, four tools + daemon, shell, guards, table, docs — verified end-to-end by `bun test tests/`; followed by the stdio→HTTP daemon migration, also shipped.)*

1. **Supervisor skeleton** — one host process per session, `docker run/rm` wiring, Docker `-p` port allocation (FR-15, 38, 16).
2. **The four MCP tools + noVNC URLs** — create/list/close, URL in every answer (FR-1, 3, 4, 5, 17), plus the simple workspace `-v` bind chosen at `session.create` time (FR-45, owner override).
3. **The shell** — piped `docker exec -i` wrap (no PTY), auto-source `/tmp/session.env`, framing + output cap + per-command timeout (FR-6, 7, 8, 11, 12).
4. **Death hygiene & guards** — teardown on close/restart + leak-cycle test, flock instance lock, free-RAM floor, serialized pull-if-missing, structured errors (FR-10, 19, 18, 31, 32, 21).
5. **The table** — static HTML at `127.0.0.1:7800`, meta-refresh, one row = id/status/uptime/noVNC URL (FR-23, 24, 25, 29 — shrunk).
6. **The docs** — chromium flags page, R2 pause contract + arbitration hazard + one example prompt (FR-42, 47, 48 — 47 shrunk).

Already paid for, zero build cost: FR-41, 43, 44 (in-image, verified end-to-end). FR-34 is absorbed into the default image model (the local tag IS the image until FR-30's registry ref exists).

**Hard exit criterion — met 2026-11-02** (behaviors verified: boot/teardown timings and the 20-cycle fd/process baseline in `tests/`; the launch → snapshot → click → verify → PNG loop with receipts in `docs/chromium-flags.md`; live noVNC serving, vnc.html 200 + RFB over websocket). Original wording, kept as the definition: on a host with Docker + the local image ONLY (no registry, no gvx), from a cold MCP client config, an agent completes — using the four tools and nothing else — create → launch chromium → `snapshot -i` → `click @ref` → `wait --window` → re-snapshot → PNG out via base64; a human opens the noVNC URL (from `session.list` or the table) in a browser and types into the live desktop; `session.close`; 20 create/close cycles return fd/process counts to baseline; boot < 2 s and teardown < 2 s. Two of these metrics were already met by measurement (0.54 s boot, ~1 s teardown — §7).

**Deferred backlog (trigger-driven)** — replaces M2–M4 as the growth path; every deferred FR resurrects when its trigger fires:

| FR | Deferred feature | Trigger that resurrects it |
| :-- | :-- | :-- |
| FR-2 | runtime selector | gvx ships (FR-39) |
| FR-9 | gvx shell framing backend | first locked-down-host user |
| FR-13 | background-job semantics | a real orphaned-child bug report |
| FR-14 | dropped-channel semantics | an actual half-state confusion after an MCP client reconnect |
| FR-20 | max-sessions knob | degradation reported at high N on a big host |
| FR-27 | memory-warn column | first Docker host OOM observed |
| FR-28 | dashboard auth | first request to share beyond localhost |
| FR-30 | pinned registry default ref | the first user who isn't the owner |
| FR-33 | warmup/pre-pull hook | a self-hosted-runner owner materializes |
| FR-35 | `:gtk`/`:node` variants | a measured apt-get tax slowing a real loop |
| FR-36 | image signing (cosign) | FR-30 resurrects — distribution to non-owner machines |
| FR-37 | cache-hygiene reporting | first disk-full incident |
| FR-39 | gvx runtime | a user who cannot run dockerd, or gvx v1.0 API stability |
| FR-40 | standing parity promise | gvx ships (then one parity run, not standing CI) |

FR-45's large-file aspects stay lean (audit trigger, should they ever be needed: repos/artifacts too big for clone + base64 round-trips).

## 9. Technical constraints & dependencies

| Dependency | Version / state | Role | Notes |
| :-- | :-- | :-- | :-- |
| agent-desktop | v1.0.2 (vercel-labs) | AT-SPI driver: snapshots, stable `@ref`s, JSON receipts, screenshots | The interaction contract; CLI churn contained behind the shell channel (R3) |
| gvx / rungv | v0.4.0 (Apache-2.0) | Optional runtime: user-space kernel, unprivileged | Single-maintainer 7-star pre-1.0 fork; no exec/daemon/`-d`; `-m` is a polling guard, not cgroups; API may change before v1.0.0 |
| Docker | 29.1.3 tested | Primary runtime | `exec` = shell backend (FR-8); `-p` allocation |
| x11vnc + websockify/noVNC | in-image | Per-session live mirror | Plain TCP to gvx forwards (~78 MB/s measured; 3 s guest-dial window; port ranges refused) |
| MCP protocol | — | The only agent-facing surface | Exactly four tools (FR-5) |

Host requirements: Linux x86_64; ~0.5 GiB free RAM per Docker chromium session, ~2 GiB per gvx session (4.5× multiplier — Sentry page tables, netstack, stubs; budget PSS, not RSS); Docker needs `--shm-size=1g` (gvx `/dev/shm` defaults to half of host RAM — 3.9 GiB here); first use requires network for the image pull (no offline cold-start story).

## 10. Risks

1. **Competing with free.** For pure web apps, playwright-mcp + headless chromium is zero-setup, Microsoft-backed, and good enough most days; micke wins only where a real display matters (extensions, WebGL, packaged apps, login windows, fonts). If it reads as "a slower playwright," it loses.
2. **Was: the MCP layer doesn't exist yet. Resolved 2026-11-02** — M-min shipped: supervisor, four tools over the HTTP daemon, persistent shell, dashboard and guards, verified end-to-end (`tests/`, four suites against real Docker). The remaining plumbing risk is the pending gvx-only runtime swap (L6 note; `research/gvx-runtime-design.md`).
3. **Shell = maximal capability by design.** One channel means no action-level interception or auditing — the supervisor sees command strings and CLI receipts, nothing finer. Accepted (Direction B non-goal); must be documented honestly.
4. **Stateful shells.** Persistent env/cwd/background jobs must be defined away on close/restart/drop, or sessions leak PTYs and half-state (FR-10/13/14).
5. **Dashboard attack surface.** Whoever reaches the supervisor port can watch and drive every session; localhost-only default is mandatory, auth-before-sharing still open (FR-28).
6. **Port bookkeeping is load-bearing.** Docker `-p` allocation and the `rungv: publishing …` stderr parse feed every dashboard link and `session.list` URL; a parse bug breaks R1/R2 visibly.
7. **First-use network dependency.** Hundreds of MB before the first session; ghcr rate limits or a deleted/renamed ref breaks pinned pulls; digest pinning now, signing later (FR-36).
8. **Variant sprawl.** Each variant is a tag users must choose between and an image the project must build, test, and keep fresh (FR-35; OQ-5).
9. **gvx bus factor.** One active maintainer, pre-1.0 API churn; mitigated by Docker primary / gvx opt-in and the pinned version.
10. **Agent reliability caps autonomy.** No leading model exceeds ~30% F1 on real-world GUI testing without a human checklist; the honest near-term product is scripted CI (B) + supervised sessions (C), not set-and-forget agents.
11. **Environment coverage gaps.** Chromium-only; no persistent login profiles (R2 covers one run only); GTK/Qt/Tauri a11y untested beyond chromium; ~2 vs ~8 sessions per host on gvx.
12. **R2 is half agent behavior.** Pausing/resuming observably is prompt/MCP-contract discipline, not micke code; it will be tested by humans with mice at the worst moment.

## 11. Open questions

1. Dashboard auth mechanism when sharing beyond localhost (token? per-session noVNC passwords as the sharing primitive?).
2. One relay origin vs N raw host ports for noVNC URLs (FR-22) — proxy complexity vs port sprawl. **Resolved by cut (2026-11-02):** localhost ports are the product; resurrectable only if local-first itself is re-litigated.
3. Shell channel framing: keep the verified line protocol (`===BEGIN/===END rc=N===`) or upgrade to newline-delimited JSON-RPC once the driver is folded into the image (feasibility §6 suggests the upgrade path).
4. Artifact convention: path layout, naming, and report/CI integration (FR-46).
5. How variants get CI-tested: full matrix per release vs per-variant smoke (boot + snapshot ref-count check) — **moot until variants resurrect** (FR-35 trigger: measured apt-get tax).
6. Persistent login profiles / state volumes (explicit gap; gvx `.ext4` named volumes exist but are unexposed).
7. Supervisor shape for gvx: CLI subprocess (as verified) vs embedded `pkg/gvx` SDK (one sandbox per process keeps seccomp lockdown; `DisableHostLockdown` trade-off).
8. Session recording/replay for review flows (explicit gap; screenshots only today).
