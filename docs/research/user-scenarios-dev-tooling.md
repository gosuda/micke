# micke user-scenario study — Direction A: developer tooling

## micke as the desktop harness for AI coding agents (agent-driven GUI testing / QA)

Date: 2026-11-02. Grounded in `README.md`, `docs/research/gvx-feasibility.md` (hands-on gvx
study of the same image/stack) and a light market scan (playwright-mcp, agent-sandbox
landscape, 2026). No repo files were modified.

Frame: the primary user is a developer — or their coding agent as MCP client (e.g. Claude
Code) — using micke sessions as a **throwaway real GUI** to build, run, exercise, and verify
software. Stack today: Debian + Xvfb `:99` + openbox + AT-SPI, chromium, `agent-desktop`
v1.0.2 (`snapshot -i` → stable `@ref`s → `click`/`type` → re-snapshot; JSON receipts;
`screenshot`; `wait --window`; `list-apps`), x11vnc `:5900` + noVNC `:6080`, Docker
(`docker exec` + `/tmp/session.env`) or gvx (`rungv run -i`, no daemon, stdin line channel).
The MCP layer (`session.create`/`close` + agent-desktop proxy tools) is **planned, not
built**.

## 1. Personas

**P1 — Priya, product engineer, 12-person SaaS startup.** Ships a time-tracking desktop app
(Tauri/GTK on Linux) plus a web app; codes with Claude Code over MCP. Today: headless
Playwright + `playwright-mcp` for the web app, **manual VM for the desktop app**. Pains: the
agent is blind on the desktop build ("tests pass, app won't even launch" escapes review);
headless chromium hides extension, WebGL, and font-rendering issues; agents must not touch
her laptop.

**P2 — Marcus, QA/platform engineer.** Owns the E2E suite (nightly + per-release). Today:
Playwright grid, chromium-only, CI-minute billing, flaky auth-state tests. Pains: login
state and extensions are untestable in the grid; the Linux `.deb`/AppImage artifact has no
test story at all; failure evidence is a video nobody scrubs through.

**P3 — Tomasz, solo maintainer of a GTK4 utility.** 4k GitHub stars, zero budget; tests by
booting a VM by hand before releases. Pains: no CI can click a Linux GUI app; screenshots
pasted into issues prove nothing about *sequence*.

## 2. Scenario walk-throughs

### A. Inner-loop GUI testing by a coding agent (P1, interactive)

1. Priya asks Claude Code: "the Start-Timer button deadlocks after suspend — fix it and
   prove the fix." The agent calls `mcp__micke__session_create {image: "micke:dev"}`
   (PLANNED; today the equivalent is `docker run -d --init --shm-size=1g -p 127.0.0.1:6080:6080
   micke:dev`, desktop ready on `:99` in ~0.5 s).
2. The agent stages the repo into the session and builds: `dpkg-buildpackage` inside the
   session via the command channel (`docker exec micke-… bash -lc 'apt-get install -y
   libgtk-4-dev && make deb'` today; the JSON stdin channel under gvx tomorrow). Untrusted
   build output runs only inside the sandbox — Priya's host stays clean.
3. The app installs a `.desktop` entry, so `agent-desktop list-apps` shows `tick`; the agent
   runs `agent-desktop launch tick` and gets a receipt with window `bounds` and
   `accessible:true` — first assertion: the app boots and exposes an a11y tree.
4. `agent-desktop snapshot --app tick -i` → 40-ish refs (role, name, state). Agent picks
   `click "@<snapshot>:e12"` (Start Timer), then `wait --window "tick — running"
   --timeout 5000`, then re-snapshots and asserts the timer label ref now reads `00:01`.
   Receipts are JSON (`{"ok":true,"steps":[{"mechanism":"semantic_api",...}]}`) — assertions
   read data, not pixels.
5. It reproduces the deadlock first (`SIGSTOP`/dump), verifies the bug's receipt signature,
   patches, rebuilds, re-runs step 4 green. `agent-desktop screenshot /tmp/evidence.png`
   (102 KB PNG measured) is attached to the PR alongside the receipts.
6. `mcp__micke__session_close` → `docker rm -f` (~1 s) or SIGKILL of the `rungv` child
   (0.52 s, zero strays). Nothing persists — the next task gets an identical desk.

### B. E2E regression suite on CI (P2, headless-of-headless)

1. Nightly job on a self-hosted runner; image preloaded once (`docker pull`, or
   `docker save micke:dev | rungv load` — 8 s for 388 MB — then `--pull=never`). A micke
   **supervisor** (PLANNED) boots N parallel sessions: ≈ 8 concurrent chromium sessions
   per 8 GiB host on Docker; ≈ 2 on gvx (~2 GiB PSS each).
