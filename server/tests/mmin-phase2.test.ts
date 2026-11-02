// tests/mmin-phase2.test.ts — M-min phase 2 verification: instance lock
// (FR-19), free-RAM floor (FR-18), pull serialization (FR-31/32) and the
// static dashboard (FR-23/24/25/29), end to end against real Docker.
//
// Run: bun test tests/mmin-phase2.test.ts
// Needs network for the one pull-serialization check (docker pull hello-world).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const SERVER_DIR = join(import.meta.dir, "..");

let client: Client;
let stateDir: string;
let dashPort: number;
const created: string[] = [];

async function sh(args: string[]): Promise<{ rc: number; stdout: string }> {
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { rc: await proc.exited, stdout };
}

async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

async function spawnServer(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath, // bun
    args: [MAIN],
    cwd: SERVER_DIR,
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const c = new Client({ name: "micke-test-p2", version: "0.1.0" });
  await c.connect(transport);
  return c;
}

/** Ask the kernel for a free TCP port (bind :0, read it back, close). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

beforeAll(async () => {
  const tags = await sh(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (!tags.stdout.includes("micke:latest")) {
    expect(tags.stdout).toContain("micke:novnc");
    expect((await sh(["docker", "tag", "micke:novnc", "micke:latest"])).rc).toBe(0);
  }
  stateDir = mkdtempSync(join(tmpdir(), "micke-test-p2-"));
  dashPort = await freePort();
  client = await spawnServer({ MICKE_STATE_DIR: stateDir, MICKE_DASHBOARD_PORT: String(dashPort) });
}, 60_000);

afterAll(async () => {
  for (const id of created) await client.callTool({ name: "session_close", arguments: { session_id: id } }).catch(() => {});
  await client.close().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

test("dashboard: empty table, meta refresh, localhost-only", async () => {
  const res = await fetch(`http://127.0.0.1:${dashPort}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain('<meta http-equiv="refresh" content="5">');
  expect(body).toContain("no sessions");
  expect(body).not.toContain("<script"); // no-JS is a requirement (FR-23)

  expect((await fetch(`http://127.0.0.1:${dashPort}/other`)).status).toBe(404);

  // localhost-only bind: a non-loopback interface must NOT reach it (FR-23).
  const ips = (await sh(["hostname", "-I"])).stdout.trim().split(/\s+/).filter((ip) => ip && ip !== "127.0.0.1");
  if (ips.length > 0) {
    await expect(fetch(`http://${ips[0]}:${dashPort}/`)).rejects.toThrow();
    console.log(`dashboard bind -> refused on non-loopback ${ips[0]} (localhost-only ok)`);
  }
}, 15_000);

test("dashboard: live session row (id/status/uptime/link) and the noVNC link opens", async () => {
  // create with the DEFAULT RAM floor in effect -> floor must not refuse.
  const a = await call("session_create");
  created.push(a.session_id);
  expect(a.status).toBe("ready");

  const body = await (await fetch(`http://127.0.0.1:${dashPort}/`)).text();
  expect(body).toContain(a.session_id);
  expect(body).toContain(`>${a.status}<`);
  expect(body).toMatch(/\d+s/); // human uptime
  expect(body).toContain(`href="${a.novnc_url}"`);
  console.log(`dashboard row -> ${a.session_id} ${a.status} ${a.novnc_url}`);

  const novnc = await fetch(a.novnc_url);
  console.log(`noVNC ${a.novnc_url} -> HTTP ${novnc.status}`);
  expect(novnc.status).toBe(200);

  await call("session_close", { session_id: a.session_id });
  const after = await (await fetch(`http://127.0.0.1:${dashPort}/`)).text();
  expect(after).not.toContain(a.session_id);
  console.log("dashboard after close -> row gone");
}, 60_000);

test("instance lock: a second supervisor exits promptly with LOCK_HELD", async () => {
  const t0 = Date.now();
  const proc = Bun.spawn([process.execPath, MAIN], {
    cwd: SERVER_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MICKE_STATE_DIR: stateDir } as Record<string, string>,
  });
  const [stderr, stdout] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
  const rc = await proc.exited;
  const wall = Date.now() - t0;
  console.log(`second supervisor -> rc=${rc} wall=${wall}ms stderr=${stderr.trim().split("\n").pop()}`);
  expect(rc).not.toBe(0);
  expect(wall).toBeLessThan(5_000); // promptly, no hang
  expect(stderr).toContain("LOCK_HELD");
  expect(stderr).toContain("supervisor.lock");
  expect(stdout).toBe(""); // stdout stays MCP-clean even on fatal exit

  // first instance is unaffected
  const rows = (await call("session_list")).sessions;
  expect(Array.isArray(rows)).toBe(true);
}, 30_000);

test("RAM floor: MICKE_MIN_FREE_MB above MemAvailable -> INSUFFICIENT_MEMORY", async () => {
  const stateDir2 = mkdtempSync(join(tmpdir(), "micke-test-p2-floor-"));
  const client2 = await spawnServer({
    MICKE_STATE_DIR: stateDir2,
    MICKE_DASHBOARD_PORT: String(await freePort()),
    MICKE_MIN_FREE_MB: "99999999", // far above any host's MemAvailable
  });
  const err = await (async () => {
    const res: any = await client2.callTool({ name: "session_create", arguments: {} });
    expect(res.isError).toBe(true);
    return JSON.parse(res.content[0].text);
  })();
  console.log(`floor 99999999 MiB -> ${err.code}: ${err.message}`);
  expect(err.code).toBe("INSUFFICIENT_MEMORY");
  expect(err.message).toContain("MemAvailable");
  // no container was started before the refusal
  const running = await sh(["docker", "ps", "-q", "--filter", "label=micke.session"]);
  expect(running.stdout.trim()).toBe("");
  await client2.close();
  rmSync(stateDir2, { recursive: true, force: true });
}, 60_000);

test("pull serialization: two concurrent creates of a missing image -> one pull, both proceed", async () => {
  expect((await sh(["docker", "rmi", "-f", "hello-world"])).rc).toBe(0); // ensure missing
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    client.callTool({ name: "session_create", arguments: { image: "hello-world" } }),
    client.callTool({ name: "session_create", arguments: { image: "hello-world" } }),
  ]);
  const wall = Date.now() - t0;
  const e1 = JSON.parse((r1 as any).content[0].text);
  const e2 = JSON.parse((r2 as any).content[0].text);
  // hello-world is not a micke desktop: its container exits (or loses its port
  // read-back) instantly, so both creates fail AFTER the image gate — which is
  // the point: ONE pull served both waiters (IMAGE_MISSING would mean the gate
  // failed, i.e. the second create did not wait for the first one's pull).
  console.log(`concurrent creates (missing image, ${wall}ms) -> ${e1.code} / ${e2.code}`);
  expect(e1.code).not.toBe("IMAGE_MISSING");
  expect(e2.code).not.toBe("IMAGE_MISSING");

  // exactly one pull was issued (docker daemon event log)
  const events = await sh([
    "docker", "events", "--since", String(Math.floor(t0 / 1000)), "--until", String(Math.ceil(Date.now() / 1000)),
    "--filter", "event=pull", "--format", "{{.Actor.Attributes.name}}",
  ]);
  const pulls = events.stdout.split("\n").filter((l) => l.includes("hello-world")).length;
  console.log(`docker pull events for hello-world in window -> ${pulls}`);
  expect(pulls).toBe(1);
  expect((await sh(["docker", "image", "inspect", "hello-world"])).rc).toBe(0);

  // failed boots must not leave containers behind
  const left = await sh(["docker", "ps", "-a", "-q", "--filter", "label=micke.session"]);
  expect(left.stdout.trim()).toBe("");
  await sh(["docker", "rmi", "-f", "hello-world"]);
}, 120_000);
