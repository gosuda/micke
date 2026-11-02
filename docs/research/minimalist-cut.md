# micke minimalist audit — the M-min cut

Date: 2026-11-02 · Auditor: THE ULTIMATE MINIMALIST · Inputs: `docs/prd.md` (48 FRs, L1–L7
locked), `docs/research/user-scenarios-dev-tooling.md`, `docs/research/gvx-feasibility.md`.
This file is a verdict, not an edit: nothing else was touched.

**The yardstick.** One core loop: an AI coding agent, from an MCP client, creates a session →
drives everything (every `agent-desktop` call included) through the ONE persistent shell → a
human watches/intervenes via noVNC in a browser → session closes clean. ONE runtime. LOCAL
image. Humans watch; agents drive; sessions die clean. Anything that carries no load in that
loop is debt: build cost, test cost, maintain cost, explain cost. "Might be useful later" is
a death sentence, not an argument.

**Score: 18 KEEP + 12 SHRINK + 15 DEFER + 3 CUT = 48 FRs accounted for.**

---

## 1. The minimal core (KEEP)

| FR | Verdict | Why it's load-bearing for the core loop | Cost |
| :-- | :-- | :-- | :-- |
| FR-1 | SHRINK | `session.create {image}` is the loop's front door; returns id + noVNC URL. Reduced: no `runtime` param — one runtime, one code path. | M |
| FR-3 | KEEP | `session.list` is the agent's map of live desks; the noVNC URL must come from somewhere machine-readable (not hand-copied rungv stderr). | S |
| FR-4 | KEEP | `session.close` — "sessions die clean" is a third of the yardstick. `docker rm -f` ~1 s, zero strays (measured). | S |
| FR-5 | KEEP | Exactly four tools: the most minimalist sentence in the PRD. Costs zero code and prevents an entire genus of proxy-tool debt. | S |
| FR-6 | KEEP | One persistent shell (PTY) per session — the loop's spine; env/cwd persist. | M |
| FR-7 | KEEP | ALL CLI (every `agent-desktop` call) through that shell — kills the per-command-proxy temptation forever. | S |
| FR-8 | KEEP | Docker backend wraps `docker exec`, auto-sources `/tmp/session.env` — verified by hand; without it every command needs env hand-holding. | S |
| FR-10 | KEEP | Shell state destroyed on close/restart; no PTY/FIFO/process leaks — makes "dies clean" testable (fd/process counts after cycles). | M |
| FR-11 | KEEP | Framed stdout/stderr/rc with capped output — one runaway `find /` must not blow the MCP response. | S |
| FR-12 | KEEP | Per-command timeout kills the command, never the shell/session — without it one `npm run dev` bricks the desk. | S |
| FR-15 | KEEP | One host process per session owning the runtime child — the supervisor IS the product layer; everything hangs off it. | M |
| FR-16 | SHRINK | Port allocation, Docker `-p` host-chosen ports ONLY; the gvx stderr parse defers with gvx. Un-cuttable: every noVNC link is born here, and fixed 5900/6080 collides at N>1 (PRD risk 6 calls it load-bearing — agreed). | S |
| FR-17 | SHRINK | Discovered URLs published via `session.list` + the static table (below). No relay, no third surface. | S |
| FR-18 | SHRINK | Memory guard reduced to: refuse new sessions when host free RAM is below a floor. The observed OOM was a gvx registry pull (in-memory layer compile) overlapping a sandbox; at Docker's 404.6 MiB/session the elaborate guard is a gvx problem. | S |
| FR-19 | KEEP | Instance lock — a flock file stopping a second supervisor from racing port allocation and pulls. | S |
| FR-21 | SHRINK | Failures return ONE structured error shape (machine-readable reason), not three engineered receipt cases. | S |
| FR-23 | SHRINK | Dashboard = one static, no-JS HTML table at `127.0.0.1:7800`; localhost-only bind stays a security property. No app, no framework, no build step. | S |
| FR-24 | SHRINK | Row = id, status, uptime, noVNC URL. Cut runtime column (constant under Docker-only); cut memory + windows columns — `list-windows` per row is a shell round-trip per cell, plumbing for decoration. | S |
| FR-25 | KEEP | Per-row noVNC link — the human's only door into the live desk. It's a hyperlink. | S |
| FR-29 | SHRINK | Auto-refresh = `<meta http-equiv="refresh" content="5">`. One line, zero JavaScript, no websocket status channel. | S |
| FR-31 | SHRINK | Pull-if-missing before create; runs cache-only otherwise (`--pull=never` verified). One `docker pull` behind a lock — nothing more. | S |
| FR-32 | SHRINK | Folded into FR-31's lock: never pull beside a live session. Under Docker-only this is a mutex, not a subsystem. | S |
| FR-34 | SHRINK (absorbed) | Local-ref override becomes M-min's DEFAULT — the local tag IS the image model until a registry exists. The feature disappears into the default. | zero |
| FR-38 | KEEP | Docker default runtime, `--shm-size=1g` — implemented and verified. | S |
| FR-41 | KEEP | `agent-desktop` v1.0.2 in-image, a11y granted at boot — the entire driving contract. Already shipped in the image. | zero |
| FR-42 | KEEP | Chromium launch flags documented (`--no-sandbox`, `--force-renderer-accessibility`, `--arg=` passthrough) — implemented/verified; one docs page keeps agents from rediscovering them. | S |
| FR-43 | KEEP | Per-session x11vnc + websockify/noVNC, non-fatal, optional password — the watch/intervene half of the yardstick; built and verified (vnc.html 200, RFB over websocket). | zero |
| FR-44 | KEEP | Screenshot/snapshot JSON out through the shell (base64; 102 KB PNG measured) — the loop's evidence exit. Verified. | zero |
| FR-47 | SHRINK | R2 flow = ONE doc page: pause contract → human opens link → acts → agent resumes on receipts, plus ONE example prompt. No example-script library, no agent-behavior curriculum. | S |
| FR-48 | KEEP | Human-vs-agent input arbitration documented as a known hazard — one paragraph of honesty protecting the one flow where a human and an agent share a mouse. | S |

