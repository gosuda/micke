// tests/http-daemon.test.ts — daemon-shape verification (design §7 a/b):
// (a) disconnect survival — a client going away is just a dropped TCP
//     connection: the daemon, sessions, and shell endpoints don't notice, and
//     a fresh client picks the same session right up;
// (b) two clients, one shared session — concurrent session_shell calls from
//     two clients run in independent fresh bashes (no shared shell state, no
//     queue): both succeed, stdout is exact (one frame per connection), and
//     both see the same session_list row.
// (The adoption case — daemon killed, sandbox survives, next daemon
// re-attaches — is covered by tests/mmin-phase1.test.ts §13.)
//
// Run: bun test tests/http-daemon.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureImage, spawnDaemon, type Daemon } from "./helpers.js";

let daemon: Daemon;
let stateDir: string;
const created: string[] = []; // session ids created by this run (cleanup safety)

async function call<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

beforeAll(async () => {
  await ensureImage();
  stateDir = mkdtempSync(join(tmpdir(), "micke-test-daemon-"));
  daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
}, 600_000);

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

test("two clients, one session: concurrent shells are independent; both see the same row", async () => {
  const a = await daemon.connect("micke-daemon-tc-a");
  const b = await daemon.connect("micke-daemon-tc-b");
  const s = await call(a, "session_create");
  created.push(s.session_id);
  // Every call opens its own connection, so there is no channel to warm: the
  // two calls below run in independent fresh bashes.
  const warm = await call(a, "session_shell", { session_id: s.session_id, command: "echo ready" });
  expect(warm.rc).toBe(0);

  const t0 = Date.now();
  const [ra, rb] = await Promise.all([
    call(a, "session_shell", { session_id: s.session_id, command: "sleep 1; echo A" }),
    call(b, "session_shell", { session_id: s.session_id, command: "echo B" }),
  ]);
  console.log(`concurrent -> A rc=${ra.rc} stdout=${JSON.stringify(ra.stdout)} | B rc=${rb.rc} stdout=${JSON.stringify(rb.stdout)} in ${Date.now() - t0}ms`);
  expect(ra.rc).toBe(0);
  expect(ra.stdout).toBe("A\n"); // one frame per connection = no interleave
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
