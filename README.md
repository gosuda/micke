# micke

> micke — a desk for AI agents.

**micke** is a local-first platform that provides a full computer desktop environment for AI agents. It is named after the IKEA desk brand — a simple, sturdy desk on which your agent can work.

When an AI agent creates a new session via MCP (Model Context Protocol), micke provisions a Linux desktop environment inside a gvx sandbox. The agent can then interact with that desktop: move the mouse, type on the keyboard, launch apps, browse the web, and see the screen.

## How it works

```
AI agent ──MCP──> micke daemon ──> gvx sandbox (Xvfb :99 + openbox + AT-SPI
                (4 tools)          + chromium + x11vnc/noVNC), one per session
                                        │
                                        agent-desktop (AT-SPI a11y tree: snapshot →
                                        act on @ref → wait), driven through the
                                        session's ONE persistent shell socket
                                        x11vnc/noVNC mirror of the display for humans
```

1. **Session create** — the agent calls the `session_create` MCP tool.
2. **Sandbox spawn** — micke runs one foreground `rungv run` child: a real Linux desktop (Xvfb + openbox + AT-SPI, chromium preinstalled).
3. **Interaction** — the agent drives everything through `session_shell` (the one persistent shell per session): `agent-desktop` snapshot → act on `@ref` → wait loops, plus any CLI work. gvx has no `exec`, so the guest runs a tiny TCP shell driver at `:7801`; the host connects to it through `rungv -p`.
4. **Session close** — the rungv process tree is killed, leaving nothing behind.

Sessions are **not** owned by the daemon: if micke crashes or restarts, the sandboxes stay alive (desktops, chromium windows, and human noVNC logins included). The next daemon start **adopts** them from their per-session pidfiles and a fresh `session_shell` re-attaches.

## Goals

- **Local-first**: everything runs on your machine. No cloud, no telemetry.
- **One session, one desk**: every `session_create` call gets a fresh, disposable gvx sandbox (MCP transport itself is stateless).
- **Agent-friendly**: tools designed for screen understanding and precise input control.
- **Reproducible**: the same registry image gives agents the same desk every time.
- **One runtime**: gvx (`rungv`), unprivileged and daemonless. Docker is not a runtime dependency.

## Quick start

Requirements: Linux x86_64 or arm64 (the published image is multi-arch: `linux/amd64` + `linux/arm64`) with gvx (`rungv` v0.4.x) on `PATH`, Bun, and the micke image in gvx's cache.

```sh
# 1. get the desktop image (or let the daemon pull it on the first create
#    while no sessions are live)
rungv pull -cache-dir ~/.cache/micke/gvx ghcr.io/gosuda/micke:latest

# 2. start the daemon (MCP at http://127.0.0.1:7800/mcp + dashboard at /)
bun install
bun start
```

Then create a session through any MCP client. Every created session reports a
`novnc_url`; when noVNC is up, open it in a browser to watch (or drive) the
live desktop.

```sh
# maintainer smoke test: boot the image directly, watch the publish lines,
# open the port forwarded for 6080 (the shell listener is 7801)
rungv run -cache-dir ~/.cache/micke/gvx -pull=never -m 2g -p 7801 -p 6080 ghcr.io/gosuda/micke:latest
# rungv: publishing 127.0.0.1:38271 -> 6080/tcp
# open http://127.0.0.1:38271/vnc.html
```

