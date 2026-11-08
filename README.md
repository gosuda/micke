# micke

> micke — a desk for AI agents.

micke gives AI agents a disposable Linux desktop (Xvfb + openbox + AT-SPI +
chromium, mirrored over noVNC) inside a gvx sandbox, driven over MCP. One
`session_create` = one fresh sandbox; the agent works through `session_shell`
(`agent-desktop` snapshot → act on `@ref` → wait). Sessions survive daemon
restarts — the next daemon adopts them from per-session pidfiles.

## Quick start

Requirements: Linux x86_64 or arm64, `rungv` (gvx) on PATH, Bun.

```sh
rungv pull -cache-dir ~/.cache/micke/gvx ghcr.io/gosuda/micke:latest
bun install
bun start   # daemon on http://127.0.0.1:7800/ (MCP + dashboard; no auto-restart)
```

Connect any Streamable-HTTP MCP client to `http://127.0.0.1:7800/mcp`. The
surface is exactly four tools — `session_create`, `session_list`,
`session_close`, `session_shell` — driving a stock guest: Debian + chromium +
pinned `agent-desktop@1.2.0` (`agent-desktop --help` is the manual; the
sanctioned URL route is `agent-desktop launch chromium --arg=<url>`). OpenCode
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

## Environment

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `MICKE_PORT` | `7800` | Daemon port on 127.0.0.1 — MCP + dashboard (`0` = kernel-picked) |
| `MICKE_IMAGE` | `ghcr.io/gosuda/micke:latest` | Default OCI image for `session_create` |
| `MICKE_GVX_CACHE` | `$XDG_CACHE_HOME/micke/gvx` (`~/.cache/micke/gvx`) | EROFS layer cache (`-cache-dir` on `rungv` image/run calls) |
| `MICKE_RUNGV` | `rungv` | rungv binary path |
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
[docs/chromium-flags.md](docs/chromium-flags.md) (chromium flags + gotchas),
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
