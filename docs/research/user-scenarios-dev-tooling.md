# micke user-scenario study — Direction A: developer tooling

## micke as the desktop harness for AI coding agents (agent-driven GUI testing / QA)

Date: 2026-11-02. Grounded in `README.md`, `docs/research/gvx-feasibility.md` (hands-on gvx
study of the same image/stack) and a light market scan (playwright-mcp, agent-sandbox
landscape, 2026); the underlying studies modified no repo files.

> **Revision 2026-11-02:** adds owner requirements **R1** session UI (web page of all
> running micke sessions), **R2** manual VNC intervention (open a session's noVNC and
> operate the desktop by hand, e.g. a login the agent shouldn't do), **R3** MCP shell tool
> (one shell channel for ALL CLI usage incl. every `agent-desktop` call — no proxies);
> and the **pull-only registry image model** — no image builds in user scenarios.

Frame: the primary user is a developer — or their coding agent as MCP client (e.g. Claude
Code) — using micke sessions as a **throwaway real GUI** to build, run, exercise, and verify
software. Image model (owner decision): **pull-only** — sessions start from a pre-built
registry image (default pinned ref, e.g. `ghcr.io/…/micke:<tag>`; variants
`micke:latest`/`gtk`/`node`); micke's own build/publish is project CI, outside user
flows. User flow: **pull → create session → shell → destroy** — pull-if-missing before
a session starts, sessions run `--pull=never` from cache (verified under gvx), never a
pull beside a live session (OOM lesson, B1). Stack today: Debian + Xvfb `:99` + openbox
+ AT-SPI, chromium, `agent-desktop` v1.0.2 (`snapshot -i` → stable `@ref`s →
`click`/`type` → re-snapshot; JSON receipts; `screenshot`; `wait --window`;
`list-apps`), x11vnc `:5900` + noVNC `:6080` per session (bidirectional input, optional
`MICKE_VNC_PASSWORD`, non-fatal to the session), Docker (`docker exec` +
`/tmp/session.env`) or gvx (`rungv run -i`, no
exec/daemon; stdin line channel with `===BEGIN===`/`===END rc=N===` framing). The MCP
layer is **planned, not built**; per R3 its entire surface is `session.create` /
`session.list` / `session.close` plus **one persistent shell tool** per session. The
supervisor — one host process per session owning the runtime child (feasibility §6) —
also serves a **session dashboard** (R1) at e.g. `127.0.0.1:7800`; manual VNC
intervention (R2) becomes a designed flow.

## 1. Personas

**P1 — Priya, product engineer, 12-person SaaS startup.** Ships a time-tracking desktop app
(Tauri/GTK on Linux) plus a web app; codes with Claude Code over MCP. Today: headless
Playwright + `playwright-mcp` for the web app, **manual VM for the desktop app**. Pains: the
agent is blind on the desktop build ("tests pass, app won't even launch" escapes review);
headless chromium hides extension, WebGL, and font-rendering issues; agents must not touch
her laptop. Wants (R1) every running session visible on one page; wants (R2) to do the
staging sync's SSO login herself, by hand, inside the sandbox — the credential never
reaches the agent. Sessions run the pre-pulled `micke:gtk` variant.

**P2 — Marcus, QA/platform engineer.** Owns the E2E suite (nightly + per-release). Today:
Playwright grid, chromium-only, CI-minute billing, flaky auth-state tests. Pains: login
state and extensions are untestable in the grid; the Linux `.deb`/AppImage artifact has no
test story at all; failure evidence is a video nobody scrubs through. Wants (R1) on-call
to see the whole nightly run at a glance — running/stuck/dead, memory pressure, one URL,
no SSH — and (R2) a way for a human to log in mid-run without breaking it. His runner
warmup pre-pulls digest-pinned variant images before the suite starts.

**P3 — Tomasz, solo maintainer of a GTK4 utility.** 4k GitHub stars, zero budget; tests by
booting a VM by hand before releases. Pains: no CI can click a Linux GUI app; screenshots
pasted into issues prove nothing about *sequence*.

## 2. Scenario walk-throughs

### A. Inner-loop GUI testing by a coding agent (P1, interactive)

1. Priya asks Claude Code: "the Start-Timer button deadlocks after suspend — fix it and
   prove the fix." The agent calls `mcp__micke__session_create {image:
   "ghcr.io/…/micke:gtk"}` (PLANNED) — a registry variant tag, never a local build; the
   supervisor pulls the pinned ref if missing, then runs from cache (manual equivalent
   today: `docker run -d --init --shm-size=1g -p 127.0.0.1:6080:6080 <ref>`, ready on
   `:99` in ~0.5 s); its dashboard row (R1) flips `ready` with its noVNC link.
2. The agent stages the repo and builds **through the session's persistent shell tool**
   (R3): one long-lived shell per session, `cd` and env persisting across invocations —
   under Docker it wraps `docker exec` and sources `/tmp/session.env` automatically, under
   gvx it is the verified stdin line channel. Building **her own app** in-session is
   core: the `gtk` variant ships the toolchain, so `make deb` runs at once (`apt-get
   install -y libgtk-4-dev` only on base) — untrusted output stays in the sandbox.
3. The app installs a `.desktop` entry, so `agent-desktop list-apps` (via the same shell)
   shows `tick`; `agent-desktop launch tick` returns a receipt with window `bounds` and
   `accessible:true` — first assertion: the app boots and exposes an a11y tree. The
   dashboard's window column (`agent-desktop list-windows`) turns non-empty.
4. `agent-desktop snapshot --app tick -i` → 40-ish refs (role, name, state). Agent picks
   `click "@<snapshot>:e12"` (Start Timer), then `wait --window "tick — running"`
   --timeout 5000`, then re-snapshots and asserts the timer label ref now reads `00:01` —
   assertions read receipt data, not pixels.
