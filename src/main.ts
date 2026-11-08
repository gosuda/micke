// main — micke daemon: supervisor + MCP over Streamable HTTP + dashboard,
// ONE Bun.serve on 127.0.0.1:$MICKE_PORT (default 7800; loopback-only bind is
// a security property).
//
// Run: bun run src/main.ts  (or: bun run start)
// Routes: POST /mcp (stateless MCP), /api/* (JSON API), GET / (dashboard),
// anything else 404. Diagnostics go to stderr; stdout stays clean.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MickeError, Supervisor } from "./supervisor.js";
import { dashboardResponse } from "./dashboard.js";
import { createMcpServer } from "./mcp.js";
import { handleApi } from "./api.js";

const sup = new Supervisor();
try {
  await sup.start(); // flock FIRST, then bind: a second micke with a different state dir loses the port race, not the lock
} catch (err) {
  // e.g. LOCK_HELD from a second supervisor instance: exit promptly, structured.
  const e = err instanceof MickeError
    ? err
    : new MickeError("INTERNAL", err instanceof Error ? err.message : String(err), undefined);
  console.error(`micke: fatal: ${JSON.stringify(e.toJSON())}`);
  process.exit(1);
}

const port = parseInt(process.env.MICKE_PORT || "7800", 10);

// The allowlist must use the BOUND port: with MICKE_PORT=0 the daemon listens
// on a kernel-picked port, and a same-origin browser fetch sends that one.
let boundPort = port;

// The router IS the middleware (design §2d): the loopback bind plus this
// Origin check are the whole DNS-rebinding defense. Browsers always send
// Origin on cross-origin POSTs; MCP clients send none.
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null
    || origin === `http://127.0.0.1:${boundPort}`
    || origin === `http://localhost:${boundPort}`;
}

async function route(req: Request): Promise<Response> {
  if (!originAllowed(req)) return new Response("forbidden\n", { status: 403 });
  const path = new URL(req.url).pathname;
  if (path === "/mcp") {
    if (req.method !== "POST") {
      // Stateless mode has no server-push stream; 405 is spec-blessed
      // (clients treat it as expected). Never delegate GET to the
      // transport — it would open a hanging SSE stream.
      return new Response("method not allowed\n", { status: 405, headers: { Allow: "POST" } });
    }
    // CRITICAL: a stateless transport is single-use (the SDK throws on
    // reuse) and a Server cannot reconnect — fresh pair per request.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: sessions live in the Supervisor
      enableJsonResponse: true, // tools-only server; no SSE needed
    });
    const mcp = createMcpServer(sup);
    await mcp.connect(transport);
    return transport.handleRequest(req);
  }
  // /api/* rides the SAME Origin gate above — api.ts never re-checks and
  // must never be reachable without it. Null = not an /api path: fall
  // through to dashboard/404.
  const apiRes = await handleApi(req, sup);
  if (apiRes) return apiRes;
  if (path === "/") return dashboardResponse();
  return new Response("not found\n", { status: 404 });
}

const server = (() => {
  try {
    // reusePort: false is load-bearing: Bun's Linux default (true, via
    // SO_REUSEPORT) would let a second daemon "bind" the same port and
    // silently share traffic with the first — PORT_HELD must be detectable.
    // idleTimeout: 255 s (Bun's max) because a web POST /api/sessions can
    // hold the request open through image pull + boot — minutes on a first
    // run — and a client disconnect does NOT cancel the server-side boot
    // (the session still appears on the next poll). The default (~10 s)
    // would sever exactly those long creates while the sandbox keeps booting.
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      reusePort: false,
      development: false,
      idleTimeout: 255,
      fetch: route,
    });
  } catch (err) {
    // The port IS the product (unlike the old optional dashboard): fatal.
    console.error(`micke: fatal: ${JSON.stringify({
      code: "PORT_HELD",
      message: `cannot bind 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`,
      hint: `Another process holds the port. Check: ss -ltnp 'sport = :${port}' — or set MICKE_PORT.`,
    })}`);
    process.exit(1);
  }
})();
boundPort = server.port ?? port; // kernel-picked when MICKE_PORT=0

console.error(`micke: daemon at http://127.0.0.1:${boundPort}/ (mcp: POST /mcp)`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.error(`micke: ${signal}, closing in-flight shell connections (sandboxes survive; the next start adopts them)`);
  server.stop(true);
  await sup.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
