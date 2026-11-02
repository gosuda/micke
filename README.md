# micke

> micke — a desk for AI agents.

**micke** is a local-first platform that provides a full computer desktop environment for AI agents. It is named after the IKEA desk brand — a simple, sturdy desk on which your agent can work.

When an AI agent creates a new session via MCP (Model Context Protocol), micke provisions a Linux desktop environment inside a container. The agent can then interact with that desktop: move the mouse, type on the keyboard, launch apps, browse the web, and see the screen.

## How it works

```
AI Agent ──MCP──> micke server ──> Linux desktop container
                                        │
                                   X11 / Wayland
                                   noVNC / screenshot streaming
```

1. **Session create** — the agent calls the `session.create` MCP tool.
2. **Container spawn** — micke boots a lightweight Linux desktop (e.g. Xfce) in an isolated container.
3. **Interaction** — the agent controls the desktop through MCP tools (`click`, `type`, `screenshot`, ...) backed by X11/VNC automation.
4. **Session close** — the container is destroyed, leaving nothing behind.

## Goals

- **Local-first**: everything runs on your machine. No cloud, no telemetry.
- **One session, one desk**: each MCP session gets a fresh, disposable desktop container.
- **Agent-friendly**: tools designed for screen understanding and precise input control.
- **Reproducible**: deterministic container images so agents get the same desk every time.

## Quick start

```sh
docker build -t micke .

# boot a desk (--shm-size is for Chromium)
docker run -d --name micke --init --shm-size=1g micke

# talk to the desktop through agent-desktop
docker exec micke bash -c '. /tmp/session.env && agent-desktop status'
docker exec micke bash -c '. /tmp/session.env && agent-desktop list-apps'

# launch and drive a browser
docker exec micke bash -c '. /tmp/session.env && \
    agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility https://example.com && \
    agent-desktop snapshot --app chromium -i'
```

The desktop inside the container is driven by
[agent-desktop](https://github.com/vercel-labs/agent-desktop): it reads and
operates apps through the AT-SPI accessibility tree with stable refs, no
pixel matching.

## View the desktop in a browser (noVNC)

Every micke session mirrors its Xvfb display through **x11vnc** on port
`5900` and serves the **noVNC** web client through websockify on port
`6080`. Publish `6080` and open `http://<host>:6080/vnc.html` to watch (or
drive) the live desktop from any browser — useful for seeing what an agent
is doing.

- **Ports are fixed** (`5900` VNC, `6080` noVNC) and bind all interfaces
  *inside* the sandbox; host exposure is the runtime's job.
- **`MICKE_VNC_PASSWORD`** (optional): if set, x11vnc requires classic VNC
  auth with this password; if unset, it accepts viewers with no password
  (`-nopw`) — safe only when the port mapping already restricts who can
  reach it (e.g. `-p 127.0.0.1:6080:6080`).
- noVNC connects back through `ws://<host>:6080/websockify`; the runtime
  just pipes TCP, so nothing runtime-specific is needed.

Docker:

```sh
docker run -d --name micke --init --shm-size=1g \
    -p 127.0.0.1:6080:6080 micke
# open http://localhost:6080/vnc.html
```

gvx (host port is auto-picked with a bare `-p 6080`; read it from the
`rungv: publishing ...` line on stderr):

```sh
rungv run --pull=never -m 2g -p 6080 micke:dev
# rungv: publishing 127.0.0.1:38271 -> 6080/tcp
# open http://127.0.0.1:38271/vnc.html
```

## Status

Early stage. The project is under active prototyping.

## License

TBD
