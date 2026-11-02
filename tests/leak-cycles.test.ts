// tests/leak-cycles.test.ts — verification: repeated create/shell/close
// cycles must leave nothing behind. 20 cycles of
// create -> one shell command -> close, then:
//   - supervisor fd count back to baseline (±FD_TOLERANCE — documented below)
//   - supervisor child-process count back to baseline (exactly; a leaked
//     rungv child or socket would show up here)
//   - zero live `rungv run … micke-<id>` processes
//   - zero session pidfiles
//
// Run on its own (or with the whole suite): bun test tests/leak-cycles.test.ts
// Needs gvx + a cached micke image; keeps itself under ~60 s (gvx cold start
// is ~1 s per cycle).
//
// FD_TOLERANCE: fds may legitimately drift a little between two idle samples
// (Bun internals, socket bookkeeping); what must NOT happen is per-cycle
// accumulation — 20 cycles x (socket + pipes) would be ~40+ fds if channels
// leaked. 8 is generous headroom over zero.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureImage, sh, spawnDaemon, type Daemon } from "./helpers.js";

const CYCLES = 20;
const FD_TOLERANCE = 8;

let client: Client;
let daemon: Daemon;
let stateDir: string;
let baselineFds = 0;
let baselineChildren = 0;

async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

function fdCount(): number {
  const procPath = `/proc/${daemon.proc.pid}/fd`;
  if (existsSync(procPath)) return readdirSync(procPath).length;
  // macOS/BSD fallback: lsof lists one fd per line plus a header.
  const r = Bun.spawnSync(["lsof", "-p", String(daemon.proc.pid)], { stdout: "pipe", stderr: "ignore" });
  const lines = r.stdout.toString().split("\n").filter(Boolean).length;
  return Math.max(0, lines - 1);
}

async function childCount(): Promise<number> {
  const r = await sh(["pgrep", "-P", String(daemon.proc.pid)]);
  return r.rc === 0 ? r.stdout.trim().split("\n").filter(Boolean).length : 0;
}

async function oneCycle(tag: string): Promise<number> {
  const t0 = Date.now();
  const a = await call("session_create");
  const shell = await call("session_shell", { session_id: a.session_id, command: `echo ${tag}` });
  expect(shell.rc).toBe(0);
  expect(shell.stdout.trim()).toBe(tag);
  const closed = await call("session_close", { session_id: a.session_id });
  expect(closed.sandbox_removed).toBe(true);
  expect(existsSync(join(stateDir, "sessions", `${a.session_id}.json`))).toBe(false);
  return Date.now() - t0;
}

beforeAll(async () => {
  await ensureImage();
  stateDir = mkdtempSync(join(tmpdir(), "micke-leak-"));
  daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
  client = await daemon.connect("micke-leak-test");
  const serverPid = daemon.proc.pid;
  // One warm-up cycle (out of the measurements) lets Bun settle internals,
  // so the baseline is a steady idle state.
  const warmMs = await oneCycle("warmup");
  await Bun.sleep(500);
  baselineFds = fdCount();
  baselineChildren = await childCount();
  console.log(`baseline (after warm-up cycle, ${warmMs}ms) -> fds=${baselineFds} children=${baselineChildren} pid=${serverPid}`);
}, 600_000);

afterAll(async () => {
  await client.close().catch(() => {});
  await daemon.terminate().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

test(
  `${CYCLES} create/shell/close cycles leave no fds, processes, or sandboxes behind`,
  async () => {
    const t0 = Date.now();
    let cycleMs = 0;
    for (let i = 1; i <= CYCLES; i++) {
      cycleMs += await oneCycle(`micke-cycle-${i}`);
    }
    const totalMs = Date.now() - t0;
    console.log(`${CYCLES} cycles in ${totalMs}ms (avg cycle ${Math.round(cycleMs / CYCLES)}ms)`);

    await Bun.sleep(800); // let transient children exit + reap
    const finalFds = fdCount();
    const finalChildren = await childCount();
    console.log(`leak deltas -> fds ${baselineFds} -> ${finalFds} (Δ${finalFds - baselineFds}, tolerance ±${FD_TOLERANCE}); children ${baselineChildren} -> ${finalChildren} (Δ${finalChildren - baselineChildren})`);

    expect(Math.abs(finalFds - baselineFds)).toBeLessThanOrEqual(FD_TOLERANCE);
    expect(finalChildren).toBe(baselineChildren);

    // zero live sandboxes for micke
    const sandboxes = await sh(["pgrep", "-f", "rungv run .*micke-"]);
    console.log(`stray rungv sandboxes -> ${sandboxes.rc === 0 ? sandboxes.stdout.trim() : "none"}`);
    expect(sandboxes.rc).not.toBe(0);

    // ...and no session pidfiles/logs left behind
    const leftovers = readdirSync(join(stateDir, "sessions"))
      .filter((n) => n.endsWith(".json") || n.endsWith(".log"));
    expect(leftovers).toEqual([]);
  },
  300_000,
);
