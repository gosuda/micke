// tests/helpers.ts — shared daemon harness + gvx image/cache helpers.
//
// Spawns src/main.ts as an HTTP daemon on a kernel-picked port (MICKE_PORT=0),
// parses the port from the one stderr startup line, and connects SDK Clients
// over Streamable HTTP. stderr keeps draining in the background so a failing
// daemon's last words are in the error message, and the pipe never fills.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { join } from "node:path";
import { homedir } from "node:os";

export const MAIN = join(import.meta.dir, "..", "src", "main.ts");
export const SERVER_DIR = join(import.meta.dir, "..");

/** The real-image tier is opt-in: `bun test tests/` must never boot a sandbox. */
export const E2E = process.env.MICKE_E2E === "1";

export const RUNGV = process.env.MICKE_RUNGV || "rungv";

/** micke's EROFS cache (same default as src/gvxio.ts). */
export const GVX_CACHE = process.env.MICKE_TEST_CACHE_DIR
  || process.env.MICKE_GVX_CACHE
  || join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "micke", "gvx");

/** The desktop image every suite boots (pull once, then cache-only). */
export const IMAGE = process.env.MICKE_TEST_IMAGE
  || process.env.MICKE_IMAGE
  || "ghcr.io/gosuda/micke:latest";

const STARTUP = /^micke: daemon at http:\/\/127\.0\.0\.1:(\d+)\/ \(mcp: POST \/mcp\)$/m;

export interface Daemon {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  /** A fresh low-level Client connected to this daemon's /mcp. */
  connect(name: string): Promise<Client>;
  /** Hard kill (simulated crash); sandboxes stay and become adoptable. */
  kill(): Promise<number>;
  /** Graceful SIGTERM (what systemd stop sends). */
  terminate(): Promise<number>;
}

export async function sh(args: string[]): Promise<{ rc: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { rc: await proc.exited, stdout, stderr };
}

/** Does the cache hold the image? (`inspect`, with an `images` fallback.) */
async function hasImage(ref: string, cache: string): Promise<boolean> {
  const inspect = await sh([RUNGV, "inspect", "-cache-dir", cache, ref]);
  if (inspect.rc === 0) return true;
  if (!/unknown (command|flag)|flag provided but not defined/i.test(inspect.stderr)) return false;
  const list = await sh([RUNGV, "images", "-cache-dir", cache]);
  if (list.rc !== 0) return false;
  const at = ref.indexOf("@");
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  const repository = at >= 0 ? ref.slice(0, at) : colon > slash ? ref.slice(0, colon) : ref;
  const tag = at >= 0 ? "" : colon > slash ? ref.slice(colon + 1) : "latest";
  return list.stdout.split("\n").some((line) => {
    const [repo, rowTag] = line.trim().split(/\s+/);
    return repo === repository && (tag === "" || rowTag === tag);
  });
}

/** Ensure the image is in the gvx cache; pull once if missing (network). */
export async function ensureImage(ref = IMAGE, cache = GVX_CACHE): Promise<void> {
  if (await hasImage(ref, cache)) return;
  console.log(`image ${ref} missing from ${cache}; pulling once…`);
  const pull = await sh([RUNGV, "pull", "-cache-dir", cache, ref]);
  if (pull.rc !== 0) {
    throw new Error(`rungv pull ${ref} failed (rc=${pull.rc}): ${pull.stderr.trim().slice(-800)}`);
  }
}

/** One MCP tool call; a structured error becomes a thrown Error. */
export async function callTool<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

/** One MCP tool call that must fail; returns the structured {code,message,hint}. */
export async function callToolErr(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; message: string; hint: string | null }> {
  const res: any = await client.callTool({ name, arguments: args });
  if (!res.isError) throw new Error(`tool ${name} unexpectedly succeeded: ${res.content?.[0]?.text ?? ""}`);
  return JSON.parse(res.content[0].text);
}

/** Poll until `check` returns truthy (or throw with the last value). */
export async function waitUntil<T>(
  label: string,
  check: () => Promise<T | false | null | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last as T;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

export function spawnDaemon(env: Record<string, string> = {}): Promise<Daemon> {
  const proc = Bun.spawn([process.execPath, MAIN], {
    cwd: SERVER_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MICKE_PORT: "0",
      MICKE_GVX_CACHE: GVX_CACHE,
      MICKE_IMAGE: IMAGE,
      ...env,
    } as Record<string, string>,
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
