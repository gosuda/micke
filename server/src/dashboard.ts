// dashboard — the ONE static route (FR-23/24/25/29): a no-JS HTML table of
// sessions at 127.0.0.1:<MICKE_DASHBOARD_PORT> (default 7800), auto-refreshed
// by a meta tag. Served from inside the supervisor process; stdout stays
// MCP-clean (diagnostics → stderr, like everywhere else). No framework, no
// build step, no extra deps — a template literal.

import type { SessionRow } from "./supervisor.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** "2m 31s"-style uptime that fits a table cell. */
export function humanUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** The whole page. Every interpolated value is escaped, ours or not. */
export function renderDashboard(rows: SessionRow[]): string {
  const body = rows.length === 0
    ? `<p id="empty">no sessions</p>`
    : `<table>
<thead><tr><th>session</th><th>status</th><th>uptime</th><th>noVNC</th></tr></thead>
<tbody>
${rows.map((r) => {
  const link = r.novnc_url
    ? `<a href="${esc(r.novnc_url)}">open</a>`
    : "—"; // orphaned with no discoverable port: no link, says so
  return `<tr><td>${esc(r.session_id)}</td><td>${esc(r.status)}</td><td>${esc(humanUptime(r.uptime_seconds))}</td><td>${link}</td></tr>`;
}).join("\n")}
</tbody>
</table>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>micke sessions</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#111}
table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:.4rem .8rem;text-align:left}
th{background:#f2f2f2}a{color:#0366d6}#empty{color:#555}
</style>
</head>
<body>
<h1>micke sessions</h1>
${body}
<p>${rows.length} session(s) · refreshes every 5 s</p>
</body>
</html>
`;
}

export interface Dashboard {
  port: number; // 0 when the dashboard could not start (non-fatal)
  stop(): void;
}

/**
 * Serve `/` on 127.0.0.1 (localhost-only bind is a security property, FR-23).
 * Failure to bind is non-fatal: the MCP server is the product, the table is
 * convenience — log to stderr and continue without it.
 */
export function startDashboard(listSessions: () => Promise<SessionRow[]>): Dashboard {
  const port = parseInt(process.env.MICKE_DASHBOARD_PORT || "7800", 10);
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      development: false,
      fetch: async (req): Promise<Response> => {
        if (new URL(req.url).pathname !== "/") {
          return new Response("not found\n", { status: 404 });
        }
        try {
          const body = renderDashboard(await listSessions());
          return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(`micke: session list failed: ${esc(msg)}\n`, { status: 500 });
        }
      },
    });
    return { port: server.port ?? port, stop: () => server.stop(true) };
  } catch (err) {
    console.error(`micke: dashboard not started on port ${port} (${String(err)}) — continuing without it`);
    return { port: 0, stop: () => {} };
  }
}
