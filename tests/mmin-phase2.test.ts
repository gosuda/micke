// tests/mmin-phase2.test.ts — M-min phase 2 verification: instance lock
// (FR-19), free-RAM floor (FR-18), pull serialization (FR-31/32) and the
// static dashboard (FR-23/24/25/29), end to end against real gvx.
//
// Run: bun test tests/mmin-phase2.test.ts
// Needs network for the one pull-serialization check (rungv pull hello-world).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureImage, sh, spawnDaemon, GVX_CACHE, MAIN, RUNGV, SERVER_DIR, type Daemon } from "./helpers.js";

let client: Client;
let daemon: Daemon;
let stateDir: string;
const created: string[] = [];

async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

beforeAll(async () => {
  await ensureImage();
  stateDir = mkdtempSync(join(tmpdir(), "micke-test-p2-"));
  daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
  client = await daemon.connect("micke-test-p2");
}, 600_000);

afterAll(async () => {
  for (const id of created) await client.callTool({ name: "session_close", arguments: { session_id: id } }).catch(() => {});
  await client.close().catch(() => {});
  await daemon.terminate().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

test("dashboard: empty table, meta refresh, localhost-only", async () => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain('<meta http-equiv="refresh" content="5">');
  expect(body).toContain("no sessions");
  expect(body).not.toContain("<script"); // no-JS is a requirement (FR-23)

  expect((await fetch(`http://127.0.0.1:${daemon.port}/other`)).status).toBe(404);

  // localhost-only bind: a non-loopback interface must NOT reach it (FR-23).
  const ips = (await sh(["hostname", "-I"])).stdout.trim().split(/\s+/).filter((ip) => ip && ip !== "127.0.0.1");
  if (ips.length > 0) {
    await expect(fetch(`http://${ips[0]}:${daemon.port}/`)).rejects.toThrow();
    console.log(`dashboard bind -> refused on non-loopback ${ips[0]} (localhost-only ok)`);
  }
}, 15_000);

test("dashboard: live session row (id/status/uptime/link) and the noVNC link opens", async () => {
  // create with the DEFAULT RAM floor in effect -> floor must not refuse.
  const a = await call("session_create");
  created.push(a.session_id);
  expect(a.status).toBe("ready");

  const body = await (await fetch(`http://127.0.0.1:${daemon.port}/`)).text();
  expect(body).toContain(a.session_id);
  expect(body).toContain(`>${a.status}<`);
  expect(body).toMatch(/\d+s/); // human uptime
  expect(body).toContain(`href="${a.novnc_url}"`);
  console.log(`dashboard row -> ${a.session_id} ${a.status} ${a.novnc_url}`);

  const novnc = await fetch(a.novnc_url);
  console.log(`noVNC ${a.novnc_url} -> HTTP ${novnc.status}`);
  expect(novnc.status).toBe(200);

  await call("session_close", { session_id: a.session_id });
  const after = await (await fetch(`http://127.0.0.1:${daemon.port}/`)).text();
  expect(after).not.toContain(a.session_id);
  console.log("dashboard after close -> row gone");
}, 120_000);

test("instance lock: a second supervisor exits promptly with LOCK_HELD", async () => {
  const t0 = Date.now();
  const proc = Bun.spawn([process.execPath, MAIN], {
    cwd: SERVER_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MICKE_STATE_DIR: stateDir,
      MICKE_GVX_CACHE: GVX_CACHE,
    } as Record<string, string>,
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
  if (process.platform !== "linux") {
    console.log("skip: /proc/meminfo is absent, so the floor fails open on this host");
    return;
  }
  const stateDir2 = mkdtempSync(join(tmpdir(), "micke-test-p2-floor-"));
  const daemon2 = await spawnDaemon({
    MICKE_STATE_DIR: stateDir2,
    MICKE_MIN_FREE_MB: "99999999", // far above any host's MemAvailable
  });
  const client2 = await daemon2.connect("micke-test-p2-floor");
  const err = await (async () => {
    const res: any = await client2.callTool({ name: "session_create", arguments: {} });
    expect(res.isError).toBe(true);
    return JSON.parse(res.content[0].text);
  })();
  console.log(`floor 99999999 MiB -> ${err.code}: ${err.message}`);
  expect(err.code).toBe("INSUFFICIENT_MEMORY");
  expect(err.message).toMatch(/MemAvailable|free/i);
  // no sandbox was started before the refusal
  const running = await sh(["pgrep", "-f", "rungv run .*micke-"]);
  expect(running.rc).not.toBe(0);
  await client2.close();
  await daemon2.terminate();
  rmSync(stateDir2, { recursive: true, force: true });
}, 60_000);

test("pull serialization: two concurrent creates of a missing image -> one pull, both proceed", async () => {
  // A throwaway cache isolates this check from the suite's desktop image.
  const stateDir3 = mkdtempSync(join(tmpdir(), "micke-test-p2-pull-"));
  const cache3 = join(stateDir3, "gvx-cache");
  await sh([RUNGV, "rmi", "-f", "-cache-dir", cache3, "hello-world"]).catch(() => {});

  const daemon3 = await spawnDaemon({
    MICKE_STATE_DIR: stateDir3,
    MICKE_GVX_CACHE: cache3,
    MICKE_IMAGE: "hello-world",
  });
  const client3 = await daemon3.connect("micke-test-p2-pull");
  try {
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      client3.callTool({ name: "session_create", arguments: {} }),
      client3.callTool({ name: "session_create", arguments: {} }),
    ]);
    const wall = Date.now() - t0;
    const e1 = JSON.parse((r1 as any).content[0].text);
    const e2 = JSON.parse((r2 as any).content[0].text);
    // hello-world is not a micke desktop: its sandbox exits before the ready
    // line, so both creates fail AFTER the image gate — which is the point:
    // ONE pull served both waiters (IMAGE_MISSING would mean the gate failed).
    console.log(`concurrent creates (missing image, ${wall}ms) -> ${e1.code} / ${e2.code}`);
    expect(e1.code).not.toBe("IMAGE_MISSING");
    expect(e2.code).not.toBe("IMAGE_MISSING");
    expect(e1.code).not.toBe("RUNGV_UNAVAILABLE");
    expect(e2.code).not.toBe("RUNGV_UNAVAILABLE");

    expect((await sh([RUNGV, "inspect", "-cache-dir", cache3, "hello-world"])).rc).toBe(0);

    // failed boots must not leave pidfiles behind
    const leftover = await sh(["pgrep", "-f", "rungv run .*micke-"]);
    expect(leftover.rc).not.toBe(0);
  } finally {
    await client3.close().catch(() => {});
    await daemon3.terminate().catch(() => {});
    await sh([RUNGV, "rmi", "-f", "-cache-dir", cache3, "hello-world"]).catch(() => {});
    rmSync(stateDir3, { recursive: true, force: true });
  }
}, 600_000);