2. Each session is one test group: fresh container, deterministic image, fixed 1280x800
   canvas — no "works on my resolution" flakes. Tests are **scripted bash + agent-desktop,
   not LLM-driven** (the market's cheap "CLI-skill" pattern): each step checks `"ok":true`
   and a ref assertion via `jq`; failure exits non-zero with the receipt attached.
3. Browser realism the grid can't do: chromium with `--load-extension` via `--arg=`, WebGL
   on a real X server (not `--headless=new`), `--force-renderer-accessibility`;
   `/dev/shm` is 1 GiB under Docker, 3.9 GiB under gvx — no `--disable-dev-shm-usage`.
4. On failure the suite exports `agent-desktop screenshot` via the command channel
   (base64, ~102 KB measured) or a `-workspace` host bind (PLANNED convenience), plus the
   last snapshot JSON — PR comments show *which ref* vanished, not a video timestamp.
5. The job prints each session's noVNC URL (per-session host `-p` under Docker;
   auto-picked under gvx from the `rungv: publishing 127.0.0.1:PORT -> 6080/tcp` stderr
   line) so on-call can open `http://…/vnc.html` mid-run (`MICKE_VNC_PASSWORD` gates it).
   Teardown kills all sessions; report = receipts + screenshots + exit codes — hermetic,
   local, zero vendor CI minutes.

### C. Human-in-the-loop debugging / design review (P1 + designer, P3)

1. Bug #412 lands: "export dialog eats the filename." Priya asks the agent to reproduce it
   in a micke session and **sends the designer the noVNC URL**
   (`http://localhost:6080/vnc.html`; gvx auto-publishes e.g. `http://host:38271/vnc.html`).
2. They watch live at 1:1 while the agent drives: `agent-desktop snapshot --app tick -i` →
   `click "@…:e31"` (Export) → `type "report.csv"` → the bug fires. The humans see the exact
   keystroke loss in real time — what a screenshot in the issue never showed.
3. noVNC is bidirectional: the designer grabs the mouse and demonstrates the "correct" feel
   of the dialog while the agent waits; then re-runs its script. (Also a hazard — see risks.)
4. Agent patches, rebuilds in the same session, replays the script: `snapshot → type →
   re-snapshot` receipts turn green; it posts receipts + before/after screenshots to the PR.
   For design review, the agent "auditions" states on demand — empty state / error toast /
   long-username overflow — via targeted `click`/`type` in one stable viewport.
5. Review done, `session.close`; those dialog states existed for exactly 20 minutes and
   left nothing behind. GAP for later: session recording/replay (no built-in capture).

## 3. Feature mapping

| Scenario step | micke status | Detail / what's needed |
| :--- | :--- | :--- |
| A1 session create per agent request | **PLANNED** | MCP `session.create`/`close` not built; manual `docker run -d` works today |
| A1 / B1 parallel sessions, per-session ports, supervisor | **PLANNED** | No MCP tools, no supervisor; Docker needs per-session `-p` (ports fixed at 5900/6080 in-sandbox); gvx auto-picks + stderr line; ~8 (Docker) / ~2 (gvx, chromium) sessions per 8 GiB |
| A2 command channel into session | HAS (Docker) / PLANNED (gvx) | `docker exec` today; gvx stdin line protocol verified, JSON-RPC upgrade planned |
| A2 repo staging / workspace bind | **GAP** | `docker cp` manual only; no micke workspace/artifact tooling; gvx needs `-v` bind decided at start |
| A2 build deps preinstalled (toolchain image) | **GAP** | Everything is `apt-get install` per session; no derived-image/baking story → slow loops |
| A3–A5 snapshot → `click @ref` → verify (incl. custom apps) | HAS | agent-desktop 1.0.2 via AT-SPI; 83 refs on example.com, identical Docker/gvx; GTK/Qt/Tauri a11y untested |
| A5 / B4 screenshot + receipt artifacts out of session | PARTIAL | PNG works in-session (102 KB); retrieval = base64 (works) or bind (PLANNED tool); no artifact convention / report integration |
| A6 teardown, nothing left behind | HAS | `docker rm -f` ~1 s; gvx kill 0.52 s, zero strays |
| B2 scripted non-LLM test steps | HAS | bash + agent-desktop JSON receipts; needs only the channel + docs/examples |
| B3 extension / WebGL / real-X browser; Firefox/WebKit | HAS / GAP | chromium + `--arg=` passthrough on real Xvfb; image is chromium-only |
| B5 live noVNC URL per CI session | HAS (mechanism) / GAP (plumbing) | websockify works; per-session URL discovery + auth (`MICKE_VNC_PASSWORD`) needs packaging |
| B persistent login state / profile volume | **GAP** | No state volumes; gvx named `.ext4` volumes exist but aren't exposed by micke |
| C1–C3 live view; human drives while agent waits | HAS (mechanism) / GAP (arbitration) | noVNC at `:6080/vnc.html` is bidirectional; no input arbitration between human and agent |
| C5 session recording / replay | **GAP** | Screenshots only; no video/timeline capture |

