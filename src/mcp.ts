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
  "Boot a disposable Linux desktop (gvx sandbox: Xvfb + chromium + agent-desktop + noVNC) and return its novnc_url and session_id.",
  "A host workspace is always mounted at /workspace: pass an absolute existing directory, or omit it and micke creates one beside the pidfile — the receipt's `workspace` is where artifacts written to /workspace land on the host. gvx has no uid mapping, so an explicit workspace must be writable by the guest (uid 1000): otherwise session_create fails fast with WORKSPACE_NOT_WRITABLE and the exact chmod remedy. The auto-created workspace is chmod 0777 for this reason.",
  "Open chromium with `micke-chromium <url>` (required flags pre-baked); open novnc_url in a browser to watch or take over the desktop.",
  "Then run ALL commands through session_shell on that session_id — env is pre-sourced, `agent-desktop` works directly.",
].join(" ");

const SHELL_DESC = [
  "Run bash in the session. EVERY call is a fresh, independent bash: cwd and exported env do NOT persist from one call to the next (`cd /tmp` or `export FOO=bar` in one call is gone by the next). Make each call self-contained — `cd /tmp && ls`, `PATH=/x:$PATH cmd`, `FOO=bar cmd` — or pass `cwd` to start in another absolute directory (default /home/agent; a missing directory fails with CWD_INVALID). The desktop env (DISPLAY, D-Bus, AT-SPI) is already sourced in every fresh bash, so agent-desktop and micke-chromium work with no setup.",
  "Drive the desktop: `micke-chromium <url>`, then locate a target with ONE filtered snapshot: `agent-desktop snapshot --app chromium -i --compact | jq -r '.. | objects | select(.role?==\"link\") | [.ref_id,.name] | @tsv'` (filter IN the command — full trees are large), then `agent-desktop click \"@<snapshot>:REF\"` and `agent-desktop wait --window TITLE --app chromium`. `micke-find <substring> [--role R]` is the shortcut for that one-liner. Prefer the snapshot recipe to `agent-desktop find`: find needs `--first` and then still spends its whole budget. If a snapshot receipt says `truncated:true`, retry once at a higher `--timeout-ms`.",
  "Verify cheaply with `micke-state`: one line of JSON {\"alive\",\"title\",\"url\",\"refs\"} from the a11y tree, no files, ~2 s. It answers \"is the browser alive\" and \"did the click/navigation land\" — gate on a changed window title or URL, or a moved ref count; exit 1 means no chromium window. A dead browser is otherwise silent: `list-apps`/`list-windows` return `[]`, `screenshot` still succeeds, and `session_list` still says `ready` — gate on `micke-state`. `agent-desktop press` can SIGSEGV chromium on this image (rc 139): send keys with `micke-key <combo>` instead, and relaunch with `micke-chromium <url>` after a death. To type text into a page input, click the field first, then `micke-type '<text>'` (one quoted arg; sets the clipboard and pastes it). `agent-desktop type` is unreliable on real pages (ACTION_NOT_SUPPORTED / POLICY_DENIED) — don't spend calls on it; verify what landed with `jq '.. | objects | select(.name?==\"<field label>\") | .value'` on one snapshot.",
  "Take a screenshot ONLY when a human must see it: they asked for one, the answer exists only in pixels, or you are reporting a visual defect. Never screenshot to verify a click — nothing consumes the PNG; verify with window title / URL / ref_count instead. Write any screenshot to /workspace so it lands on the host.",
  "For page CONTENT (reading, headlines, article text) use `micke-page-text <url> [--links]` — headless dump-dom -> small JSON. Heavy pages truncate the a11y tree; don't snapshot what you only need to read.",
  "`agent-desktop` exits non-zero when its JSON envelope reports ok:false, so `set -e` and `&&` are trustworthy; read the envelope for the error code.",
  "Calls run in parallel up to a per-session cap (default 8, MICKE_SHELL_CONCURRENCY; beyond it they queue briefly), so a long command no longer blocks the session. A crash in one call cannot wedge the next: there is no persistent shell to wedge.",
  "Returns {stdout, stderr, rc, timed_out, truncated, duration_ms}; no stdin.",
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
