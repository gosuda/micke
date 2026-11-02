// tests/leak-cycles.test.ts — FR-10 verification: repeated create/shell/close
// cycles must leave nothing behind. 20 cycles of
// create -> one shell command -> close, then:
//   - supervisor fd count back to baseline (±FD_TOLERANCE — documented below)
//   - supervisor child-process count back to baseline (exactly; a leaked
//     `docker exec` shell client would show up here)
//   - zero `micke.session`-labeled containers
//   - zero stray host-side `docker exec`/bash processes for micke containers
//
// Run on its own (or with the whole suite): bun test tests/leak-cycles.test.ts
// Needs Docker + the local micke image; keeps itself under ~60 s.
//
// FD_TOLERANCE: fds may legitimately drift a little between two idle samples
// (Bun internals, socket bookkeeping); what must NOT happen is per-cycle
// accumulation — 20 cycles x (1 stdin + 1 stdout + 1 stderr + sockets) would
// be ~80+ fds if channels leaked. 8 is generous headroom over zero.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDaemon, type Daemon } from "./helpers.js";

const CYCLES = 20;
const FD_TOLERANCE = 8;

let client: Client;
let daemon: Daemon;
let stateDir: string;
let baselineFds = 0;
let baselineChildren = 0;

async function sh(args: string[]): Promise<{ rc: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { rc: await proc.exited, stdout, stderr };
}

async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

function fdCount(): number {
  return readdirSync(`/proc/${daemon.proc.pid}/fd`).length;
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
  expect(closed.container_removed).toBe(true);
  return Date.now() - t0;
}

beforeAll(async () => {
  const tags = await sh(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (!tags.stdout.includes("micke:latest")) {
    expect(tags.stdout).toContain("micke:novnc");
    expect((await sh(["docker", "tag", "micke:novnc", "micke:latest"])).rc).toBe(0);
  }
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
}, 120_000);

afterAll(async () => {
  await client.close().catch(() => {});
  await daemon.terminate().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

test(
  `FR-10: ${CYCLES} create/shell/close cycles leave no fds, processes, or containers behind`,
  async () => {
    const t0 = Date.now();
    let cycleMs = 0;
    for (let i = 1; i <= CYCLES; i++) {
      cycleMs += await oneCycle(`micke-cycle-${i}`);
    }
    const totalMs = Date.now() - t0;
    console.log(`${CYCLES} cycles in ${totalMs}ms (avg cycle ${Math.round(cycleMs / CYCLES)}ms)`);

    await Bun.sleep(800); // let transient `docker` CLI children exit + reap
    const finalFds = fdCount();
    const finalChildren = await childCount();
    console.log(`leak deltas -> fds ${baselineFds} -> ${finalFds} (Δ${finalFds - baselineFds}, tolerance ±${FD_TOLERANCE}); children ${baselineChildren} -> ${finalChildren} (Δ${finalChildren - baselineChildren})`);

    expect(Math.abs(finalFds - baselineFds)).toBeLessThanOrEqual(FD_TOLERANCE);
    expect(finalChildren).toBe(baselineChildren);

    // zero micke.session-labeled containers
    const containers = await sh(["docker", "ps", "-a", "-q", "--filter", "label=micke.session"]);
    expect(containers.stdout.trim()).toBe("");

    // zero stray host-side shell clients (`docker exec -i micke-<id> bash`)
    const strays = await sh(["pgrep", "-af", "docker exec.*micke-"]);
    console.log(`stray docker-exec processes -> ${strays.rc === 0 ? strays.stdout.trim() : "none"}`);
    expect(strays.rc).not.toBe(0);

    // ...and no stray host bash spawned for them either
    const bashStrays = await sh(["pgrep", "-af", `bash.*micke-`]);
    expect(bashStrays.rc).not.toBe(0);
  },
  120_000,
);
