# micke

> micke — a desk for AI agents.

micke gives AI agents a disposable Linux desktop (Xvfb + a minimal XFCE
session + AT-SPI + chromium, mirrored over noVNC) inside a gvx sandbox, driven
over MCP. One
`session_create` = one fresh sandbox; the agent works through `session_shell`
— `agent-browser` for web pages, `agent-desktop` for other desktop apps
(snapshot → act on `@ref` → wait). Sessions survive daemon
restarts — the next daemon adopts them from per-session pidfiles.

## Quick start

One command, nothing pre-installed — no Bun, no rungv (gvx): the first
`session_create` self-provisions rungv (see below). Linux (x86_64/arm64)
or macOS (Apple Silicon only — gvx publishes no darwin-amd64, so micke
doesn't either):

```sh
curl -fsSL https://raw.githubusercontent.com/gosuda/micke/main/install.sh | sh
# pin a tag instead of latest:
curl -fsSL https://raw.githubusercontent.com/gosuda/micke/main/install.sh | sh -s -- v0.2.0
```

Windows (PowerShell 5.1+, amd64/arm64):

```powershell
irm https://raw.githubusercontent.com/gosuda/micke/main/install.ps1 | iex
# pinned: download once, then run it with the tag
irm https://raw.githubusercontent.com/gosuda/micke/main/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v0.2.0
```

The script resolves the latest release via the `/releases/latest` redirect
(or takes the pinned tag), downloads the raw single-file binary for the
platform, verifies it against the release `SHA256SUMS`, installs it as
`micke` in `~/.local/bin` (`MICKE_BIN_DIR` to change; Windows:
`%LOCALAPPDATA%\micke\micke.exe` plus the user PATH), then runs
`micke service install` + `service status` and prints the dashboard URL
`http://127.0.0.1:7800/` (`MICKE_PORT` to change).

From source (the dev path — this is the one that needs Bun):

```sh
bun install
bun start   # foreground daemon on http://127.0.0.1:7800/ (MCP + dashboard; no auto-restart)
```

Prefer to install gvx yourself (air-gapped hosts, or a build you control)?
Grab an archive from [github.com/gfire-sigs/gvx/releases](https://github.com/gfire-sigs/gvx/releases)
and put `rungv` on PATH — an explicit installation always wins over the
download. Pre-pulling the image also stays manual-first:

```sh
rungv pull -cache-dir ~/.cache/micke/gvx ghcr.io/gosuda/micke:latest
```

Connect any Streamable-HTTP MCP client to `http://127.0.0.1:7800/mcp`. The
surface is exactly four tools — `session_create`, `session_list`,
`session_close`, `session_shell` — driving a stock guest: Debian + chromium +
pinned `agent-browser@0.41.2` + `agent-desktop@1.2.0` (web/Chromium work
through `agent-browser`, other desktop apps through `agent-desktop`; `--help`
is the manual for both). OpenCode
example (`oauth: false` matters for the no-auth loopback server):

```json
{
  "mcp": {
    "servers": {
      "micke": { "type": "remote", "url": "http://127.0.0.1:7800/mcp", "oauth": false }
    }
  }
}
```

Every session reports a `novnc_url` for live view or takeover. A host
workspace is always mounted at `/workspace`; explicit paths must be
guest-writable (uid 1000) or `session_create` fails fast with
`WORKSPACE_NOT_WRITABLE` and the chmod remedy. Every MCP tool call appends one
line to `<MICKE_STATE_DIR>/audit.log` (tool, session, command, duration,
outcome — never output bodies).

### rungv self-provisioning

When no rungv exists on the host, the first `session_create` downloads the
pinned gvx release (macOS/darwin-arm64, Windows amd64/arm64 `.zip`, Linux
amd64/arm64 `.tar.gz`; darwin-amd64 has no published archive), verifies the
archive against the release `SHA256SUMS`, extracts just the binary and
installs it under `~/.cache/micke/bin/rungv-<tag>/`. Notes:

- **Pinned, never `latest`** — gvx cuts several releases a day and its
  on-disk formats (EROFS layers, `.gvx_meta`) have broken across tags before;
  `MICKE_RUNGV_VERSION` overrides the pin for testing a specific tag.
- **Explicit installs win** — `MICKE_RUNGV` or a PATH `rungv` is never
  overridden; if that binary is broken, micke reports `RUNGV_UNAVAILABLE`
  instead of downloading behind your back.
- **Trust boundary** — the checksum travels with the release (same origin),
  so it guards against corruption, not a compromised publisher. Strict
  environments install rungv themselves or set
  `MICKE_RUNGV_AUTO_DOWNLOAD=0`.

The same port also serves the micke dashboard: open `http://127.0.0.1:7800/`
in a browser to create and delete sessions, view a screenshot of a live
desktop, or open a session's noVNC in-page (or in a new tab) — all on the
loopback origin. The dashboard is a single-file SPA over a small JSON API
under `/api/*` on the same port (curl works too); web actions are audited as
`web.*` lines in the same audit log.

## Background service

`micke service install` registers the daemon with the OS-native per-user
service manager — no sudo anywhere; the daemon binds loopback only and gvx
needs no root — and starts it now AND at login/boot. Crash-restart stays
the manager's job, not micke's own: a systemd `--user` unit
(`Restart=on-failure`, plus best-effort `loginctl enable-linger` so micke
runs at boot, not just in a login session; the unit bakes a login-like
PATH so a hand-installed rungv in `/usr/local/bin` or `~/.local/bin`
stays visible), a launchd agent `dev.gosuda.micke` (`KeepAlive`; log at
`$MICKE_STATE_DIR/daemon.log`), or a Windows ONLOGON scheduled task
`micke`. `service uninstall` / `status` / `restart` manage it, and
`micke help` lists every command. Registration needs the compiled
binary — a bun dev tree is refused with the remedy (from source,
`bun start` is the daemon).

## Upgrades

Re-running the installer over an existing install replaces the binary and
bounces the service — that IS the upgrade path. From an installed micke
there is also:

```sh
micke upgrade             # latest release
micke upgrade v0.2.0      # a tag pins one; same-tag reinstall is the repair path
```

The download is sha256-verified against the release `SHA256SUMS` and
swapped in atomically; a registered service is bounced (sandboxes keep
running — the new daemon adopts them), otherwise the one-line result says
to start with `micke service install`. On Windows the old binary steps
aside as `micke.old.exe` — safe to delete. Same trust model as the rungv
download above.

## Environment

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `MICKE_PORT` | `7800` | Daemon port on 127.0.0.1 — MCP + dashboard (`0` = kernel-picked) |
| `MICKE_IMAGE` | `ghcr.io/gosuda/micke:latest` | Default OCI image for `session_create` |
| `MICKE_GVX_CACHE` | `$XDG_CACHE_HOME/micke/gvx` (`~/.cache/micke/gvx`) | EROFS layer cache (`-cache-dir` on `rungv` image/run calls) |
| `MICKE_RUNGV` | `rungv` | rungv binary path — an explicit path (or a PATH install) always wins over the auto-download |
| `MICKE_RUNGV_VERSION` | `v0.10.10032026110200` | gvx release tag the auto-download installs (pinned in `src/gvxio.ts`; never "latest") |
| `MICKE_RUNGV_DIR` | `$XDG_CACHE_HOME/micke/bin` (`~/.cache/micke/bin`) | Where the downloaded rungv lives (`rungv-<tag>/<binary>`) |
| `MICKE_RUNGV_RELEASE_BASE` | `https://github.com/gfire-sigs/gvx/releases` | Base URL for the release download (`/download/<tag>/<file>`) |
| `MICKE_RUNGV_AUTO_DOWNLOAD` | `1` | `0` disables self-provisioning: a missing rungv is then a plain `RUNGV_UNAVAILABLE` |
| `MICKE_REPO` | `gosuda/micke` | GitHub repo the installers install from (`-Repo` param on Windows) |
| `MICKE_RELEASE_BASE` | `https://github.com/$MICKE_REPO/releases` | Releases base URL for the installers AND `micke upgrade` (mirrors, air-gapped hosts) |
| `MICKE_BIN_DIR` | `~/.local/bin` | Where install.sh installs the binary |
| `MICKE_VERSION` | `latest` | Tag install.sh installs; a positional `sh -s -- <tag>` wins (ps1: `-Version`) |
| `MICKE_STATE_DIR` | `$XDG_STATE_HOME/micke` (`~/.local/state/micke`) | Pidfiles + logs + workspaces + instance lock |
| `MICKE_SESSION_MEMORY` | `2g` | Per-sandbox `rungv -m` guard |
| `MICKE_BOOT_TIMEOUT_MS` | `30000` | Wait for the driver's `micke: desktop ready` line |
| `MICKE_MIN_FREE_MB` | `1024` | Free-RAM floor for `session_create` (0 disables) |
| `MICKE_GUEST_UID` | `1000` | Guest uid used for the `/workspace` writability check |
| `MICKE_GUEST_GID` | `1000` | Guest gid used for the `/workspace` writability check |
| `MICKE_VNC_PASSWORD` | unset | Optional classic-VNC password passed into the sandbox |

## Testing

```sh
bun test tests/                 # fast tier: fake guest + fake rungv (<10 s)
MICKE_E2E=1 bun test tests/     # E2E tier: real image
```

Rules live in [AGENTS.md](AGENTS.md). Further docs:
[docs/manual-intervention.md](docs/manual-intervention.md) (human login over noVNC).

## Releasing (maintainers)

The front door is one command — it releases a git hash end to end:

```sh
bun run release [<hash>] [<tag>]   # --dry-run prints the plan; --skip-tests skips the gate
```

The hash defaults to HEAD and must already be on origin/main (the script
never pushes main). The tag, when not given, is derived from the
conventional-commit subjects since the nearest `v*` tag: any
`feat!`/`fix!`/`perf!`/`refactor!` subject → major, `feat` → minor, else
patch — and the first release ever seeds package.json's version. The bump
follows commit subjects alone; the convention behind them (which types
bump, where the `!` goes) is in [AGENTS.md](AGENTS.md). The
script reruns the fast test tier in a detached worktree at the exact
hash, pushes the annotated tag, and watches the CI run through to the
release URL.

Underneath, the primitive is unchanged — a pushed `v*` tag: manual
`git tag -a vX.Y.Z -m "micke vX.Y.Z" <sha>` + `git push origin
refs/tags/vX.Y.Z` does the same thing. CI runs the fast test tier,
cross-compiles the five release assets + `SHA256SUMS` (linux
amd64/arm64, darwin arm64, windows amd64/arm64) and publishes the
GitHub release. Asset names are the updater's contract — its home is
`scripts/build.ts`, which fails the build on drift.
Local: `bun run build` (dev-labeled binaries in `dist/`).

## Building the image (maintainers)

CI builds and pushes `ghcr.io/gosuda/micke` on every `image/**` change to
`main`. Local fallback (Docker is a build tool only, never a runtime):

```sh
docker build -t micke:dev -f image/Dockerfile .
docker save micke:dev -o micke.tar
rungv load -cache-dir ~/.cache/micke/gvx -i micke.tar
```
