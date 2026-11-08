// dashboard — the ONE static route: the single-file SPA. `GET /` serves
// dashboard.html verbatim, read once at module load; the page's inline JS
// then fetches /api/sessions itself every 3 s. No framework, no build step,
// no extra deps — one HTML file. No CSP header on purpose: the SPA embeds a
// cross-origin noVNC iframe, and a restrictive policy would break it.
// Diagnostics go to stderr, like everywhere else; nothing here ever writes
// to stdout.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dir, "dashboard.html"), "utf8");

/**
 * The `/` response: the same static shell for every request. Session rows
 * arrive via /api/*, so the page embeds no per-session data and needs no
 * per-request work.
 */
export function dashboardResponse(): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
