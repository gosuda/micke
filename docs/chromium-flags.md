# Chromium under micke

For humans maintaining or debugging the chromium setup. Agents do not need
this file: the guest is stock — Debian + chromium + pinned `agent-browser` +
`agent-desktop` — and `--help` is the manual for both CLIs.

## Flags are baked at image level

`image/chromium-flags.sh` lands in the image as `/etc/chromium.d/00-micke.sh`.
Stock Debian ships `/usr/bin/chromium` as a shell wrapper that sources every
`/etc/chromium.d/*` fragment into `CHROMIUM_FLAGS` before exec'ing the real
binary, so the flags apply to every launch route:

- `agent-browser` (the web path) — it execs that same wrapper (the image bakes
  `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`), so the flags ride along;
  agent-browser also appends `--no-sandbox` itself when `/.dockerenv` exists
  (always true under gvx) — belt and suspenders on top of the fragment
- `agent-desktop launch chromium --arg=<url>` — the desktop-side URL route;
  `launch` resolves the desktop file's `Exec=` program (the wrapper) over PATH
- the desktop menu entry
- a bare `chromium <url>` from a shell

The two flags and why:

- `--no-sandbox` — chromium's own sandbox cannot start under gVisor (no user
  namespaces / SUID helpers); launched raw it exits immediately. The gvx
  sandbox is the security boundary.
- `--force-renderer-accessibility` — exposes the a11y tree even with no
  assistive-tech client; without it snapshots carry no `@ref`s to click.

`launch` attaches to an already-running chromium, and the flags live in the
wrapper the browser starts from — nothing to pass (or forget) per launch.

## Real Xvfb for agent-desktop; headless for agent-browser

The desktop is a real X server (Xvfb + a minimal XFCE session, mirrored over
VNC), and the agent-desktop side never passes `--headless`: it hides
extensions, WebGL, font rendering and native dialogs, and its a11y tree is
not the real widget tree. Screen size is
set at `session_create` (`screen`), not with chromium flags. agent-browser is
the deliberate exception: it drives its own headless chromium instance over
CDP — no a11y tree involved, no DISPLAY needed — and leaves the VNC desktop
undisturbed (its chromium is therefore never visible over noVNC; see
docs/manual-intervention.md).

## /dev/shm

gvx sizes `/dev/shm` to half of host RAM and refuses explicit tmpfs mounts at
`/dev`, so micke adds no flag. The per-sandbox guard is `rungv -m`
(`MICKE_SESSION_MEMORY`, default `2g`).

## Measured stock behaviors (2026-11, agent-desktop v1.2.0)

Upstream facts of stock agent-desktop + stock chromium under gVisor — not
micke defects, and micke ships no workarounds for them. Recorded so
maintainers recognize them on sight:

- `agent-desktop press` into chromium can SIGSEGV the browser (upstream issue
  #529, open: XTEST key synthesis plus a11y traffic while the omnibox is
  being edited). There is no supervision — a crashed chromium stays down
  until relaunched.
- Headless `type` / `set-value` refusals (`ACTION_NOT_SUPPORTED` /
  `POLICY_DENIED`) are by-design fail-closed in agent-desktop; `--headed
  type` is the sanctioned path for web inputs (upstream's own container smoke
  test uses it).
- `find` on very heavy pages (naver.com) spends its whole budget waiting for
  tree stability; 1.2.0 at least preserves partial results on timeout.
- agent-desktop reports app-level failures inside an `ok:false` JSON envelope
  with exit code 0 — stock behavior; agents read the envelope, not the exit
  code.