5. **Behind-SSO login, done by hand (R2):** the staging sync needs the company IdP. The
   agent launches the login page, then pauses; Priya opens the session's noVNC link on
   the dashboard (embedded iframe) and logs in herself — the credential never enters the
   transcript — and the agent resumes to `wait --window "tick — synced"` green.
6. It reproduces the deadlock (`SIGSTOP`/dump), verifies the bug's receipt signature,
   patches, rebuilds (same shell), re-runs step 4 green; `agent-desktop screenshot
   /tmp/evidence.png` (102 KB measured) goes to the PR with the receipts.
7. `mcp__micke__session_close` → `docker rm -f` (~1 s) or SIGKILL of the `rungv` child
   (0.52 s, zero strays); the dashboard row disappears. Nothing persists — the next
   task gets the same digest-pinned desk, bit for bit.

### B. E2E regression suite on CI (P2, headless-of-headless)

1. Nightly job on a self-hosted runner. **Warmup pre-pulls the digest-pinned variant
   images before any session starts** (`docker pull`, or `rungv pull` on gvx hosts —
   registry pulls verified); sessions then run `--pull=never` from cache, and nothing
   pulls beside a live session — the study saw the host OOM killer fire once when a
   pull overlapped a sandbox. A micke **supervisor** (PLANNED) boots N parallel
   sessions: ≈ 8 concurrent chromium sessions per 8 GiB host on Docker; ≈ 2 on gvx
   (~2 GiB PSS each).
2. The whole run is visible on the supervisor dashboard (R1): one row per session — id,
   runtime (docker/gvx), status, uptime, memory, running windows, noVNC link. On-call
   watches the grid at `http://127.0.0.1:7800`; the memory column warns when a gvx host
   is about to tip into the OOM killer.
