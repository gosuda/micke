// mcp — the ENTIRE agent-facing surface: exactly four tools (FR-5).
//
// Uses the SDK's low-level Server API with plain JSON Schema (no zod), so
// @modelcontextprotocol/sdk stays the single dependency.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { MickeError, type Supervisor } from "./supervisor.js";

const CREATE_DESC = [
  "Boot a disposable Linux desktop session (Docker container: Xvfb + openbox + chromium + agent-desktop + noVNC).",
  "Returns session_id and novnc_url — a human can open novnc_url in a local browser to watch or manually drive the live desktop.",
  "After creating, run ALL commands through session_shell on that session_id (shell env already sources /tmp/session.env, so `agent-desktop` works directly).",
].join(" ");

const SHELL_DESC = [
  "Run a bash command in the session's ONE persistent shell: working directory and exported env vars persist across calls.",
  "This is the only way to drive the desktop — e.g. `agent-desktop launch chromium --arg=--no-sandbox --arg=--force-renderer-accessibility --arg=https://example.com`, then `agent-desktop snapshot --app chromium -i --compact`, `agent-desktop click \"@<snapshot>:REF\"`, `agent-desktop wait --window TITLE --app chromium`.",
  "Returns {stdout, stderr, rc, timed_out, truncated, duration_ms}. Commands have no stdin (redirect from /dev/null).",
].join(" ");

const TOOLS = [
  {
    name: "session_create",
    description: CREATE_DESC,
    inputSchema: {
      type: "object" as const,
      properties: {
        image: { type: "string", description: "Docker image (default micke:latest, override with MICKE_IMAGE). Must exist locally or be pullable while no sessions are live." },
        workspace: { type: "string", description: "Optional absolute host directory bind-mounted at /workspace (repo in, artifacts out)." },
        screen: { type: "string", description: 'Xvfb screen size WIDTHxHEIGHTxDEPTH (default "1280x800x24").' },
      },
    },
  },
  {
    name: "session_list",
    description: "List sessions. Every row carries the novnc_url for live viewing. Includes `orphaned` rows (containers from a previous supervisor run; close them with session_close).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "session_close",
    description: "Tear a session down: kills its shell, removes the container (docker rm -f) and all state. Also reaps orphaned sessions.",
    inputSchema: {
      type: "object" as const,
      properties: { session_id: { type: "string", description: "Session id from session_create/session_list." } },
      required: ["session_id"],
    },
  },
  {
    name: "session_shell",
    description: SHELL_DESC,
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session id from session_create." },
        command: { type: "string", description: "Bash command string (may be multi-line)." },
        timeout_ms: { type: "integer", description: "Kill the command (not the shell) after this many ms. Default 120000; 0 disables." },
        max_output_bytes: { type: "integer", description: "Per-stream output cap in bytes (default 262144). Output beyond it is truncated with a `…[truncated N bytes]` marker." },
      },
      required: ["session_id", "command"],
    },
  },
];

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new MickeError("BAD_ARGUMENT", `expected "${name}" to be a string`, undefined);
  return v;
}

function int(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new MickeError("BAD_ARGUMENT", `expected "${name}" to be an integer`, undefined);
  return v;
}

function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result as Record<string, unknown>,
    isError: false,
  };
}

function fail(err: unknown): CallToolResult {
  const e =
    err instanceof MickeError
      ? err
      : new MickeError("INTERNAL", err instanceof Error ? err.message : String(err), undefined);
  return {
    content: [{ type: "text", text: JSON.stringify(e.toJSON(), null, 2) }],
    isError: true,
  };
}

export function registerTools(server: Server, sup: Supervisor): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "session_create":
          return ok(
            await sup.createSession({
              image: args.image !== undefined ? str(args.image, "image") : undefined,
              workspace: args.workspace !== undefined ? str(args.workspace, "workspace") : undefined,
              screen: args.screen !== undefined ? str(args.screen, "screen") : undefined,
            }),
          );
        case "session_list":
          return ok({ sessions: await sup.listSessions() });
        case "session_close":
          return ok(await sup.closeSession(str(args.session_id, "session_id")));
        case "session_shell": {
          const r = await sup.runShell(
            str(args.session_id, "session_id"),
            str(args.command, "command"),
            int(args.timeout_ms, "timeout_ms"),
            int(args.max_output_bytes, "max_output_bytes"),
          );
          return ok({
            session_id: args.session_id,
            stdout: r.stdout,
            stderr: r.stderr,
            rc: r.rc,
            timed_out: r.timedOut,
            truncated: r.truncated,
            duration_ms: r.durationMs,
          });
        }
        default:
          return fail(new MickeError("UNKNOWN_TOOL", `no tool "${name}"`, "The surface is exactly: session_create, session_list, session_close, session_shell."));
      }
    } catch (err) {
      return fail(err);
    }
  });
}
