// main — micke supervisor + MCP server (stdio transport), one process.
//
// Run: bun run src/main.ts  (or: bun run start)
// Stdout belongs to the MCP protocol; diagnostics go to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Supervisor } from "./supervisor.js";
import { registerTools } from "./mcp.js";

const sup = new Supervisor();
await sup.start();

const server = new Server({ name: "micke", version: "0.1.0" }, { capabilities: { tools: {} } });
registerTools(server, sup);
await server.connect(new StdioServerTransport());
console.error(`micke: supervisor ready (${(await sup.listSessions()).length} session(s) known)`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.error(`micke: ${signal}, killing shell channels (containers stay; they become orphaned)`);
  await sup.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