## 2. The kill list (CUT / DEFER)

| FR | Verdict | Justification |
| :-- | :-- | :-- |
| FR-2 | DEFER | Runtime selector — there is one runtime; a parameter with one legal value is a lie. Trigger: gvx ships (FR-39). |
| FR-9 | DEFER | gvx stdin framing backend — a second shell backend for a runtime with zero users; the framing is verified, the maintenance isn't. Trigger: first locked-down-host user. |
| FR-13 | DEFER | Background-job semantics — `docker rm -f` already kills them on close; timeout interplay is an edge case. Trigger: a real orphaned-child bug report. |
| FR-14 | DEFER | Dropped-channel semantics — the PTY lives in the session; the next tool call just hits it. Trigger: an actual half-state confusion after an MCP client reconnect. |
| FR-20 | DEFER | Max-sessions knob — FR-18's free-RAM floor IS the cap; a number users can tune is a support channel. Trigger: degradation reported at high N on a big host. |
| FR-22 | CUT | Single relay origin — remote/multi-host sharing is a locked non-goal; localhost ports are the product. Resurrect only if local-first itself is re-litigated. |
| FR-26 | CUT | Embedded noVNC iframe — saves one click, costs a frontend. A browser tab is the honest UI. |
| FR-27 | DEFER | Memory-warn column — an OOM early-warning system for a runtime (gvx) that isn't in M-min. Trigger: first Docker host OOM observed. |
| FR-28 | DEFER | Dashboard auth — localhost-only default IS the security story; sharing is documented as unsupported either way. Trigger: first request to share beyond localhost. |
| FR-30 | DEFER | Pinned registry default ref — distribution before users is vanity; the local image works today. Trigger: the first user who isn't the owner. |
| FR-33 | DEFER | Warmup/pre-pull hook — CI-runner convenience with no CI runner. Trigger: Marcus materializes with a self-hosted runner. |
| FR-35 | DEFER | `:gtk`/`:node` variants — each variant is a tag to choose between and an image to build, test, and keep fresh (PRD risk 8); `apt-get` through the shell works. Trigger: a measured apt-get tax slowing a real loop. |
| FR-36 | DEFER | Cosign signing — signing images nobody downloads. Trigger: FR-30 resurrects (registry distribution to non-owner machines). |
| FR-37 | DEFER | Cache-hygiene reporting — a disk-usage dashboard for a cache that has filled nobody's disk. Trigger: first disk-full incident. |
| FR-39 | DEFER | gvx runtime — feasibility proven, users zero; 7-star single-maintainer pre-1.0 upstream, 4.5× memory multiplier (~2 GiB vs ~500 MiB per session). Trigger: a user who cannot run dockerd, or gvx v1.0 API stability. |
| FR-40 | DEFER | Standing parity promise — the 83-ref Docker/gvx parity run is recorded evidence, not a test matrix to maintain. Trigger: gvx ships (then one parity run, not standing CI). |
| FR-45 | DEFER | Workspace bind — `git clone` through the shell works today; the bind is a speed/convenience feature. Trigger: repos/artifacts too big for clone + base64 round-trips. |
| FR-46 | CUT | Artifact convention — the user's CI layout, not the desk's job. micke exports files, not opinions. |