The desktop inside the sandbox is driven by
[agent-desktop](https://github.com/vercel-labs/agent-desktop): it reads and
operates apps through the AT-SPI accessibility tree with stable refs, no
pixel matching.

## View the desktop in a browser (noVNC)

When noVNC is up, each micke session mirrors its Xvfb display through
**x11vnc** on guest port `5900` and serves the **noVNC** web client through
websockify on guest port `6080`. micke publishes `6080` with `rungv -p`
(kernel-picked host port, loopback-only) and puts the URL in `session_create`,
ready rows of `session_list`, and the dashboard. noVNC startup is best-effort:
a session can be `ready` with a `novnc_url` whose viewer is down.

- **Ports are fixed inside the guest** (`5900` VNC, `6080` noVNC); the host
  port is picked by gvx at launch and recorded in the session pidfile, so it
  survives a daemon restart.
- **`MICKE_VNC_PASSWORD`** (optional): if set, x11vnc requires classic VNC
  auth with this password; if unset, it accepts viewers with no password
  (`-nopw`) — safe only because the forward is bound to loopback.
- noVNC connects back through `ws://127.0.0.1:<host-port>/websockify`; gvx
  forwards plain TCP, so nothing runtime-specific is needed.

## Status

Early stage. The runtime is **gvx-only** (owner decision, 2026-11-02): the
Docker runtime path was removed. Docker survives only as the maintainer/CI
image **build** tool and the `docker save` → `rungv load` ingest fallback —
never as a session runtime.

## MCP server (M-min, shipped)

A supervisor + MCP daemon lives in [`src/`](src/) (Bun + TypeScript; MCP over
Streamable HTTP; exactly four tools: `session_create`, `session_list`,
`session_close`, `session_shell` — one persistent shell per session, which is
how agents drive the desktop through `agent-desktop`).

```sh
bun install
bun start   # daemon on http://127.0.0.1:7800/ (MCP + dashboard; MICKE_PORT to change)
```

The daemon must be running before any MCP client connects (it does not
auto-restart — run it under a service manager such as systemd or launchd).
Every created session reports a
`novnc_url` (gvx-picked host port, loopback-only) for live view/intervention,
and the daemon serves a static, no-JS session table at
`http://127.0.0.1:7800/` (auto-refreshing; guards: instance lock, free-RAM
floor, serialized image pulls).
See [docs/server-internals.md](docs/server-internals.md) for configuration,
the shell-channel protocol, adoption semantics, and the integration tests
(`bun test tests/`).

- Driving chromium in a session — required flags, `--arg=` passthrough,
  /dev/shm, and the snapshot → click → verify loop: [docs/chromium-flags.md](docs/chromium-flags.md)
- Pausing so a human can log in over noVNC (the credential goes straight into
  the desktop, not the transcript): [docs/manual-intervention.md](docs/manual-intervention.md)

## Environment

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `MICKE_PORT` | `7800` | Daemon port on 127.0.0.1 — MCP + dashboard (`0` = kernel-picked) |
| `MICKE_IMAGE` | `ghcr.io/gosuda/micke:latest` | Default OCI image for `session_create` |
| `MICKE_GVX_CACHE` | `$XDG_CACHE_HOME/micke/gvx` (`~/.cache/micke/gvx`) | EROFS layer cache (`-cache-dir` on `rungv` image/run calls) |
| `MICKE_RUNGV` | `rungv` | rungv binary path |
| `MICKE_STATE_DIR` | `$XDG_STATE_HOME/micke` (`~/.local/state/micke`) | Pidfiles + logs + instance lock |
| `MICKE_SESSION_MEMORY` | `2g` | Per-sandbox `rungv -m` guard |
| `MICKE_BOOT_TIMEOUT_MS` | `30000` | Wait for the driver's `micke: desktop ready` line |
| `MICKE_MIN_FREE_MB` | `1024` | Free-RAM floor for `session_create` (0 disables) |
| `MICKE_VNC_PASSWORD` | unset | Optional classic-VNC password passed into the sandbox |

## Connecting an MCP client

Any MCP client that speaks Streamable HTTP can use micke. For example, in
OpenCode's config (`opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "micke": {
        "type": "remote",
        "url": "http://127.0.0.1:7800/mcp",
        "oauth": false
      }
    }
  }
}
```

(`oauth: false` matters for OpenCode: remote servers default to OAuth, and
against a no-auth loopback server the probe fails with a misleading
`ECONNREFUSED` instead of just connecting — verified 2026-11-02. micke never
emits 401, so there is nothing to authenticate.)

(The daemon binds loopback only; clients and the daemon must share the host.
Adjust the port if you set `MICKE_PORT`.)

## Building the image (maintainers only)

Users never build images. CI builds and pushes
`ghcr.io/gosuda/micke` on every `image/**` change to `main`
(`.github/workflows/image.yml`) for `linux/amd64` and `linux/arm64` on native
GitHub runners (no QEMU); that is the distribution leg. For local
development, Docker can still be used as the **build tool**:

```sh
docker build -t micke:dev -f image/Dockerfile .
docker save micke:dev -o micke.tar
rungv load -cache-dir ~/.cache/micke/gvx -i micke.tar
```

Docker is not involved in running micke.

## License

TBD
