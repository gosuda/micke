# Chromium under micke — flags, /dev/shm, and the driving loop

How to launch and drive chromium inside a micke session. Everything below was
verified end to end on this image (`micke:latest`, agent-desktop v1.0.2, real
Xvfb): the receipts quoted are from actual runs.

## The easy way: `micke-chromium`

The image ships `/usr/local/bin/micke-chromium`, a wrapper that launches
chromium with both required flags (below) already baked in:

```bash
# verified receipt: ok=true, accessible=true (window.title settles after load;
# step 2's wait is what confirms it)
micke-chromium https://example.com

# extra chromium flags ride along as --arg= passthrough, after the URL
micke-chromium https://example.org --arg=--load-extension=/tmp/testext
```

Prefer the wrapper — nothing to remember, nothing to get wrong (verified
in-session: `ok:true`, `accessible:true`, then `wait --window "Example
Domain"` → `found:true`, snapshot `ref_count=83`). The raw flag form is
documented below (and still works) as history/fallback. One thing to ignore:
the launch receipt carries a `suggestion` to "run close-app and then launch
`--cdp`" for web-content work. Skip it — driving and verifying through the
AT-SPI a11y tree is the whole point of micke (the accessibility commands
still cover everything, as the suggestion itself notes).

## The two required flags

What `micke-chromium` bakes in; the raw form, kept as fallback:

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
# 1. launch (verified receipt: ok=true, accessible=true; title settles after load)
micke-chromium https://example.com
#   raw equivalent: agent-desktop launch chromium --arg=--no-sandbox \
#     --arg=--force-renderer-accessibility --arg=https://example.com

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

# 6. evidence out: `agent-desktop screenshot` prints base64 PNG to stdout
#    (verified: 1280x800 png, 136,940 base64 chars -> 102,705 bytes); give it
#    a PATH and it writes the file instead — with a workspace bind the png
#    lands straight on the HOST (verified: /workspace/screenshot.png showed up
#    in the host-side bind dir), no base64 dance.
agent-desktop screenshot /workspace/evidence.png
```

Habits that keep the loop honest:

- **Assert on receipts, not pixels**: `ok`, `ref_count`, `window.title`,
  `found` from the JSON above — screenshots are evidence, not assertions.
- **Refs are snapshot-scoped**: the `@<snapshot>:<ref>` form only resolves
  against the snapshot it came from; after any action, re-snapshot before the
  next `click`/`type`.
- **Wait, don't sleep**: `wait --window` (and `wait` on refs) is the
  deterministic gate between steps.
- **Refs may be `offscreen` and still work**: snapshot entries can carry
  `states:["offscreen"]` (element outside the current viewport). Verified:
  example.com's "Learn more" link AND its statictext child both carried
  `"states":["offscreen"]`, and click-by-ref still navigated. Don't skip a
  ref over it.
- A human can watch or take over the same desktop at any time via the
  session's noVNC URL — see [manual-intervention.md](manual-intervention.md).

## Dispositions: `delivered` ≠ verified

`click` and `type` receipts carry a `disposition` object describing what
agent-desktop could observe about the **delivery of the input** — never the
effect. Its `delivery` value is one of:

- **`delivered`** — the input reached the element (the AT-SPI action was
  accepted).
- **`delivered_unverified`** — the input was sent, but delivery could not be
  confirmed. Common, and usually fine.
- **`not_delivered`** — the input did not land (dead ref, element gone, wrong
  window). The action failed; re-snapshot and rethink.

Verified receipt from a real click of example.com's "Learn more":

```json
"disposition": { "delivery": "delivered_unverified", "retry": "unsafe" }
```

…with `ok:true` and `steps[0].outcome:"succeeded"` — and the click did
navigate (title "Example Domain - Chromium" → "Example Domains - Chromium",
address bar → iana.org, re-snapshot ref_count 83 → 177).

The right posture for **every** disposition: treat the action as unproven
until the world changed. Gate on `wait --window` for the expected navigation,
confirm with a re-snapshot; the disposition alone is never the assertion.

## Filter big snapshots inside the container

`session_shell` caps each output stream at 256 KiB by default
(`max_output_bytes`), and a compact snapshot is ONE line of JSON —
example.com already serializes to ~14 KB (measured: 14,091 bytes, ref_count
83), and real pages blow past the cap fast. Filter IN the command, so only
the small result crosses the shell boundary (verified in-session):

```bash
# refs + names of every link, one per line
agent-desktop snapshot --app chromium -i --compact \
    | jq -r '.. | objects | select(.role? == "link") | [.ref_id, .name] | @tsv'
# -> @s8rjgz0qjndhv:e65<TAB>Learn more

# quick-and-dirty: grep the compact JSON (469 bytes out for 20 names)
agent-desktop snapshot --app chromium -i --compact | grep -o '"name":"[^"]*"'
```

If you genuinely need the whole tree, raise `max_output_bytes` for that one
call — but a filter is usually what you actually wanted.
