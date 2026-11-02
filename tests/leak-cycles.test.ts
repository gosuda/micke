// tests/leak-cycles.test.ts — repeated create/shell/close cycles leave nothing.
//
// 9 cycles of create -> one shell command -> close against the fake rungv,
// then:
//   - supervisor fd count back to baseline (±FD_TOLERANCE — see below)
//   - supervisor child-process count back to baseline (exactly; a leaked
//     rungv child or socket would show up here)
//   - every fake rungv pid from this run is gone (scoped: a real micke daemon
//     on the host may legitimately own its own sandbox)
//   - zero session pidfiles/logs
//
// FD_TOLERANCE: fds may legitimately drift a little between two idle samples
// (Bun internals, socket bookkeeping); what must NOT happen is per-cycle
// accumulation. 9 cycles is deliberately one more than the tolerance, so a
// single leaked fd per cycle still fails. 8 is generous headroom over zero.
// (The fake boots in ~150 ms, so this stays inside the fast-tier budget.)
//
// This lives in the fast tier because the fake rungv is a real child process:
// SIGTERM teardown, reaping and fd hygiene are the same host paths the real
// sandbox uses. The fake cannot prove gvx's own process tree dies with rungv,
// but it does prove micke does not accumulate anything.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { callTool, sh, type Daemon } from "./helpers.js";
import { fakeState, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

const CYCLES = 9;
const FD_TOLERANCE = 8;

const state: FakeState = fakeState("micke-leak-");
let client: Client;
let daemon: Daemon;
let baselineFds = 0;
let baselineChildren = 0;
const rungvPids: number[] = [];

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
  const a = await callTool<any>(client, "session_create");
  rungvPids.push(a.rungv_pid);
  const shell = await callTool<any>(client, "session_shell", { session_id: a.session_id, command: `echo ${tag}` });
  expect(shell.rc).toBe(0);
  expect(shell.stdout.trim()).toBe(tag);
  const closed = await callTool<any>(client, "session_close", { session_id: a.session_id });
  expect(closed.sandbox_removed).toBe(true);
  expect(existsSync(join(state.stateDir, "sessions", `${a.session_id}.json`))).toBe(false);
  return Date.now() - t0;
}

beforeAll(async () => {
  daemon = await spawnFakeDaemon(state);
  client = await daemon.connect("micke-leak-test");
  // One warm-up cycle (out of the measurements) lets Bun settle internals,
  // so the baseline is a steady idle state.
  const warmMs = await oneCycle("warmup");
  await Bun.sleep(100);
  baselineFds = fdCount();
  baselineChildren = await childCount();
  console.log(`baseline (after warm-up cycle, ${warmMs}ms) -> fds=${baselineFds} children=${baselineChildren} pid=${daemon.proc.pid}`);
}, 60_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  await daemon?.terminate().catch(() => {});
  state.cleanup();
}, 30_000);

test(
  `${CYCLES} create/shell/close cycles leave no fds, processes, or sandboxes behind`,
  async () => {
    const t0 = Date.now();
    for (let i = 1; i <= CYCLES; i++) await oneCycle(`micke-cycle-${i}`);
    console.log(`${CYCLES} cycles in ${Date.now() - t0}ms`);

    await Bun.sleep(100); // let transient children exit + reap
    const finalFds = fdCount();
    const finalChildren = await childCount();
    console.log(`leak deltas -> fds ${baselineFds} -> ${finalFds} (Δ${finalFds - baselineFds}, tolerance ±${FD_TOLERANCE}); children ${baselineChildren} -> ${finalChildren} (Δ${finalChildren - baselineChildren})`);

    expect(Math.abs(finalFds - baselineFds)).toBeLessThanOrEqual(FD_TOLERANCE);
    expect(finalChildren).toBe(baselineChildren);

    // Every sandbox this run created is gone. Scoped to the run's pids: a real
    // micke daemon on the same host may legitimately have its own sandbox.
    const strays = rungvPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    expect(strays).toEqual([]);

    // ...and no session pidfiles/logs left behind
    const leftovers = readdirSync(join(state.stateDir, "sessions"))
      .filter((n) => n.endsWith(".json") || n.endsWith(".log"));
    expect(leftovers).toEqual([]);
  },
  60_000,
);
