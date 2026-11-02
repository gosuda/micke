// main — micke supervisor + MCP server (stdio transport), one process.
//
// Run: bun run src/main.ts  (or: bun run start)
// Stdout belongs to the MCP protocol; diagnostics go to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MickeError, Supervisor } from "./supervisor.js";
import { startDashboard } from "./dashboard.js";
import { registerTools } from "./mcp.js";

const sup = new Supervisor();
try {
  await sup.start();
} catch (err) {
  // e.g. LOCK_HELD from a second supervisor instance: exit promptly, structured.
  const e = err instanceof MickeError
    ? err
    : new MickeError("INTERNAL", err instanceof Error ? err.message : String(err), undefined);
  console.error(`micke: fatal: ${JSON.stringify(e.toJSON())}`);
  process.exit(1);
}

const dashboard = startDashboard(() => sup.listSessions());
if (dashboard.port > 0) console.error(`micke: dashboard at http://127.0.0.1:${dashboard.port}/`);

const server = new Server({ name: "micke", version: "0.1.0" }, { capabilities: { tools: {} } });
registerTools(server, sup);
await server.connect(new StdioServerTransport());
console.error(`micke: supervisor ready (${(await sup.listSessions()).length} session(s) known)`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.error(`micke: ${signal}, killing shell channels (containers stay; they become orphaned)`);
  dashboard.stop();
  await sup.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Die with the MCP client: without this, the dashboard's listener would keep
// the process (and the instance lock) alive forever after stdin EOF.
process.stdin.on("end", () => void shutdown("stdin closed"));
process.stdin.on("close", () => void shutdown("stdin closed"));
