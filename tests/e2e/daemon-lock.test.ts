// tests/e2e/daemon-lock.test.ts — instance lock, in the gated tier.
//
// This guard needs no image: it uses the fake rungv. It lives behind
// MICKE_E2E because the supervisor's 1.5 s lock-retry window alone would eat
// most of the fast tier's 10 s budget. It still runs before every push, and
// the fast tier keeps the create guards, RAM floor and pull serialization.
//
// Run: MICKE_E2E=1 bun test tests/e2e/daemon-lock.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { E2E, MAIN, SERVER_DIR, type Daemon } from "../helpers.js";
import { FAKE_RUNGV, fakeState, spawnFakeDaemon, type FakeState } from "../fake/harness.js";

describe.skipIf(!E2E)("e2e: instance lock", () => {
  const state: FakeState = fakeState("micke-lock-");
  let daemon: Daemon;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
  }, 30_000);

  afterAll(async () => {
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("a second supervisor on the same state dir exits promptly with LOCK_HELD", async () => {
    const t0 = Date.now();
    const proc = Bun.spawn([process.execPath, MAIN], {
      cwd: SERVER_DIR,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MICKE_STATE_DIR: state.stateDir,
        MICKE_RUNGV: FAKE_RUNGV,
        MICKE_PORT: "0",
        MICKE_MIN_FREE_MB: "0",
      } as Record<string, string>,
    });
    const [stderr, stdout] = await Promise.all([
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    const rc = await proc.exited;
    const wall = Date.now() - t0;

    expect(rc).not.toBe(0);
    expect(wall).toBeLessThan(5_000); // promptly, no hang
    expect(stderr).toContain("LOCK_HELD");
    expect(stderr).toContain("supervisor.lock");
    expect(stdout).toBe(""); // stdout stays MCP-clean even on fatal exit
  }, 15_000);
});
