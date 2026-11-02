# Chromium under micke

For humans maintaining or debugging the chromium setup. Agents do not need
this file: the driving loop (snapshot → click on `@ref` → verify with
`micke-state`) ships in the `session_shell` tool description at runtime.

## Launch

Prefer the wrapper — both required flags pre-baked:

```bash
micke-chromium https://example.com   # extra chromium flags: --arg=--flag, after the URL
```

Raw form (what the wrapper bakes in):

```
agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility
```

- `--no-sandbox` — chromium's sandbox cannot start under gVisor (no user
  namespaces / SUID helpers); the gvx sandbox is the security boundary.
- `--force-renderer-accessibility` — exposes the a11y tree even with no
  assistive-tech client; without it snapshots carry no `@ref`s to click.

`launch` attaches to an already-running chromium: to apply a new flag set,
`agent-desktop close-app chromium` first, then launch again.

## Real Xvfb, not headless

The desktop is a real X server (Xvfb + openbox, mirrored over VNC). There is
no `--headless` anywhere: it hides extensions, WebGL, font rendering and
native dialogs, and its a11y tree is not the real widget tree. Screen size is
set at `session_create` (`screen`), not with chromium flags.

## /dev/shm

gvx sizes `/dev/shm` to half of host RAM and refuses explicit tmpfs mounts at
`/dev`, so micke adds no flag. The per-sandbox guard is `rungv -m`
(`MICKE_SESSION_MEMORY`, default `2g`).

## Measured gotchas (2026-11, agent-desktop v1.0.2)

- `agent-desktop press` SIGSEGVs chromium here (25/29 combos, rc 139, receipt
  still `ok:true` / `delivered_unverified`). Use `micke-key <combo>` (xdotool)
  — it proves delivery, not effect; verify with `micke-state`. `click`/`type`
  are unaffected.
- A dead browser is silent: `list-apps`, `list-windows`, `screenshot` and
  `session_list` all keep answering `ok` on a dead desktop. `micke-state`
  (exit 1) is the honest probe.
- `agent-desktop find` on heavy pages (naver.com) spends ~80% of its budget
  waiting for tree stability and returns `TIMEOUT` while admitting
  `observed_matches: 1..3`; `--first` succeeds but latency tracks the budget.
  Use ONE filtered snapshot instead (`micke-find`).
- A snapshot receipt saying `truncated:true` → retry once at
  `--timeout-ms 10000`, then 20000 (`micke-find` does this); never retry a
  complete tree.
- Refs are snapshot-scoped (`@<snapshot>:<ref>` resolves only against the
  snapshot it came from): re-snapshot after any action. `offscreen` refs
  (~31% on naver.com) still click fine — do not filter them out.
- A compact snapshot is one huge JSON line: filter inside the guest
  (`| jq -r '.. | objects | select(.role?=="link") | [.ref_id,.name] | @tsv'`)
  so only the small result crosses the 256 KiB `session_shell` output cap.
- Action receipts' `disposition` describes input **delivery**, never the
  app-level effect — treat every action as unproven until `wait --window`,
  `micke-state` or a re-snapshot shows the world changed.
- The image shims `agent-desktop` to exit 1 whenever the JSON envelope says
  `ok:false`, so `set -e` / `&&` are trustworthy; read the envelope for the
  error code.
- `micke-chromium` adds `--enable-logging --log-file=/tmp/chromium.log`; that
  file survives the crash-detach and is the only post-mortem (crashpad cannot
  dump under gVisor, and a crash stays visible on purpose — no supervision).
- For page **content** use `micke-page-text <url> [--links] [--max-chars N]`
  (headless, throwaway profile): the a11y tree is the interaction path, not a
  reader.
