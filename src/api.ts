// api — the JSON surface under /api/* (dashboard fetches it; curl can too).
//
// SECURITY: this file never checks Origin. route() in main.ts runs
// originAllowed() on EVERY request before dispatching here, and that check
// plus the loopback bind are the whole DNS-rebinding defense — api.ts must
// stay reachable only through route(), never mounted anywhere else.
//
// Plain fetch-handler code: no router, no framework. Successes and errors
// are both JSON (content-type: application/json); diagnostics go to stderr
// only, this layer never writes to stdout.

import { MickeError, type Supervisor } from "./supervisor.js";
import { auditToolCall } from "./audit.js";

// MickeError.code → HTTP status (grep `MickeError(` in src/ for the full
// inventory). 4xx only where the CLIENT can act (bad params, unknown or
// stale ids); 503 where "try again shortly" is the honest answer; 500 for
// everything host-side (boot failures, image policy, internal bugs).
const STATUS: Record<string, number> = {
  SCREEN_INVALID: 400,
  WORKSPACE_INVALID: 400,
  WORKSPACE_NOT_WRITABLE: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_ORPHANED: 409, // known but stale: close it, then create fresh
  RUNGV_UNAVAILABLE: 503, // host setup issue; may fix itself without micke
  LOCK_HELD: 503, // a twin instance is mid-exit; retry shortly
};

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** `{"error":{code,message[,hint]}}` — hint omitted when absent. */
function errorResponse(err: unknown): Response {
  const e = err instanceof MickeError
    ? err
    : new MickeError("INTERNAL", err instanceof Error ? err.message : String(err), undefined);
  const body: Record<string, string> = { code: e.code, message: e.message };
  if (e.hint !== undefined) body.hint = e.hint;
  return jsonResponse(STATUS[e.code] ?? 500, { error: body });
}

function methodNotAllowed(allow: string, method: string, path: string): Response {
  return jsonResponse(
    405,
    { error: { code: "METHOD_NOT_ALLOWED", message: `${method} is not allowed on ${path}` } },
    { Allow: allow },
  );
}

/** Body-shape problems are answered by THIS layer (400) before the
 * supervisor is ever involved — same BAD_ARGUMENT code mcp.ts uses for the
 * same job, but thrown as a plain marker so it can never flow into STATUS
 * (which maps only supervisor-thrown codes). */
class BadRequest extends Error {}

const BODY_HINT = 'Send a JSON object: {"image"?, "workspace"?, "screen"?} — string values.';

function parseCreateBody(raw: string): { image?: string; workspace?: string; screen?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequest("request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequest("request body must be a JSON object");
  }
  const out: { image?: string; workspace?: string; screen?: string } = {};
  for (const key of ["image", "workspace", "screen"] as const) {
    const v = (parsed as Record<string, unknown>)[key];
    if (v === undefined) continue; // absent → supervisor default
    if (typeof v !== "string") throw new BadRequest(`"${key}" must be a string`);
    out[key] = v;
  }
  return out;
}

/**
 * Handle `/api/*`. Returns null when the path is not under /api (route()
 * then continues to the dashboard/404 fallthrough). Known routes:
 *   GET    /api/sessions        → 200 {"sessions":[SessionRow…]}
 *   POST   /api/sessions        → 201 {"session":SessionRow}
 *   DELETE /api/sessions/<id>   → 200 {closed, sandbox_removed}
 * Anything else under /api is 404; wrong methods are 405 + Allow.
 */
export async function handleApi(req: Request, sup: Supervisor): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/")) return null;

  if (path === "/api/sessions") {
    if (req.method === "GET") {
      return jsonResponse(200, { sessions: await sup.listSessions() });
    }
    if (req.method === "POST") {
      const t0 = Date.now();
      // Detail carries the request params, mirroring mcp.ts's audit lines.
      const detail: Record<string, unknown> = {};
      const audit = (outcome: "ok" | `err=${string}`) =>
        auditToolCall(sup.getStateDir(), "web.session_create", detail, t0, outcome);
      try {
        const opts = parseCreateBody(await req.text());
        Object.assign(detail, opts);
        const row = await sup.createSession(opts);
        detail.sid = row.session_id;
        audit("ok");
        return jsonResponse(201, { session: row });
      } catch (err) {
        if (err instanceof BadRequest) {
          audit("err=BAD_ARGUMENT");
          return jsonResponse(400, { error: { code: "BAD_ARGUMENT", message: err.message, hint: BODY_HINT } });
        }
        audit(`err=${err instanceof MickeError ? err.code : "INTERNAL"}`);
        return errorResponse(err);
      }
    }
    return methodNotAllowed("GET, POST", req.method, path);
  }

  const one = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (!one) {
    // Unknown /api/* subpath — still JSON, so fetch callers can parse it.
    return jsonResponse(404, { error: { code: "NOT_FOUND", message: `no such API path: ${path}` } });
  }
  const id = one[1]!;
  if (req.method !== "DELETE") return methodNotAllowed("DELETE", req.method, path);
  const t0 = Date.now();
  try {
    const r = await sup.closeSession(id);
    auditToolCall(sup.getStateDir(), "web.session_close", { sid: id }, t0, "ok");
    return jsonResponse(200, r); // {closed, sandbox_removed} as-is
  } catch (err) {
    const code = err instanceof MickeError ? err.code : "INTERNAL";
    auditToolCall(sup.getStateDir(), "web.session_close", { sid: id }, t0, `err=${code}`);
    return errorResponse(err);
  }
}
