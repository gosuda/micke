// tests/helpers.ts — shared daemon harness: spawn src/main.ts as an HTTP
// daemon on a kernel-picked port (MICKE_PORT=0 — no TOCTOU window), parse the
// port from the one stderr startup line, and connect SDK Clients over
// Streamable HTTP. stderr keeps draining in the background so a failing
// daemon's last words are in the error message, and the pipe never fills.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { join } from "node:path";

export const MAIN = join(import.meta.dir, "..", "src", "main.ts");
export const SERVER_DIR = join(import.meta.dir, "..");

const STARTUP = /^micke: daemon at http:\/\/127\.0\.0\.1:(\d+)\/ \(mcp: POST \/mcp\)$/m;

export interface Daemon {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  /** A fresh low-level Client connected to this daemon's /mcp. */
  connect(name: string): Promise<Client>;
  /** Hard kill (simulated crash); containers stay and become orphans. */
  kill(): Promise<number>;
  /** Graceful SIGTERM (what systemd stop sends). */
  terminate(): Promise<number>;
}

export function spawnDaemon(env: Record<string, string> = {}): Promise<Daemon> {
  const proc = Bun.spawn([process.execPath, MAIN], {
    cwd: SERVER_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MICKE_PORT: "0", ...env } as Record<string, string>,
  });

  let stderrText = "";
  let settled = false;
  let resolvePort!: (port: number) => void;
  let rejectStartup!: (err: Error) => void;
  const started = new Promise<number>((resolve, reject) => {
    resolvePort = resolve;
    rejectStartup = reject;
  });
  const decoder = new TextDecoder();
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (!settled) rejectStartup(new Error(`daemon exited before the startup line: ${stderrText.trim()}`));
          return;
        }
        stderrText += decoder.decode(value, { stream: true });
        const m = stderrText.match(STARTUP);
        if (m && !settled) {
          settled = true;
          resolvePort(parseInt(m[1], 10));
        }
      }
    } catch { /* reader gone — daemon died; started already settled or rejected */ }
  })();

  return started.then((port) => ({
    proc,
    port,
    async connect(name: string): Promise<Client> {
      const client = new Client({ name, version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      return client;
    },
    kill: () => {
      try { proc.kill(9); } catch { /* already gone */ }
      return proc.exited;
    },
    terminate: () => {
      try { proc.kill(); } catch { /* already gone */ }
      return proc.exited;
    },
  }));
}
