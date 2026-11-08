// tests/stateless-shell.test.ts — the session_shell contract on a real
// image: ONE fresh bash per call. Boots a single session and runs every
// stateless assertion against it, in sequence, so the E2E suite does not pay
// for more sandboxes.
//
// Covered here (the parts a fake guest cannot prove): cwd/env do not persist,
// the old PATH-replay bug cannot poison the next call, parallel calls overlap,
// a timeout kills only the command, a background job survives the call that
// started it, and a killed handler cannot wedge the session. The wire protocol
// itself is covered in the fast tier (tests/shell-protocol.test.ts).
//
// Run: MICKE_E2E=1 bun test tests/stateless-shell.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, ensureImage, spawnDaemon, type Daemon } from "./helpers.js";

describe.skipIf(!E2E)("e2e: stateless shell", () => {
  let client: Client;
  let daemon: Daemon;
  let stateDir: string;
  let sessionId: string;

  async function callOn<T = any>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res: any = await c.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "{}";
    if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
    return res.structuredContent ?? JSON.parse(text);
  }

  const call = <T = any>(name: string, args: Record<string, unknown> = {}) => callOn<T>(client, name, args);

  async function callErr(name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
    const res: any = await client.callTool({ name, arguments: args });
    expect(res.isError).toBe(true);
    return JSON.parse(res.content[0].text);
  }

  const sh = (command: string, extra: Record<string, unknown> = {}) =>
    call<any>("session_shell", { session_id: sessionId, command, ...extra });

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-test-stateless-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-stateless");
    const s = await call("session_create");
    sessionId = s.session_id;
    expect(s.status).toBe("ready");
  }, 600_000);

  afterAll(async () => {
    await call("session_close", { session_id: sessionId }).catch(() => {});
    await client.close().catch(() => {});
    await daemon.terminate().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  test("cwd and exported env do not persist between calls", async () => {
    await sh("cd /tmp && export MICKE_FOO=bar");
    const pwd = await sh("pwd");
    const foo = await sh('echo "${MICKE_FOO:-unset}"');
    console.log(`stateless -> pwd=${pwd.stdout.trim()} FOO=${foo.stdout.trim()}`);
    expect(pwd.rc).toBe(0);
    expect(pwd.stdout.trim()).toBe("/home/agent");
    expect(foo.stdout.trim()).toBe("unset");
  }, 60_000);

  test("cwd: runs in the given directory and fails clearly when it is missing", async () => {
    const pwd = await sh("pwd", { cwd: "/tmp" });
    expect(pwd.rc).toBe(0);
    expect(pwd.stdout.trim()).toBe("/tmp");

    const missing = await callErr("session_shell", {
      session_id: sessionId,
      command: "pwd",
      cwd: "/nonexistent/micke-cwd",
    });
    expect(missing.code).toBe("CWD_INVALID");
    expect(missing.message).toContain("/nonexistent/micke-cwd");

    const relative = await callErr("session_shell", {
      session_id: sessionId,
      command: "pwd",
      cwd: "relative/path",
    });
    expect(relative.code).toBe("BAD_ARGUMENT");
  }, 60_000);

  test("REGRESSION: export PATH=/nonexistent cannot poison the next call", async () => {
    // The removed env replay unset changed variables before resolving
    // comm/grep/sed through PATH, so this left PATH=[] and every later call died
    // at mktemp with an empty frame (rc 1) until session_close.
    const poison = await sh("export PATH=/nonexistent");
    expect(poison.rc).toBe(0);
    const after = await sh("echo ok");
    console.log(`PATH regression -> rc=${after.rc} stdout=${JSON.stringify(after.stdout)}`);
    expect(after.rc).toBe(0);
    expect(after.stdout.trim()).toBe("ok");
  }, 60_000);

  test("parallel calls overlap (no host-side queue)", async () => {
    // Deterministic ordering check: each call timestamps its own start/end in the
    // guest. If calls were serialized, the short one would end before the long
    // one even starts (or after it ends); overlap proves they ran together.
    const c2 = await daemon.connect("micke-stateless-par");
    await sh("rm -f /tmp/micke-conc.log");
    const stamp = (tag: string, sleepSecs: number) =>
      `s=$(date +%s%N); sleep ${sleepSecs}; e=$(date +%s%N); echo "${tag} $s $e" >> /tmp/micke-conc.log`;

    const [long, short] = await Promise.all([
      callOn(c2, "session_shell", { session_id: sessionId, command: stamp("A", 2) }),
      call("session_shell", { session_id: sessionId, command: stamp("B", 0.5) }),
    ]);
    expect(long.rc).toBe(0);
    expect(short.rc).toBe(0);

    const log = (await sh("cat /tmp/micke-conc.log")).stdout.trim().split("\n");
    const rows = Object.fromEntries(
      log.map((l: string) => {
        const [tag, start, end] = l.split(" ");
        return [tag, { start: Number(start), end: Number(end) }];
      }),
    );
    expect(rows.A && rows.B).toBeTruthy();
    console.log(
      `overlap -> A=[${rows.A.start},${rows.A.end}] B=[${rows.B.start},${rows.B.end}] ` +
        `B_inside_A=${rows.B.start < rows.A.end && rows.B.end > rows.A.start}`,
    );
    // B overlapped A (ran inside A's window) rather than queueing around it.
    expect(rows.B.start).toBeLessThan(rows.A.end);
    expect(rows.B.end).toBeGreaterThan(rows.A.start);
    expect(rows.B.end).toBeLessThan(rows.A.end); // B (0.5 s) finished before A (2 s)
    expect(rows.A.end - rows.A.start).toBeGreaterThan(1_000_000_000); // sanity: A really slept

    // A burst above the default cap (8) queues briefly and still completes.
    const burst = await Promise.all(
      Array.from({ length: 12 }, (_, i) => sh(`echo burst-${i}`)),
    );
    expect(burst.map((r: any) => r.stdout.trim())).toEqual(
      Array.from({ length: 12 }, (_, i) => `burst-${i}`),
    );
    await c2.close().catch(() => {});
  }, 120_000);

  test("timeout kills the command and leaves no stray process", async () => {
    const timed = await sh("sleep 300", { timeout_ms: 1_000 });
    console.log(`timeout -> rc=${timed.rc} timed_out=${timed.timed_out} duration=${timed.duration_ms}ms`);
    expect(timed.timed_out).toBe(true);
    expect(timed.rc).not.toBe(0);
    await Bun.sleep(300); // the watchdog's KILL escalation needs a beat
    const strays = await sh("pgrep -f 'sleep 300' | wc -l");
    expect(strays.stdout.trim()).toBe("0");
    const alive = await sh("echo alive");
    expect(alive.stdout.trim()).toBe("alive");
  }, 60_000);

  test("a background job survives the call that started it", async () => {
    const start = await sh("nohup sleep 30 >/dev/null 2>&1 & echo started");
    expect(start.stdout.trim()).toBe("started");
    await Bun.sleep(300);
    const found = await sh("pgrep -f 'sleep 30' | head -1");
    console.log(`nohup -> pid=${JSON.stringify(found.stdout.trim())}`);
    expect(found.rc).toBe(0);
    expect(found.stdout.trim()).toMatch(/^\d+$/);
    await sh("pkill -f 'sleep 30' || true");
  }, 60_000);

  test("output over max_output_bytes is truncated with the dropped byte count", async () => {
    // The real image's wrapper truncates in the guest; the fake tier can only
    // prove the host's parser accepts the marker, so keep this real check.
    const big = await sh("head -c 400000 /dev/zero | tr '\\0' x", {
      timeout_ms: 30_000,
      max_output_bytes: 65_536,
    });
    const cut = big.stdout.match(/…\[truncated (\d+) bytes\]/);
    expect(big.truncated.stdout).toBe(true);
    expect(parseInt(cut![1], 10)).toBe(400_000 - 65_536);
    expect(big.stdout.length).toBeLessThanOrEqual(65_536 + 64);
  }, 60_000);

  test("a killed handler fails one call; the next is a fresh bash", async () => {
    const killed = await callErr("session_shell", {
      session_id: sessionId,
      command: "kill -9 $$",
      timeout_ms: 1_000,
    });
    expect(killed.code).toBe("SHELL_UNAVAILABLE");
    const after = await sh("pwd; echo after-kill");
    console.log(`after killed handler -> rc=${after.rc} stdout=${JSON.stringify(after.stdout)}`);
    expect(after.rc).toBe(0);
    expect(after.stdout.split("\n")[0]).toBe("/home/agent");
  }, 60_000);
});