3. Each session is one test group: fresh container, digest-pinned image identical on
   every runner, fixed 1280x800 canvas — no "works on my resolution" flakes. Tests are
   **scripted bash + agent-desktop through the same shell channel (R3), not LLM-driven**
   (the market's cheap "CLI-skill" pattern): each step checks `"ok":true` and a ref
   assertion via `jq`; failure exits non-zero with the receipt attached.
4. Browser realism the grid can't do: chromium with `--load-extension` via `--arg=`, WebGL
   on a real X server (not `--headless=new`), `--force-renderer-accessibility`;
   `/dev/shm` is 1 GiB under Docker, 3.9 GiB under gvx — no `--disable-dev-shm-usage`.
5. Login-gated groups (R2): a human performs the SSO login once per suite via the
   session's noVNC link from the dashboard, then the scripted steps take over from the
   authenticated state. Persistent profiles across sessions remain a GAP (below).
6. On failure the suite exports `agent-desktop screenshot` through the shell channel
   (base64, ~102 KB measured) or a `-workspace` host bind (PLANNED convenience), plus the
   last snapshot JSON — PR comments show *which ref* vanished, not a video timestamp.
   Teardown kills all sessions; report = receipts + screenshots + exit codes — hermetic,
   local, zero vendor CI minutes.

### C. Human-in-the-loop debugging / design review (P1 + designer, P3)

1. Bug #412 lands: "export dialog eats the filename." Priya asks the agent to reproduce it
   in a micke session and **sends the designer the session's noVNC URL** — from the
   dashboard row or `session.list`, not hand-copied from rungv stderr.
2. They watch live at 1:1 while the agent drives: `agent-desktop snapshot --app tick -i` →
   `click "@…:e31"` (Export) → `type "report.csv"` → the bug fires. The humans see the
   exact keystroke loss in real time — what a screenshot in the issue never showed.
3. noVNC is bidirectional: the designer grabs the mouse and demonstrates the "correct"
   feel of the dialog while the agent waits; then re-runs its script. This is the same
   mechanism R2 formalizes for login/takeover — a feature, not an accident. (Also a
   hazard — risks.)
4. Agent patches, rebuilds in the same session, replays the script: `snapshot → type →
   re-snapshot` receipts turn green, posted with before/after screenshots. For design
   review it "auditions" states on demand — empty state / error toast / long-username
   overflow — via targeted `click`/`type` in one stable viewport.
5. Review done, `session.close`; those dialog states existed for exactly 20 minutes and
   left nothing behind. GAP for later: session recording/replay (no built-in capture).

## 3. Feature mapping

| Scenario step | micke status | Detail / what's needed |
| :--- | :--- | :--- |
| A1/B1 session create + supervisor (parallel, per-session ports) | **PLANNED** | MCP `session.create`/`list`/`close` not built; manual `docker run -d` works today. One host process per session owning the runtime child (feasibility §6); Docker needs per-session `-p`; gvx auto-picks + stderr line; ~8 (Docker) / ~2 (gvx) chromium sessions per 8 GiB |
| R1 session dashboard (status at a glance) | **PLANNED** | Supervisor serves ~`127.0.0.1:7800`: id, runtime, status, uptime, memory, running windows (`agent-desktop list-windows` via the shell channel), per-session noVNC link + embedded iframe. New web surface to build, maintain, and secure |
| R3 persistent shell tool — ONE channel for all CLI incl. every `agent-desktop` call | HAS (mechanism) / **PLANNED** (tool) | Replaces the old "agent-desktop proxy tools" idea. Docker: `docker exec` + auto-source of `/tmp/session.env` verified by hand; gvx: stdin line channel with `===BEGIN/===END rc=N===` framing verified. MCP wrapper (PTY/long-lived shell, persistent env + cwd) not built |
| A2 repo staging / workspace bind | **GAP** | `docker cp` manual only; no micke workspace/artifact tooling; gvx needs `-v` bind decided at start |
| A2 in-session build of the user's own app | HAS | deps + `make deb` + install + GUI-test, all inside the session over the shell channel (R3) — the user's app, never micke's image |
| Image distribution — pre-built registry pull (default pinned ref + variants) | **PLANNED** | Project CI publishes `ghcr.io/…/micke:<tag>`; supervisor policy: pull-if-missing before a session starts (warmup/pre-pull — supervisor startup or explicit pull — covers CI runners), sessions run `--pull=never` from cache, never a pull beside live sessions (OOM lesson). Mechanism verified: `docker pull` native, `rungv pull` works. Maintainer escape hatch (`docker build` + `docker save \| rungv load`) exists, out of scenario scope |
| Official toolchain variant images (`micke:latest` / `gtk` / `node`) | **PLANNED** | Biked toolchains per variant tag; users pick a tag, still pull-only — removes the per-session `apt-get` tax that slowed loops. Custom derived images (`FROM micke:…`) = power-user flow outside this doc's scope |
| A3–A6 snapshot → `click @ref` → verify (incl. custom apps) | HAS | agent-desktop 1.0.2 via AT-SPI; 83 refs on example.com, identical Docker/gvx; GTK/Qt/Tauri a11y untested |
| A6 / B6 screenshot + receipt artifacts out of session | PARTIAL | PNG works in-session (102 KB); retrieval = base64 (works) or bind (PLANNED tool); no artifact convention / report integration |
| A7 teardown, nothing left behind | HAS | `docker rm -f` ~1 s; gvx kill 0.52 s, zero strays |
| B3 scripted non-LLM test steps | HAS | bash + agent-desktop JSON receipts over the same shell channel; needs only docs/examples |
| B4 extension / WebGL / real-X browser; Firefox/WebKit | HAS / GAP | chromium + `--arg=` passthrough on real Xvfb; image is chromium-only |
| R2 manual VNC intervention (human login / takeover) | HAS (mechanism) / **PLANNED** (flow) | noVNC is bidirectional today with optional `MICKE_VNC_PASSWORD`, non-fatal to the session; the designed pause → human logs in via dashboard link/iframe → agent resumes flow is PLANNED, as is input arbitration between human and agent (C1–C3) |
| B2/B5 / C1 per-session noVNC URL discovery + relay | HAS (mechanism) / **PLANNED** (plumbing) | websockify works; supervisor must allocate Docker `-p` ports / parse the `rungv: publishing … -> 6080/tcp` stderr line and expose URLs via dashboard + `session.list` (ideally one relay origin instead of N raw ports) |
| B5 / B persistent login state / profile volume | **GAP** | No state volumes; gvx named `.ext4` volumes exist but aren't exposed; R2's human login covers one run, not a reusable profile |
| C5 session recording / replay | **GAP** | Screenshots only; no video/timeline capture |

## 4. Why this direction is the strongest fit

1. **The interaction model is already the industry default.** Agent GUI testing in 2026
   converged on a11y-tree snapshot → act on stable ref → verify (playwright-mcp: ~200–400
   tokens/snapshot, default in Copilot's coding agent). agent-desktop speaks exactly that
   loop — for a whole desktop, not just a browser tab. micke supplies the missing *place*
   where that loop runs against non-headless targets.
2. **Disposability matches test-fixture semantics 1:1.** One MCP session = one fresh,
   deterministic desk — digest-pinned, the same image on every host; teardown in
   ~0.5–1 s with zero residue — precisely what a test `setup()`/`teardown()` wants, and
   what no current sandbox offers: every coding-agent sandbox in 2026 (E2B, OpenHands,
   Sandvault, Sculptor) is headless-terminal only. "Sandbox with a screen" is an open slot.
3. **Receipts are assertion-ready today.** agent-desktop returns structured JSON (`ok`,
   `steps[].mechanism`, window titles, ref counts) — CI asserts without OCR or pixel
   matching; screenshots are evidence, not mechanism. Most of scenario B runs on the binary
   already in the image.
4. **Local-first is a real differentiator for QA.** No vendor CI minutes, no telemetry, no
   "approve a cloud agent runner" security review, while untrusted agent-built binaries
   stay contained (gvx removes root, daemon, and host namespaces entirely) — often the
   difference between a pilot and a blocked enterprise rollout.
5. **R1 + R2 turn agent QA from black box into reviewable, interruptible evidence.** A
   dashboard row per session (status, memory, windows, one-click noVNC) plus taking the
   mouse mid-run — to log in behind SSO, solve a CAPTCHA, or demonstrate feel — has no
   playwright-mcp equivalent, and offsets the "agents are executors, not planners"
   reality: humans stay in the loop cheaply, secrets stay out of transcripts.
6. **R3 keeps the MCP surface minimal — four tools, one channel.** One persistent shell
   instead of N per-command proxies: one thing to specify, test, and maintain;
   agent-desktop CLI churn becomes invisible to MCP clients; the same channel serves
   builds, `jq`, anything in the image. Cost: receipts are only as structured as the JSON
   the agent parses off stdout (risk 7).

## 5. Risks / weaknesses (honest)

1. **The wedge must be defended against free.** For pure web apps, `playwright-mcp` +
   headless chromium is zero-setup, Microsoft-backed, and good enough most days. micke only
   wins where a real display matters (extensions, WebGL, packaged/native apps, login
   windows, font/rendering). If the product reads as "a slower playwright," it loses.
2. **The MCP layer doesn't exist yet — every scenario above starts with a PLANNED row.**
   Today micke is `docker exec` + bash: no supervisor, dashboard, shell tool, per-session
   Docker port allocation (fixed 5900/6080 collides at N>1), file staging, or artifact
   convention. The critical path is unglamorous plumbing, not vision.
3. **Agent unreliability caps autonomy.** 2026 benchmarks: no leading model exceeds ~30% F1
   on real-world GUI testing without a human checklist. micke amplifies the driving agent's
   flakiness; the honest near-term product is scripted CI (B) plus supervised sessions (C),
   not set-and-forget agents.
4. **Environment coverage gaps undercut the QA pitch.** Chromium-only (no Firefox/WebKit),
   no persistent profiles (R2's login is per-run), toolchain variants still PLANNED
   (`apt-get` per session on the base image until they ship), ~8 vs ~2 concurrent
   chromium sessions per host (Docker vs gvx) — slow loops until the variants publish.
5. **Dependency and operational sharp edges.** agent-desktop is a v1.0.2 vercel-labs
   binary; gvx is a 7-star single-maintainer pre-1.0 fork. Per-session port bookkeeping
   (Docker `-p` allocation, parsing the `rungv: publishing …` stderr line) is now
   load-bearing: dashboard links and `session.list` URLs break if it goes wrong;
   agent-built code runs with NAT egress.
6. **The dashboard is a new attack and UI surface.** Whoever reaches the supervisor's port
   (e.g. `:7800`) can watch every session and open every noVNC link; it must bind
   `127.0.0.1` by default and still needs an auth story before sharing — plus it is a
   real frontend to maintain.
7. **The shell tool is maximal capability by design — and stateful.** One channel means no
   action-level interception or auditing — the supervisor sees command strings and
   whatever receipts the CLI prints, nothing finer (noVNC already lets a human do
   anything; now the agent gets full CLI power too). Persistent shells carry state that
   must be defined away on `session.close`, supervisor restart, or a dropped channel
   (cwd, env, background jobs — or sessions leak PTYs). Human-vs-agent input arbitration
   on the shared X display stays unsolved.
8. **Manual intervention is a flow, not a feature flag.** R2 needs the agent to actually
   pause and resume observably — half of that is agent behavior (prompt/MCP contract), not
   micke code, and it will be tested by humans with mice at the worst moment.
9. **Pull-only adds first-use network and registry dependencies.** Hundreds of MB before
   the first session (local-first tension; one-time cache mitigates, warmup covers CI,
   no offline cold-start story); ghcr rate limits or a deleted/renamed image breaks
   pinned refs; supply chain: digest pinning now, signing (cosign) later.
10. **Variant sprawl.** Each variant is a tag users must pick between and an image the
    project must build, test, and keep fresh — maintenance cost per variant.

## 6. Verdict

Direction A is micke's strongest fit because every expensive component already built — the
disposable containerized desktop, the AT-SPI driver with stable refs and JSON receipts, the
bidirectional noVNC mirror, the daemon-free gvx option — composes into a product the 2026
landscape visibly lacks: a local, throwaway, *real* GUI that a coding agent or a CI
script drives through the a11y-tree loop the ecosystem standardized on — with live
oversight one browser tab away (R1), a human hand on the mouse when judgment or
credentials are required (R2), over one minimal MCP surface (R3). The scenarios map
mostly onto HAS/PLANNED rows; the differentiators (real display, local-first, receipts,
disposability, human-in-the-loop) are things headless sandboxes and playwright-mcp
structurally don't offer. The work is plumbing — MCP session tools plus the persistent
shell channel, a supervisor with per-session ports, the dashboard with noVNC URL
discovery/relay, file/artifact staging, variant-image registry publishing plus a
pull-if-missing supervisor policy — plus positioning against "headless is enough";
pre-MCP and chromium-only, micke stays a compelling demo, not a tool.
