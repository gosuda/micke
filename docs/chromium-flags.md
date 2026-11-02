# Chromium under micke — flags, /dev/shm, and the driving loop

How to launch and drive chromium inside a micke session. Everything below was
verified end to end on this image (`micke:latest`, agent-desktop v1.0.2, real
Xvfb): the receipts quoted are from actual runs.

## The easy way: `micke-chromium`

The image ships `/usr/local/bin/micke-chromium`, a wrapper that launches
chromium with both required flags (below) already baked in:

```bash
# verified receipt: ok=true, window.accessible=true (window.title settles after
# load; step 2's wait is what confirms it)
micke-chromium https://example.com

# extra chromium flags ride along as --arg= passthrough, after the URL
micke-chromium https://example.org --arg=--load-extension=/tmp/testext
```

Prefer the wrapper — nothing to remember, nothing to get wrong (verified
in-session: `ok:true`, `window.accessible:true`, then `wait --window "Example
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
  sandbox (no user namespaces / SUID helpers). Without it chromium exits
  immediately. The gvx sandbox is the security boundary; the browser sandbox
  inside it is redundant.
- **`--force-renderer-accessibility`** — forces chromium to expose its
  accessibility tree even though there is no assistive-tech client. Without
  it, `snapshot` sees an empty/near-empty tree and there are no `@ref`s to
  click. This flag is what makes the whole snapshot → act-on-ref loop work.

`ACCESSIBILITY_ENABLED=1` is already baked into the image, and the session
shell auto-sources `/tmp/session.env` (DISPLAY, the D-Bus session bus — AT-SPI
is discovered through it), so `agent-desktop status` reports accessibility
**granted** with no manual setup. Verified:
`status.data.permissions.accessibility.state == "granted"`.

## `--arg=` passthrough

Every `--arg=VALUE` is passed through to chromium verbatim. Verified examples:

```bash
# custom URL (verified: window title "Example Domain - Chromium")
agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility --arg=https://example.com

# load an unpacked extension (verified: relaunch ok with a v3 manifest at /tmp/testext)
agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility \
    --arg=--load-extension=/tmp/testext --arg=https://example.org
```

Note: `launch` attaches to (or forwards arguments to) an already-running
chromium by default, so a new `--arg` set may not be applied. If one is
already running, close it first (`agent-desktop close-app chromium`), then
launch again.

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

## /dev/shm

Chromium uses `/dev/shm` for shared memory; too small a tmpfs makes tabs
crash with "Aw, Snap" once a page is heavy. Under gvx, `/dev/shm` is sized to
half of host RAM by default — comfortably above the old 1 GB Docker flag — and
`rungv` refuses explicit tmpfs mounts at/below `/dev`, so micke adds no flag.
You don't need to do anything for `session_create`.

The per-sandbox memory guard is `rungv -m` (default `2g`, override with
`MICKE_SESSION_MEMORY`); it is a polling guard, not a cgroup limit. If you
drive the image manually, keep the guard:

```sh
rungv run -cache-dir ~/.cache/micke/gvx -pull=never -m 2g -p 7801 -p 6080 ghcr.io/gosuda/micke:latest
```

## The driving loop (cheatsheet)

One full verified loop over `https://example.com` — launch → wait for a window
→ snapshot → click a `@ref` → re-snapshot. All of it goes through the ONE
persistent shell (`session_shell`), where the env is already sourced.

```bash
# 1. launch (verified receipt: ok=true, window.accessible=true; title settles
#    after load)
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

# 5. verify from receipts, not pixels (verified after the click: new
#    snapshot_id, ref_count 177; wait --window "Example Domains" -> found=true)
micke-state   # {"alive":true,"title":"Example Domains","url":"iana.org","refs":177}
agent-desktop wait --window "Example Domains" --app chromium --timeout 15000
agent-desktop snapshot --app chromium -i --compact
```

There is deliberately no screenshot step: see "Screenshots: only when a human
consumes them" below.

Habits that keep the loop honest:

- **Assert on receipts, not pixels**: `ok`, `ref_count`, `window.title`,
  `found` from the JSON above — screenshots are evidence, not assertions.
  `micke-state` packages the three cheap ones (`alive`, `title`, `url`,
  `refs`) into ONE line of JSON, about two seconds, writing no files; use it
  for "is the browser alive" and "did the click land".
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
- A human can watch the same desktop, or take over while the agent is paused,
  via the session's noVNC URL — see
  [manual-intervention.md](manual-intervention.md).

## Screenshots: only when a human consumes them

Ask first: **who reads this PNG?** If the answer is "me, to check the click
worked", don't take it. `screenshot` succeeds even when the click did nothing,
nothing in the agent loop consumes the file, and a 100 KB image says less than
one line of state. Take a screenshot only when a human needs to see the
pixels: they asked for one, you are reporting a visual defect (layout, color,
a font rendering as tofu), or the answer exists only in the image.

Verify actions without pixels instead:

| question | assertion |
| :-- | :-- |
| is chromium alive? | `micke-state` → `alive:true` (exit 0) |
| did the click navigate? | `micke-state` → changed `title`/`url`; `wait --window` → `found:true` |
| did the page change? | `micke-state` → `refs` moved, or a fresh `snapshot` has a new `snapshot_id`/`ref_count` |
| is the element there? | `snapshot` / `find` → the `@ref` exists |

```bash
micke-state   # {"alive":true,"title":"Npay 증권","url":"stock.naver.com","refs":547}
```

When a human does need the file, write it to `/workspace` so it lands on the
host (see "Workspaces are always mounted"):

```bash
agent-desktop screenshot /workspace/evidence.png   # host: <workspace>/evidence.png
```

Screenshots are evidence, not assertions — keep any assertion in the receipt,
not in the image.

## Dispositions: delivery ≠ outcome

`click` and `type` receipts carry a `disposition` object describing what
agent-desktop could observe about the **delivery of the input** — never the
app-level effect. Its `delivery` value is one of:

- **`delivered_verified`** — the adapter observed the postcondition it names.
  That readback still proves only the element, not that the application
  committed the change.
- **`delivered_unverified`** — the input was dispatched, but no postcondition
  could confirm it. Common, and usually fine.
- **`delivery_uncertain`** — delivery could not be determined (for example,
  the app stopped responding); treat it as possibly landed.
- **`not_delivered`** — the input did not land (dead ref, element gone, wrong
  window). The action failed; re-snapshot and rethink.
- **`unknown`** — the command established nothing about delivery.

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

## Filter big snapshots inside the sandbox

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

## Content vs. interaction: `micke-page-text`

The AT-SPI tree is the **interaction** path (snapshot → act on `@ref`). It is
not a content extractor: on a real news page, `agent-desktop find --role link`
returns `TIMEOUT / locator_incomplete` because the traversal budget runs out
before the tree does. If you only need to *read* a page, do not snapshot it.

```bash
# one small JSON object: {url,title,text,chars,truncated}
micke-page-text https://example.com | jq -r .text

# headlines/links: [{text,href}, ...]
micke-page-text https://news.google.com --links | jq -r '.links[].text'

# cap the payload for a chatty page
micke-page-text https://example.com --max-chars 5000 --pretty
```

How it works: headless chromium renders the URL in a throwaway
`--user-data-dir` (so it never attaches to the GUI chromium on `:99`), and
`image/page_text.py` (stdlib python3) extracts title, block-ordered text, and
links. The multi-megabyte DOM never crosses the `session_shell` output cap —
only the extracted JSON does.

Use both paths together: `micke-page-text` to find *what* is on the page,
a11y `snapshot`/`click` to *act* on it.

## Exit codes: `ok:false` is a failure

`agent-desktop` reports application-level failures inside a successful process:

```json
{"version":"2.5","ok":false,"error":{"code":"TIMEOUT", ...}}   # used to be rc 0
```

The image ships `/usr/local/bin/agent-desktop`, a shim over the npm-installed
CLI (`/opt/agent-desktop/bin/agent-desktop`) that exits 1 whenever the JSON
envelope says `ok:false`. Stdout is byte-identical, so `| jq` pipelines are
unaffected; process-level non-zero codes and non-JSON output pass through
untouched. Consequence: `set -e`, `&&`, and `if agent-desktop ...` are now
trustworthy — but read the envelope for the error code, since exit 1 alone
does not say *which* failure.

## Workspaces are always mounted

`session_create` without `workspace` still gets a host directory: micke creates
one under `<MICKE_STATE_DIR>/workspaces/<session_id>`, `chmod 0777`s it (the
documented exception — see below), and reports it as `workspace` in the
receipt. Everything written to `/workspace` in the guest lands there on the
host, so screenshots and dumps need no base64 round-trip:

```bash
agent-desktop screenshot /workspace/evidence.png   # host: <workspace>/evidence.png
```

**Explicit workspaces are checked, not rewritten.** gvx/rungv bind-mounts the
host directory with no uid mapping: the guest writes as uid 1000 while the
directory is owned by the host user. A default `0755` directory is readable
but **not writable** in the guest, so micke rejects it up front:

```
{"code":"WORKSPACE_NOT_WRITABLE",
 "message":"workspace \"…\" is not writable by the guest (uid 1000, gid 1000); …",
 "hint":"Run `chmod -R a+w …` (or pass a directory the guest can write). …"}
```

Fix it with exactly that `chmod -R a+w <path>` (or pass a directory the guest
can write). micke never widens permissions on a directory it did not create.
`MICKE_GUEST_UID`/`MICKE_GUEST_GID` (default `1000:1000`) change the identity
used for the check if you run a custom image.

Workspace files are kept after `session_close` (they are the evidence trail);
delete the directory when you no longer need it.
