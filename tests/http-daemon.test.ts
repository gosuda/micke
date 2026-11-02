// tests/http-daemon.test.ts — daemon-shape verification (design §7 a/b):
// (a) disconnect survival — a client going away is just a dropped TCP
//     connection: the daemon, sessions, and shell channels don't notice, and
//     a fresh client picks the same session right up;
// (b) two clients, one shared session — concurrent session_shell calls from
//     two clients serialize on the session's shell queue: both succeed,
//     stdout is exact (no interleave), and both see the same session_list row.
// (The orphan re-attach case (c) is deferred to the gvx runtime swap —
// docs/research/gvx-only-analysis.md §10.)
//
// Run: bun test tests/http-daemon.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDaemon, type Daemon } from "./helpers.js";

let daemon: Daemon;
let stateDir: string;
const created: string[] = []; // session ids created by this run (cleanup safety)

async function sh(args: string[]): Promise<{ rc: number; stdout: string }> {
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { rc: await proc.exited, stdout };
}

async function call<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

beforeAll(async () => {
  // Test image policy: micke:latest is the default; retag the verified local image.
  const tags = await sh(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (!tags.stdout.includes("micke:latest")) {
    expect(tags.stdout).toContain("micke:novnc");
    expect((await sh(["docker", "tag", "micke:novnc", "micke:latest"])).rc).toBe(0);
  }
  stateDir = mkdtempSync(join(tmpdir(), "micke-test-daemon-"));
  daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
}, 60_000);

afterAll(async () => {
  // Any session left behind (test failed midway): reap it through a fresh client.
  if (created.length > 0) {
    const c = await daemon.connect("micke-daemon-cleanup").catch(() => null);
    if (c) {
      for (const id of created) await c.callTool({ name: "session_close", arguments: { session_id: id } }).catch(() => {});
      await c.close().catch(() => {});
    }
  }
  await daemon.terminate().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

test("disconnect survival: client A leaves, fresh client B drives the same session", async () => {
  const a = await daemon.connect("micke-daemon-a");
  const s = await call(a, "session_create");
  created.push(s.session_id);
  expect(s.status).toBe("ready");

  await a.close(); // the TCP connection drops; the daemon must not notice
  await Bun.sleep(100);

  const b = await daemon.connect("micke-daemon-b");
  const r = await call(b, "session_shell", { session_id: s.session_id, command: "echo still-here" });
  console.log(`after reconnect -> session ${s.session_id} rc=${r.rc} stdout=${JSON.stringify(r.stdout)}`);
  expect(r.rc).toBe(0);
  expect(r.stdout).toBe("still-here\n");

  await call(b, "session_close", { session_id: s.session_id });
  created.length = 0;
  await b.close();
}, 120_000);

test("two clients, one session: concurrent shells serialize; both see the same row", async () => {
  const a = await daemon.connect("micke-daemon-tc-a");
  const b = await daemon.connect("micke-daemon-tc-b");
  const s = await call(a, "session_create");
  created.push(s.session_id);
  // Open the (lazy) shell once up front, then race two clients on the
  // already-open channel — the per-session queue is the contract under test.
  const warm = await call(a, "session_shell", { session_id: s.session_id, command: "echo ready" });
  expect(warm.rc).toBe(0);

  const [ra, rb] = await Promise.all([
    call(a, "session_shell", { session_id: s.session_id, command: "sleep 0.3; echo A" }),
    call(b, "session_shell", { session_id: s.session_id, command: "echo B" }),
  ]);
  console.log(`concurrent -> A rc=${ra.rc} stdout=${JSON.stringify(ra.stdout)} | B rc=${rb.rc} stdout=${JSON.stringify(rb.stdout)}`);
  expect(ra.rc).toBe(0);
  expect(ra.stdout).toBe("A\n"); // exact output = no interleave
  expect(rb.rc).toBe(0);
  expect(rb.stdout).toBe("B\n");

  const rowsA = (await call(a, "session_list")).sessions;
  const rowsB = (await call(b, "session_list")).sessions;
  const rowA = rowsA.find((r: any) => r.session_id === s.session_id);
  const rowB = rowsB.find((r: any) => r.session_id === s.session_id);
  expect(rowA).toBeDefined();
  expect(rowB).toEqual(rowA); // same row from both clients
  expect(rowA.status).toBe("ready");

  await call(a, "session_close", { session_id: s.session_id });
  created.length = 0;
  await a.close();
  await b.close();
}, 120_000);
