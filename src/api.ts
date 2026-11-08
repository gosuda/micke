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
import { captureScreenshot, type Screenshot } from "./rfb.js";

// MickeError.code → HTTP status (grep `MickeError(` in src/ for the full
// inventory). 4xx only where the CLIENT can act (bad params, unknown or
// stale ids); 503 where "try again shortly" is the honest answer; 500 for
// everything host-side (boot failures, image policy, internal bugs); 502
// where micke is the gateway to something that died behind a live record.
const STATUS: Record<string, number> = {
  SCREEN_INVALID: 400,
  WORKSPACE_INVALID: 400,
  WORKSPACE_NOT_WRITABLE: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_ORPHANED: 409, // known but stale: close it, then create fresh
  SCREENSHOT_FAILED: 502, // the record is ready; its websockify/x11vnc path is not
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

// ---- screenshot endpoint -----------------------------------------------------

// At most ONE in-flight capture per session. Parallel raw full-frame grabs
// against a single x11vnc are pure duplicated load (x11vnc serializes its
// clients anyway), so concurrent requests for the same id JOIN the running
// capture and receive the same frame instead of queueing their own. One map
// entry per capturing session, dropped the moment it settles; sessions never
// share a flight.
const captureFlights = new Map<string, Promise<Screenshot>>();

function joinCapture(id: string, port: number): Promise<Screenshot> {
  const running = captureFlights.get(id);
  if (running) return running;
  const flight = captureScreenshot(port, process.env.MICKE_VNC_PASSWORD || undefined)
    .finally(() => captureFlights.delete(id));
  captureFlights.set(id, flight);
  return flight;
}

/**
 * GET /api/sessions/<id>/screenshot.png — one full-desktop frame as PNG, with
 * the dimensions in x-micke-width/-height so callers never decode the body
 * just to learn them. Lookup answers come BEFORE any socket is opened (404
 * unknown id, 409 orphaned record); a capture that then fails — websockify or
 * x11vnc dead, timeout, protocol break — is 502 SCREENSHOT_FAILED with the
 * step-named cause in `message`.
 */
async function screenshotResponse(id: string, sup: Supervisor): Promise<Response> {
  const t0 = Date.now();
  const audit = (outcome: "ok" | `err=${string}`, detail: Record<string, unknown> = {}) =>
    auditToolCall(sup.getStateDir(), "web.session_screenshot", { sid: id, ...detail }, t0, outcome);
  try {
    const target = sup.getSession(id); // throws 404/409 shapes before connecting
    const shot = await joinCapture(id, target.novnc_host_port);
    audit("ok", { w: shot.width, h: shot.height });
    // no-store: a screenshot is one moment in time; every view must re-ask.
    return new Response(shot.png, {
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
        "x-micke-width": String(shot.width),
        "x-micke-height": String(shot.height),
      },
    });
  } catch (err) {
    if (err instanceof MickeError) { // SESSION_NOT_FOUND / SESSION_ORPHANED
      audit(`err=${err.code}`);
      return errorResponse(err);
    }
    audit("err=SCREENSHOT_FAILED");
    return errorResponse(new MickeError(
      "SCREENSHOT_FAILED",
      err instanceof Error ? err.message : String(err),
      "The session's noVNC/x11vnc may have died; check the session log or recreate the session.",
    ));
  }
}

/**
 * Handle `/api/*`. Returns null when the path is not under /api (route()
 * then continues to the dashboard/404 fallthrough). Known routes:
 *   GET    /api/sessions                      → 200 {"sessions":[SessionRow…]}
 *   POST   /api/sessions                      → 201 {"session":SessionRow}
 *   DELETE /api/sessions/<id>                 → 200 {closed, sandbox_removed}
 *   GET    /api/sessions/<id>/screenshot.png  → 200 image/png (+dimension headers)
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

  // The two-segment `<id>/screenshot.png` shape first: `[^/]+` cannot eat a
  // slash, so the one-segment DELETE route below can never shadow it.
  const shot = /^\/api\/sessions\/([^/]+)\/screenshot\.png$/.exec(path);
  if (shot) {
    if (req.method !== "GET") return methodNotAllowed("GET", req.method, path);
    return screenshotResponse(shot[1]!, sup);
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