## 4. Why this direction is the strongest fit

1. **The interaction model is already the industry default.** Agent GUI testing in 2026
   converged on a11y-tree snapshot → act on stable ref → verify (playwright-mcp: ~200–400
   tokens/snapshot, default in Copilot's coding agent). agent-desktop speaks exactly that
   loop — for a whole desktop, not just a browser tab. micke supplies the missing *place*
   where that loop runs against non-headless targets.
2. **Disposability matches test-fixture semantics 1:1.** One MCP session = one fresh,
   deterministic desk; teardown in ~0.5–1 s with zero residue — precisely what a test
   `setup()`/`teardown()` wants, and what no current sandbox offers: every coding-agent
   sandbox in 2026 (E2B, OpenHands, Sandvault, Sculptor) is headless-terminal only.
   "Sandbox with a screen" is an open slot.
3. **Receipts are assertion-ready today.** agent-desktop returns structured JSON (`ok`,
   `steps[].mechanism`, window titles, ref counts) — CI asserts without OCR or pixel
   matching; screenshots are evidence, not mechanism. Most of scenario B runs on the binary
   already in the image.
4. **Local-first is a real differentiator for QA.** No vendor CI minutes, no telemetry, no
   "approve a cloud agent runner" security review, while untrusted agent-built binaries
   stay contained (gvx removes root, daemon, and host namespaces entirely) — often the
   difference between a pilot and a blocked enterprise rollout.
5. **noVNC turns agent QA from black box into reviewable evidence.** A designer or on-call
   engineer watching the agent live — or grabbing the mouse — has no playwright-mcp
   equivalent, and offsets the "agents are executors, not planners" reality: humans stay in
   the loop cheaply.

## 5. Risks / weaknesses (honest)

1. **The wedge must be defended against free.** For pure web apps, `playwright-mcp` +
   headless chromium is zero-setup, Microsoft-backed, and good enough most days. micke only
   wins where a real display matters (extensions, WebGL, packaged/native apps, login
   windows, font/rendering). If the product reads as "a slower playwright," it loses.
2. **The MCP layer doesn't exist yet — every scenario above starts with a PLANNED row.**
   Today micke is `docker exec` + bash: no session supervisor, no per-session Docker port
   allocation (fixed 5900/6080 collides at N>1), no file staging, no artifact convention.
   The critical path to Direction A is unglamorous plumbing, not vision.
3. **Agent unreliability caps autonomy.** 2026 benchmarks: no leading model exceeds ~30% F1
   on real-world GUI testing without a human checklist. micke amplifies the driving agent's
   flakiness; the honest near-term product is scripted CI (B) plus supervised sessions (C),
   not set-and-forget agents.
4. **Environment coverage gaps undercut the QA pitch.** Chromium-only (no Firefox/WebKit),
   no persistent profiles/login state, no toolchain images, `apt-get` per session, and ~8
   vs ~2 concurrent chromium sessions per host (Docker vs gvx). Per-session installs are
   too slow for serious suites until image baking exists.
5. **Dependency and operational sharp edges.** agent-desktop is a v1.0.2 vercel-labs
   binary; gvx is a 7-star single-maintainer pre-1.0 fork. Bidirectional noVNC lets a
   viewer fight the agent's input mid-test; default `-nopw` is only as safe as the port
   mapping; agent-built code runs with NAT egress.

## 6. Verdict

Direction A is micke's strongest fit because every expensive component already built — the
disposable containerized desktop, the AT-SPI driver with stable refs and JSON receipts, the
noVNC mirror, the daemon-free gvx option — composes into a product the 2026 landscape
visibly lacks: a local, throwaway, *real* GUI that either a coding agent (inner loop) or a
CI script (regression) drives through the same a11y-tree loop the ecosystem has standardized
on, with live human oversight one browser tab away. The scenarios map mostly onto HAS/
PLANNED rows rather than GAPs, and the differentiators (real display, local-first, receipts,
disposability) are things headless sandboxes and playwright-mcp structurally don't offer.
The work is plumbing — MCP session tools, a supervisor with per-session ports, file/artifact
staging, image baking — plus honest positioning against "headless is enough"; if micke stays
chromium-only and pre-MCP, this stays a compelling demo rather than a tool.