## 3. Locked decisions under the knife

- **L1 (Direction A)** — survives untouched. It IS the yardstick.
- **L2 (R1 dashboard, supervisor-served)** — renegotiated, not revoked: survives as ONE static
  HTML table (FR-23/24/25/29 shrunk), meta-refresh, no JS/iframe/auth/extra columns. Tell the
  owner: L2 stays a sentence, not a frontend. The honest alternative is cutting it entirely —
  `session.list` already returns URLs; the table earns its keep only as the non-MCP human's
  entry point, and ~50 lines of HTML is the maximum that's worth.
- **L3 (R2 manual VNC as designed flow)** — survives, shrunk to documentation (FR-47 shrunk,
  FR-48 kept). The mechanism (bidirectional noVNC, optional `MICKE_VNC_PASSWORD`) is already
  in the image; a "designed flow" is a pause contract and one example prompt, not a subsystem.
- **L4 (four tools, one shell)** — survives untouched. The single most minimalist decision in
  the document; defend it against every future "just one more proxy tool" request.
- **L5 (pull-only)** — split it: "no builds in user flows" survives untouched; "default image
  is a pinned registry ref" should be un-locked until a second user exists. M-min's image
  model is the local tag (FR-34 absorbed into the default). The registry pipeline (M3) is
  distribution vanity pre-users.
- **L6 (Docker primary, gvx optional)** — renegotiated: "optional" demoted from "shipped and
  parity-maintained" to "verified design, deferred backend" (FR-2/9/39/40 deferred). Un-lock
  the standing parity promise. The feasibility study isn't wasted — it's a banked design, not
  a shipping obligation.
- **L7 (supervisor: process per session, owns ports/URL discovery, serves dashboard)** —
  survives as the spine. Port bookkeeping stays and cannot shrink further (every noVNC link
  is born there; the gvx stderr-parse half shrinks away with gvx); "serves dashboard"
  shrinks to serving one static route.

## 4. The minimalist milestone — M-min

Build order (each step depends on the previous):

1. **Supervisor skeleton**: one host process per session, `docker run/rm` wiring, Docker `-p`
   port allocation (FR-15, 38, 16).
