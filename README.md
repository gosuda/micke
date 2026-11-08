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

Requirements: Linux/macOS/Windows on x86_64 or arm64, Bun. That's all —
`rungv` (gvx) is optional: when none is installed (no `MICKE_RUNGV`, nothing
on PATH), the first `session_create` downloads the pinned gvx release into
`~/.cache/micke/bin/rungv-<tag>/` and uses it (see below).

```sh
bun install
bun start   # daemon on http://127.0.0.1:7800/ (MCP + dashboard; no auto-restart)
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

## Building the image (maintainers)

CI builds and pushes `ghcr.io/gosuda/micke` on every `image/**` change to
`main`. Local fallback (Docker is a build tool only, never a runtime):

```sh
docker build -t micke:dev -f image/Dockerfile .
docker save micke:dev -o micke.tar
rungv load -cache-dir ~/.cache/micke/gvx -i micke.tar
```

## License

TBD
