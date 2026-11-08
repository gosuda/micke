// mcp — the ENTIRE agent-facing surface: exactly four tools.
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
import { auditToolCall, flatCmd } from "./audit.js";
import { defaultStateDir } from "./gvxio.js";

const CREATE_DESC = [
  "Boot a disposable Linux desktop (gvx sandbox: Xvfb + chromium + agent-desktop + noVNC) and return its session_id and novnc_url.",
  "Open novnc_url in a browser to watch or take over the desktop.",
].join(" ");

const SHELL_DESC = [
  "Run bash in the session. EVERY call is a fresh bash: cwd and exported env do NOT persist between calls, so make each command self-contained.",
  "Drive desktop apps with `agent-desktop` (`agent-desktop --help` is the manual).",
  "Returns {stdout, stderr, rc, timed_out, truncated, duration_ms}.",
].join(" ");

const TOOLS = [
  {
    name: "session_create",
    description: CREATE_DESC,
    inputSchema: {
      type: "object" as const,
      properties: {
        image: { type: "string", description: "OCI image (default ghcr.io/gosuda/micke:latest, override with MICKE_IMAGE). Pulled with rungv if missing while no sessions are live." },
        workspace: { type: "string", description: "Optional absolute host directory bind-mounted at /workspace. It must be writable by the guest (uid 1000; gvx has no uid remapping), or session_create fails with WORKSPACE_NOT_WRITABLE. Omit it and micke creates <MICKE_STATE_DIR>/workspaces/<session_id>; the receipt always reports the host path." },
        screen: { type: "string", description: 'Xvfb screen size WIDTHxHEIGHTxDEPTH (default "1280x800x24").' },
      },
    },
  },
  {
    name: "session_list",
    description: "List sessions. Every ready row carries the novnc_url for live viewing. `status` is sandbox liveness, not browser liveness: a ready session can have no chromium. `orphaned` rows have a pidfile but no live sandbox (they survived a daemon restart as a record only); close them with session_close.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "session_close",
    description: "Tear a session down: closes its in-flight shell connections and its rungv sandbox (SIGTERM, then SIGKILL), and deletes the pidfile. Also reaps orphaned sessions.",
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
        command: { type: "string", description: "Bash command string (may be multi-line). Runs in a fresh bash; nothing it changes persists to later calls." },
        cwd: { type: "string", description: 'Absolute guest directory to run the command in (default "/home/agent"). It never persists to later calls; a nonexistent directory fails with CWD_INVALID.' },
        timeout_ms: { type: "integer", description: "Kill the command (not the session) after this many ms. Default 120000; 0 disables." },
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

/** Audit detail on the failure path, where argument types are untrusted. */
function errDetail(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const sid = typeof args.session_id === "string" ? args.session_id : undefined;
  return tool === "session_shell" ? { sid, cmd: flatCmd(args.command) } : { sid };
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

/**
 * Fresh low-level Server wired with the four tools. The HTTP route builds one
 * per request (stateless): a Server refuses reconnecting while a transport is
 * attached, and per-request instances carry zero cross-request state.
 */
export function createMcpServer(sup: Supervisor): Server {
  const server = new Server({ name: "micke", version: "0.1.0" }, { capabilities: { tools: {} } });
  registerTools(server, sup);
  return server;
}

export function registerTools(server: Server, sup: Supervisor): void {
  const stateDir = defaultStateDir();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const t0 = Date.now();
    try {
      switch (name) {
        case "session_create": {
          const r = await sup.createSession({
            image: args.image !== undefined ? str(args.image, "image") : undefined,
            workspace: args.workspace !== undefined ? str(args.workspace, "workspace") : undefined,
            screen: args.screen !== undefined ? str(args.screen, "screen") : undefined,
          });
          auditToolCall(stateDir, name, { sid: r.session_id }, t0, "ok");
          return ok(r);
        }
        case "session_list": {
          const rows = await sup.listSessions();
          auditToolCall(stateDir, name, { rows: rows.length }, t0, "ok");
          return ok({ sessions: rows });
        }
        case "session_close": {
          const r = await sup.closeSession(str(args.session_id, "session_id"));
          auditToolCall(stateDir, name, { sid: r.closed }, t0, "ok");
          return ok(r);
        }
        case "session_shell": {
          const sid = str(args.session_id, "session_id");
          const command = str(args.command, "command");
          const r = await sup.runShell(
            sid,
            command,
            int(args.timeout_ms, "timeout_ms"),
            int(args.max_output_bytes, "max_output_bytes"),
            args.cwd !== undefined ? str(args.cwd, "cwd") : undefined,
          );
          auditToolCall(stateDir, name, { sid, rc: r.rc, timed_out: r.timedOut, cmd: flatCmd(command) }, t0, "ok");
          return ok({
            session_id: sid,
            stdout: r.stdout,
            stderr: r.stderr,
            rc: r.rc,
            timed_out: r.timedOut,
            truncated: r.truncated,
            duration_ms: r.durationMs,
          });
        }
        default: {
          const err = new MickeError("UNKNOWN_TOOL", `no tool "${name}"`, "The surface is exactly: session_create, session_list, session_close, session_shell.");
          auditToolCall(stateDir, name, errDetail(name, args), t0, "err=UNKNOWN_TOOL");
          return fail(err);
        }
      }
    } catch (err) {
      const code = err instanceof MickeError ? err.code : "INTERNAL";
      auditToolCall(stateDir, name, errDetail(name, args), t0, `err=${code}`);
      return fail(err);
    }
  });
}
