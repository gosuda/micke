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

## Status

Early stage. The project is under active prototyping.

## License

TBD