2. **The four MCP tools**: create/list/close; noVNC URL in every answer (FR-1, 3, 4, 5, 17).
3. **The shell**: PTY wrap over `docker exec`, auto-source `/tmp/session.env`, framing +
   output cap + per-command timeout (FR-6, 7, 8, 11, 12).
4. **Death hygiene**: teardown on close/restart + leak-cycle test, flock instance lock,
   free-RAM floor, serialized pull-if-missing, structured errors (FR-10, 19, 18, 31/32, 21).
5. **The table**: static HTML at `127.0.0.1:7800`, meta-refresh (FR-23, 24, 25, 29).
6. **The docs**: chromium flags page, R2 pause contract + arbitration hazard + one example
   prompt (FR-42, 47, 48).

Inputs already paid for, zero build cost: FR-41, 43, 44 (in-image, verified end-to-end).

**Hard exit criterion**: on a host with Docker + the local image ONLY (no registry, no gvx),
from a cold MCP client config, an agent completes — using the four tools and nothing else —
create → launch chromium → `snapshot -i` → `click @ref` → `wait --window` → re-snapshot → PNG
out via base64; a human opens the noVNC URL (from `session.list` or the table) in a browser
and types into the live desktop; `session.close`; 20 create/close cycles return fd/process
counts to baseline; boot < 2 s and teardown < 2 s (already met by the measured 0.54 s boot /
~1 s teardown).

**Scope vs M1–M4**: M-min ≈ 55% of M1 (kills the entire second-runtime backend: FR-2/9, the
gvx port parse, and the parity test matrix), ≈ 15% of M2 (a static table vs windows-polling,
iframe, memory graph), kills M3 outright (one serialized pull-if-missing line rides along in
step 4), shrinks M4 to ~20% (one R2 doc page + one example; the copying-ready nightly-suite
example dies with warmup and variants). Net: roughly a third of the PRD's build scope buys
the entire core loop.

## 5. What minimalism breaks (self-audit)

- **Marcus (P2) loses his grid**: no warmup, no memory warnings, no variants, no N-session
  capacity story — scenario B at scale is explicitly not M-min's promise. Reverse
  FR-20/27/33/35 the day a real self-hosted-runner owner shows up.
- **Priya's glance thins**: no windows/memory columns, no iframe — she can see and click, but
  "stuck vs dead" now requires the shell. Restore FR-24's columns when a human intervenes
  more than ~twice a week.
- **First-use gets worse before better**: no registry means every new machine builds the
  image locally (or `docker save | load`). Reverse FR-30 at the SECOND non-owner user —
  not before.
- **Locked-down hosts get nothing**: gvx's whole point (no daemon/root/namespaces) is
  deferred; M-min requires dockerd. Reverse FR-39/2/9/40 on the first can't-run-dockerd
  request or gvx v1.0.
- **Tomasz pays the apt-get tax** per session on the base image until variants exist (the
  scenario study's own risk list) — and GTK/Qt/Tauri a11y stays untested beyond chromium
  either way.
- **R2 remains half agent behavior** (PRD risk 12): one example prompt is a floor, not a
  curriculum; arbitration stays an unsolved hazard in every version, including this one.

## 6. One-paragraph verdict

The PRD's own risk #2 concedes that today micke is a compelling demo, not a tool — and the
demo is already verified end-to-end (0.54 s boot, 83 refs, live noVNC, clean teardown). The
only question worth weeks of plumbing is whether an agent plus a human actually complete the
core loop through four MCP tools — and M-min answers it for roughly a third of the roadmap's
scope: no second runtime, no registry, no frontend, nothing whose failure could teach you
nothing. Every deferred FR carries a named resurrection trigger, so growth becomes
evidence-driven instead of roadmap-driven; if the loop is real, the dashboard, the registry,
and gvx grow back with users attached, and if it isn't, you learn that at the smallest
possible price. Ship the desk, the shell, the link, the teardown. Burn the rest until
someone asks for it by name.
