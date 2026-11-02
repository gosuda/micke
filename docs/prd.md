# micke — Product Requirements Document (PRD)

Date: 2026-11-02 · Status: draft for implementation planning · Owner: micke project

Sources (ground truth; every requirement below traces to one): `README.md`,
`docs/research/gvx-feasibility.md` (measured numbers), `docs/research/user-scenarios-dev-tooling.md`
(Direction A revision: R1–R3 + pull-only model), plus owner handoff 2026-11-02 for current-state
verification details. This PRD formalizes locked design decisions; it does not re-litigate them.

---

## 1. Summary / vision

**micke — a desk for AI agents.** micke is a local-first developer tool that gives an AI coding agent (or a CI script) a disposable, real Linux desktop in seconds: one MCP call boots a containerized Xvfb/AT-SPI desktop with chromium, driven through `agent-desktop`'s accessibility-tree snapshots and stable `@ref`s, mirrored live to the operator's browser via per-session noVNC. Each session is a deterministic, digest-pinned fixture — teardown leaves nothing behind. The product is the harness around that desk: a supervisor, a four-tool MCP surface with one persistent shell per session, a session dashboard, and a pull-only registry image model. micke is the "sandbox with a screen" the 2026 coding-agent landscape lacks: local, real-GUI, receipt-driven, with a human hand available one browser tab away.

**Current state (2026-11-02).** The image and runtime layer are done and verified; the product layer is not.

- Image: Debian bookworm + Xvfb/openbox/AT-SPI + chromium + `agent-desktop` v1.0.2 + x11vnc/noVNC, non-root `agent` user; built locally, verified.
- Entrypoint: D-Bus session → Xvfb `:99` → AT-SPI bus → openbox → x11vnc `:5900` + websockify/noVNC `:6080` (non-fatal) → publishes `/tmp/session.env`.
- Verified end-to-end under Docker AND gvx v0.4.0: accessibility granted, 83 snapshot refs on example.com, link-click navigation, PNG screenshots, noVNC live (vnc.html 200, RFB banner over websocket), clean teardown.
- Not built: supervisor, MCP tools, persistent shell tool, dashboard, port allocation, registry pipeline. Most P0s below are "planned, mechanism verified."

**Locked design decisions** (owner decisions, 2026-11-02; formalized here, not open for re-litigation):

| # | Decision | Where formalized |
| :-- | :-- | :-- |
| L1 | Direction A: developer tooling — the disposable real-GUI harness for AI coding agents (GUI testing/QA: inner loop, CI regression, human-in-the-loop review). Direction B (security product) and C (consumer butler) are non-goals | §2, §4 |
| L2 | R1 session dashboard, supervisor-served | §5.4 |
| L3 | R2 manual VNC intervention as a designed flow | §5.9, §6 |
| L4 | R3 MCP surface = exactly four tools incl. one persistent shell for ALL CLI | §5.1, §5.2 |
| L5 | Pull-only image model; no builds in user flows | §5.5 |
| L6 | Docker primary, gvx optional; same image, verified parity | §5.6 |
| L7 | Supervisor: one host process per session, owns ports/URL discovery, serves dashboard | §5.3, §5.4 |

## 2. Problem & opportunity

