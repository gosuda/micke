# Chromium under micke — flags, /dev/shm, and the driving loop

How to launch and drive chromium inside a micke session. Everything below was
verified end to end on this image (`micke:latest`, agent-desktop v1.0.2, real
Xvfb): the receipts quoted are from actual runs.

## The two required flags

```
agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility
```

- **`--no-sandbox`** — chromium's sandbox cannot start inside the micke
  container (no user namespaces / SUID helpers). Without it chromium exits
  immediately. The container is the security boundary; the browser sandbox
  inside it is redundant.
- **`--force-renderer-accessibility`** — forces chromium to expose its
  accessibility tree even though there is no assistive-tech client. Without
  it, `snapshot` sees an empty/near-empty tree and there are no `@ref`s to
  click. This flag is what makes the whole snapshot → act-on-ref loop work.

`ACCESSIBILITY_ENABLED=1` is already baked into the image, and the session
shell auto-sources `/tmp/session.env` (DISPLAY, D-Bus, AT-SPI bus addresses),
so `agent-desktop status` reports accessibility **granted** with no manual
setup. Verified: `status.data.permissions.accessibility.state == "granted"`.

## `--arg=` passthrough

Every `--arg=VALUE` is passed through to chromium verbatim. Verified examples:

```bash
# custom URL (verified: window title "Example Domain - Chromium")
agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility --arg=https://example.com

# load an unpacked extension (verified: relaunch ok with a v3 manifest at /tmp/testext)
agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility \
    --arg=--load-extension=/tmp/testext --arg=https://example.org
```

Note: `launch` expects a fresh chromium. If one is already running, close it
first (`agent-desktop close-app chromium`), then launch again.

## Real Xvfb, not headless

micke runs a **real X server** (Xvfb, 1280x800x24 by default; override at
`session_create` with `screen`) plus openbox, and mirrors it over VNC. There
is no `--headless` anywhere, on purpose:

- headless chromium hides extensions, WebGL, font rendering and native
  dialogs — the things micke exists to test;
- AT-SPI accessibility works against the real widget tree; snapshots of a
  headless browser are not the same tree.

If a test wants a different screen size, set it at create time — don't reach
for chromium flags.

## /dev/shm: `--shm-size=1g`

Chromium uses `/dev/shm` for shared memory; Docker's default 64 MB makes tabs
crash with "Aw, Snap" once a page is heavy. The supervisor runs every session
with `--shm-size=1g` (already the case for `session_create` — you don't need
to do anything). If you drive the image manually, keep the flag:

```sh
docker run -d --init --shm-size=1g ... micke:latest
```

## The driving loop (cheatsheet)

One full verified loop over `https://example.com` — launch → wait for a window
→ snapshot → click a `@ref` → re-snapshot → screenshot. All of it goes through
the ONE persistent shell (`session_shell`), where the env is already sourced.

```bash
# 1. launch (verified receipt: ok=true, window.title "Example Domain - Chromium", accessible=true)
agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility --arg=https://example.com

# 2. wait for the window (verified: data.found=true, elapsed_ms=11)
agent-desktop wait --window "Example Domain" --app chromium --timeout 20000

# 3. snapshot, interactive elements only, compact (verified: data.ref_count=83, snapshot_id=s26re9dx64r3s5)
agent-desktop snapshot --app chromium -i --compact

#    ...find the element you want in data.tree, e.g. role=link name="Learn more"
#    at ref_id @s26re9dx64r3s5:e65 ...

# 4. act on the ref — the ref embeds the snapshot id (verified: ok=true)
agent-desktop click "@s26re9dx64r3s5:e65"

# 5. re-snapshot and/or wait to verify the effect (verified after the click:
#    new snapshot_id, ref_count 177; wait --window "Example Domains" -> found=true)
agent-desktop snapshot --app chromium -i --compact
agent-desktop wait --window "Example Domains" --app chromium --timeout 15000

# 6. evidence out: screenshot comes back as base64 PNG
#    (verified: 1280x800 png, 136,940 base64 chars -> 102,705 bytes)
agent-desktop screenshot
```

Habits that keep the loop honest:

- **Assert on receipts, not pixels**: `ok`, `ref_count`, `window.title`,
  `found` from the JSON above — screenshots are evidence, not assertions.
- **Refs are snapshot-scoped**: the `@<snapshot>:<ref>` form only resolves
  against the snapshot it came from; after any action, re-snapshot before the
  next `click`/`type`.
- **Wait, don't sleep**: `wait --window` (and `wait` on refs) is the
  deterministic gate between steps.
- A human can watch or take over the same desktop at any time via the
  session's noVNC URL — see [manual-intervention.md](manual-intervention.md).