Every coding-agent sandbox in 2026 (E2B, OpenHands, Sandvault, Sculptor — scenario study market scan) is a headless terminal. `playwright-mcp` — the de-facto standard a11y loop (~200–400 tokens/snapshot, default in Copilot's coding agent) — covers headless web pages only. Neither can test what actually breaks shipping software:

- browser extensions, WebGL, and font rendering, which headless chromium hides;
- packaged/native Linux apps (GTK/Qt/Tauri) — today a manual VM (Priya) or untested `.deb`/AppImage artifacts (Marcus);
- login-gated flows — CI grids cannot hold login state; auth-state tests are the flaky ones;
- failure evidence — grids produce videos nobody scrubs; issue screenshots prove nothing about *sequence* (Tomasz).

The slot — *a local, throwaway, real GUI that an agent or CI script drives through the standardized snapshot → act-on-ref → verify loop, with live human oversight* — is open. micke's expensive components (disposable desktop image, AT-SPI driver with JSON receipts, bidirectional noVNC, daemon-free gvx option) are already built and verified end-to-end under both runtimes; what remains is plumbing (supervisor, MCP, dashboard, image pipeline), not research.

## 3. Target users

- **P1 — Priya**, product engineer at a 12-person SaaS startup (Tauri/GTK desktop app + web app; codes with Claude Code over MCP). Wants every session visible on one page (R1) and to do the staging SSO login herself inside the sandbox so the credential never reaches the agent or transcript (R2). Runs `micke:gtk`.
- **P2 — Marcus**, QA/platform engineer owning nightly + per-release E2E on a self-hosted runner. Wants the whole run at one localhost URL with no SSH (R1), human login mid-run without breaking it (R2), and digest-pinned variant images pre-pulled by runner warmup.
- **P3 — Tomasz**, solo maintainer of a 4k-star GTK4 utility, zero budget. Needs CI that can actually click a Linux GUI app and produce sequence evidence (receipts), not screenshots pasted into issues.

## 4. Goals / Non-goals

**Goals**

1. Ship the MCP layer (exactly four tools, R3) and supervisor that turn the verified image into a product.
2. Real-GUI agent/QA workflow: `snapshot -i` → `click @ref` → `wait --window` → re-snapshot, asserting on JSON receipts on a real X server — no pixel matching.
3. Human-in-the-loop by design: R1 dashboard for at-a-glance oversight, R2 manual noVNC intervention for credentials and judgment calls.
4. Pull-only image model: pinned registry refs, zero builds in user flows, hermetic CI after warmup.
5. Docker primary runtime; gvx as opt-in unprivileged alternative (same image, verified parity).

**Non-goals (explicit, for now)**

- **Image building in user flows** — no `docker build`/`rungv build` anywhere a user or agent touches; builds are project CI. Maintainer escape hatch (`docker build`, `docker save | rungv load`) exists out-of-scope.
- **Consumer packaging / butler product (Direction C)** — micke is developer tooling, not a personal assistant desktop.
- **Security-product features (Direction B)** — no egress filtering, credential broker, or action-level command interception. Deferred.
- **Multi-host / cloud orchestration** — one host, one supervisor, local-first; no telemetry.
- **Firefox/WebKit engines** — chromium-only image; other engines later.
- **Model/skill layer curation** — micke provides the desk and the shell; agent behavior is the agent's (and its user's) business.

## 5. Functional requirements

Status legend: **implemented** (ships in today's image), **verified** (mechanism measured hands-on; integration planned), **planned** (design agreed, not built). Priorities: P0 = MVP-blocking, P1 = fast-follow, P2 = later.

### 5.1 Session lifecycle & MCP surface (R3)

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-1 | P0 | `session.create {image, runtime}` boots a session and returns session id + noVNC URL; pull policy per FR-31/32. | R3; A1, B1 | planned (manual `docker run` ready in 0.54 s) |
| FR-2 | P0 | Runtime selector on create: `docker` (default) or `gvx` (opt-in). | locked design 6 | planned |
| FR-3 | P0 | `session.list` returns live sessions with id, runtime, status, uptime, and noVNC URL (no hand-copied rungv stderr). | R3; C1 | planned |
| FR-4 | P0 | `session.close` tears the session down and discards all state; the next session gets the same digest-pinned desk bit-for-bit. | R3; A7 | planned (`docker rm -f` ~1 s; gvx kill 0.52 s, zero strays — measured) |
| FR-5 | P0 | The MCP surface is **exactly four tools**: `session.create`, `session.list`, `session.close`, one persistent shell tool (working name `session.shell`). No per-command proxy tools, ever. | R3 (locked) | planned |

### 5.2 Persistent shell tool (R3)

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-6 | P0 | One long-lived shell (PTY) per session; environment and working directory persist across tool invocations. | R3; A2, B3 | verified (both channels), tool planned |
| FR-7 | P0 | ALL CLI usage — every `agent-desktop` call, builds, `jq`, anything in the image — goes through this one shell. | R3 (locked) | verified pattern |
| FR-8 | P0 | Docker backend: wraps `docker exec`, auto-sources `/tmp/session.env` so `agent-desktop` works with no manual env setup. | R3; README | verified by hand |
| FR-9 | P0 | gvx backend: session stdin line channel with `===BEGIN===` / `===END rc=N===` framing (gvx has no exec by design). | R3; feasibility §4.3 | verified |
| FR-10 | P0 | Shell state is destroyed on `session.close` and on supervisor restart; no PTY, process, or FIFO leaks (verifiable by fd/process count after repeated create/close cycles). | scenario risk 7 | planned |
| FR-11 | P0 | Each command returns framed stdout, stderr, and exit code; output is capped (truncate with explicit marker) so a runaway command cannot blow the MCP response. | R3 | planned |
| FR-12 | P0 | Per-command timeout kills the offending command only — never the shell or the session. | R3 | planned |
| FR-13 | P1 | Background jobs have documented semantics: killed on close, and either listed or killed on per-command timeout; no orphaned children. | scenario risk 7 | planned |
| FR-14 | P1 | Defined behavior for a dropped/reconnected channel: transparent resume or explicit state-reset receipt; no silent half-state. | scenario risk 7 | planned |

### 5.3 Supervisor

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-15 | P0 | One host process per session owning the runtime child (Docker container, or foreground `rungv run -i`). | locked design 7; feasibility §6 | planned |
| FR-16 | P0 | Per-session port allocation: Docker `-p` with host-chosen ports; gvx bare `-p 6080` with host port parsed from the `rungv: publishing 127.0.0.1:PORT -> 6080/tcp` stderr line. Fixed 5900/6080 must not collide at N>1. | scenario mapping; feasibility §4.7 | planned (stderr line format verified) |
| FR-17 | P0 | Discovered noVNC URLs are published via dashboard rows and `session.list`. | R1; C1 | planned |
| FR-18 | P0 | Memory guards: gvx sessions get `-m 2g` by default (~2 GiB/chromium session measured); supervisor refuses or parks new sessions when host free memory is below a safe threshold (host-OOM incident observed when this was missing). | feasibility §4.8, §6 | planned (`-m` flag verified) |
| FR-19 | P0 | One supervisor per host (instance lock); it owns port allocation and pull serialization — no second supervisor racing it. | pull-only; risk 6 | planned |
| FR-20 | P1 | Configurable max concurrent sessions per host (memory-derived default: ~8 Docker / ~2 gvx per 8 GiB). | B1 | planned |
| FR-21 | P1 | `session.create` failures return structured receipts: image missing from cache, insufficient memory, ports exhausted. | R3 | planned |
| FR-22 | P2 | Optional single relay origin for all noVNC URLs (vs N raw host ports) once traffic/proxy shape is decided. | scenario mapping; OQ-2 | planned |

### 5.4 Session dashboard (R1)

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-23 | P0 | Supervisor-served web UI at `127.0.0.1:7800` by default (bind address/port configurable; localhost-only default is a security property, not a convenience). | R1; risk 6 | planned |
| FR-24 | P0 | One row per session: id, runtime (docker/gvx), status, uptime, memory, running windows (via `agent-desktop list-windows` through the shell channel). | R1; B2 | planned |
| FR-25 | P0 | Per-row noVNC link opens that session's live desktop. | R1; R2 entry point | planned (noVNC serving works today: vnc.html 200, RFB over websocket) |
| FR-26 | P1 | Optional embedded noVNC iframe per row. | R1; A5 | planned |
| FR-27 | P1 | Memory column warns before a host (especially gvx) tips into the OOM killer. | B2 | planned |
| FR-28 | P2 | Auth (token or similar) before a dashboard is shareable beyond localhost; until shipped, sharing is documented as unsupported. | risk 6; OQ-1 | planned |
| FR-29 | P2 | Dashboard auto-refreshes (live-ish status without manual reload). | R1 | planned |

### 5.5 Image policy (pull-only)

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-30 | P0 | Default image is a pinned registry ref (`ghcr.io/…/micke:<tag>`), digest-pinned; supply-chain control until signing exists. | pull-only; risk 9 | planned (pipeline) |
| FR-31 | P0 | Pull-if-missing before a session starts; sessions always run cache-only (`--pull=never` / Docker equivalent). | pull-only; B1 | planned (cache-only runs verified under gvx) |
| FR-32 | P0 | The supervisor NEVER initiates a pull while any session is live (pulls serialized behind session quiescence) — host OOM was observed once when a pull overlapped a sandbox. | feasibility §4.8 | planned (policy) |
| FR-33 | P0 | Warmup/pre-pull hook (supervisor startup option or explicit command) so CI runners can fetch all needed variants before the suite starts. | B1 | planned (`docker pull` / `rungv pull` verified) |
| FR-34 | P1 | Local-ref override for development (point the supervisor at a locally tagged image); the maintainer escape hatch stays out of user flows. | pull-only | planned |
| FR-35 | P1 | Official variants with baked toolchains: `micke:latest` (base), `micke:gtk`, `micke:node`; users pick a tag, still pull-only — removes the per-session `apt-get` tax. | scenario mapping | planned |
| FR-36 | P2 | Image signing (e.g. cosign). | risk 9 | planned |
| FR-37 | P2 | Cache hygiene: report local image-cache disk usage (Docker layers + gvx EROFS cache) and support pruning. | pull-only ops | planned |

### 5.6 Runtimes

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-38 | P0 | Docker is the default runtime (`--shm-size=1g` for chromium; ~8 concurrent chromium sessions per 8 GiB host). | locked design 6 | implemented (manual), verified |
| FR-39 | P1 | gvx is an opt-in runtime: unprivileged, no daemon/root/host namespaces, seccomp self-lockdown; ~2 GiB/chromium session → ~2 per 8 GiB host; `-m` per FR-18. | locked design 6; feasibility | verified end-to-end |
| FR-40 | P0 | Same image runs under both runtimes with verified parity (identical snapshot ref counts: 83 on example.com under both). | locked design 6 | verified |

### 5.7 Desktop stack in-image

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-41 | P0 | `agent-desktop` v1.0.2 present and functional in-image: `ACCESSIBILITY_ENABLED=1`, `/tmp/session.env` published with DISPLAY/D-Bus/AT-SPI addresses; a11y granted at boot. | README; A3 | implemented, verified |
| FR-42 | P0 | Chromium launch requirements documented: `--no-sandbox`, `--force-renderer-accessibility`, `--arg=` passthrough (e.g. `--load-extension`); real Xvfb 1280x800, not headless. | B4; README | implemented, verified |
| FR-43 | P0 | Per-session x11vnc `:5900` + websockify/noVNC `:6080`; startup failure is non-fatal to the session; optional `MICKE_VNC_PASSWORD`. | README; R2 mechanism | implemented, verified |

### 5.8 Artifacts

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-44 | P0 | Screenshot and snapshot-JSON retrieval through the shell channel (`agent-desktop screenshot` + base64 out; 102 KB PNG measured). | A6, B6 | verified |
| FR-45 | P1 | Workspace host bind chosen at session start: repo staging in, artifacts out — no base64 for large files. | A2, B6 (GAP) | planned (gvx needs `-v` at start) |
| FR-46 | P2 | Artifact convention (path layout, naming, report integration) so CI evidence bundles are uniform. | scenario mapping (PARTIAL); OQ-4 | planned |

### 5.9 Manual VNC intervention (R2)

| ID | Pri | Requirement | Source | Status |
| :-- | :-- | :-- | :-- | :-- |
| FR-47 | P1 | Documented intervention flow: agent pauses (announced) → human opens that session's noVNC from the dashboard → acts (e.g. SSO login; the credential never enters the transcript) → agent resumes and verifies via receipts. Example prompts/scripts shipped. | R2; A5, B5 | planned (mechanism verified; flow + agent contract undocumented) |
| FR-48 | P0 | Human-vs-agent input arbitration on the shared X display is documented as a known unsolved hazard; users are told to intervene only while the agent is paused. | R2; scenario risk 7 | planned (documentation) |

## 6. User experience flows

**Inner-loop GUI testing (P1, interactive).**
1. Agent calls `session.create` (`micke:gtk`, pulled if missing) → dashboard row flips `ready` with its noVNC link.
2. Agent stages the repo (workspace bind) and builds through the persistent shell — env/cwd persist, toolchain pre-baked, untrusted output stays in the sandbox.
3. `agent-desktop launch` → `snapshot -i` → `click @ref` → `wait --window` → re-snapshot; assertions read JSON receipts (window titles, ref counts, states), not pixels.
4. Login wall → agent pauses, human logs in via the dashboard noVNC link/iframe, agent resumes (R2; FR-47).
5. Screenshot + receipts to the PR; `session.close`; row disappears; nothing persists.

**CI nightly regression (P2, headless-of-headless).**
1. Warmup pre-pulls digest-pinned variants before any session starts (FR-33).
2. Supervisor boots N sessions cache-only (~8 per 8 GiB on Docker, ~2 on gvx); dashboard shows the grid with memory warnings.
3. Each session runs one scripted, non-LLM bash + agent-desktop group over the shell channel: `jq` assertions on receipts, non-zero exit with receipt attached on failure.
4. On failure: screenshot + last snapshot JSON out via shell/base64 or workspace bind — the report says *which ref* vanished, not a video timestamp.
5. Teardown kills all sessions; report = receipts + screenshots + exit codes; hermetic, local, zero vendor CI minutes.

**Human-login intervention (R2 core).**
1. Agent hits SSO/CAPTCHA, announces a pause (agent-side contract, documented).
2. Human opens the session's noVNC link or iframe from the dashboard.
3. Human performs the login — the credential never enters any transcript.
4. Agent resumes, `wait --window` confirms the authenticated state, the script continues.
5. While both human and agent drive, arbitration is the documented hazard (FR-48).

## 7. Success metrics

| Metric | Target | Baseline / source |
| :-- | :-- | :-- |
| Session boot (`session.create` → desktop ready) | < 2 s | 0.54 s Docker / 1.07 s gvx measured (feasibility §4.5) |
| Teardown (`session.close` → gone) | < 2 s, zero stray processes | ~1 s `docker rm -f` / 0.52 s gvx kill, zero strays measured |
| Shell command round-trip overhead vs raw exec | < 200 ms P95 | Framing channel measured informally; target is a product decision, not a measured baseline |
| Dashboard page load | < 1 s | New surface; no baseline |
| Snapshot parity across runtimes | Identical ref count on the same page | 83 refs on example.com, identical Docker/gvx (feasibility §4.4) |
| Session memory guardrail | Docker chromium session ≤ ~500 MiB; gvx ≤ ~2.2 GiB (PSS) | Measured 404.6 MiB / 1836 MiB PSS (feasibility §4.5); targets add headroom |
| Leak-free cycling | fd + process counts return to baseline after repeated create/close cycles | New test; cycle count set in the test plan |
| CI acceptance scenario | A scripted agent-desktop test runs green on a freshly pulled image with networking disabled after warmup | End-to-end flow verified manually under both runtimes (research §4) |

## 8. Milestones

Dependency-ordered; each unlocks the named scenario capabilities.

- **M1 — Supervisor + MCP layer.** Per-session host process (FR-15), the four tools (FR-1–5), persistent shell on both runtimes (FR-6–14), port allocation + noVNC URL bookkeeping (FR-16/17), memory guards + instance lock (FR-18/19). *Exit criteria:* scenario A steps 1–3 and 5 runnable purely through MCP tools on both runtimes; repeated create/close cycles leave zero stray processes/fds. *Unlocks:* the core agent loop; closes the "today micke is `docker exec` + bash" gap (scenario risk 2).
- **M2 — Dashboard (R1).** FR-23–27 (relay decision scoped, FR-22). *Exit criteria:* a nightly-style run of N sessions is observable — status, memory, windows, one-click noVNC — without SSH. *Unlocks:* at-a-glance oversight for Priya/Marcus, noVNC URL distribution, and the front door for R2.
- **M3 — Registry pipeline + variants.** ghcr publishing, pinned default ref (FR-30), pull policies + warmup (FR-31–33), `:gtk`/`:node` variants (FR-35), local override (FR-34). *Exit criteria:* the CI acceptance metric (§7) passes on a clean host using only registry pulls. *Unlocks:* pull-only first-use, hermetic CI warmup, fast loops without the per-session `apt-get` tax.
- **M4 — Artifacts, docs & examples.** Workspace bind (FR-45), artifact convention (FR-46), scripted-CI examples (scenario B), R2 flow documentation + arbitration hazard (FR-47/48). *Exit criteria:* a copying-ready nightly-suite example and a documented human-login run. *Unlocks:* scenario B as a complete nightly product and R2 as a designed, teachable flow.

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
2. **The MCP layer doesn't exist yet.** Supervisor, shell tool, port allocation, dashboard are all PLANNED; the critical path is unglamorous plumbing (M1) — until then micke is a compelling demo, not a tool.
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
2. One relay origin vs N raw host ports for noVNC URLs (FR-22) — proxy complexity vs port sprawl.
3. Shell channel framing: keep the verified line protocol (`===BEGIN/===END rc=N===`) or upgrade to newline-delimited JSON-RPC once the driver is folded into the image (feasibility §6 suggests the upgrade path).
4. Artifact convention: path layout, naming, and report/CI integration (FR-46).
5. How variants get CI-tested: full matrix per release vs per-variant smoke (boot + snapshot ref-count check).
6. Persistent login profiles / state volumes (explicit gap; gvx `.ext4` named volumes exist but are unexposed).
7. Supervisor shape for gvx: CLI subprocess (as verified) vs embedded `pkg/gvx` SDK (one sandbox per process keeps seccomp lockdown; `DisableHostLockdown` trade-off).
8. Session recording/replay for review flows (explicit gap; screenshots only today).
