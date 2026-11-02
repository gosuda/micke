// tests/e2e/boot.test.ts — boot smoke against the real image.
//
// The cheapest proof that the image + rungv + supervisor still work together:
// create one session, run one shell command, close it, leave nothing behind.
// Everything else that does not need real gvx lives in the fast tier.
//
// Run: MICKE_E2E=1 bun test tests/e2e/boot.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, waitUntil, type Daemon } from "../helpers.js";

describe.skipIf(!E2E)("e2e: boot smoke", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-boot-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-boot");
  }, 600_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  test("create -> one shell command -> close leaves no process or pidfile", async () => {
    const s = await callTool<any>(client, "session_create");
    try {
      expect(s.status).toBe("ready");
      const r = await callTool<any>(client, "session_shell", {
        session_id: s.session_id,
        command: "echo boot-ok",
      });
      expect(r.rc).toBe(0);
      expect(r.stdout).toBe("boot-ok\n");
    } finally {
      const closed = await callTool<any>(client, "session_close", { session_id: s.session_id });
      expect(closed.sandbox_removed).toBe(true);
    }
    expect(existsSync(join(stateDir, "sessions", `${s.session_id}.json`))).toBe(false);
    await waitUntil("rungv to exit", async () => {
      try {
        process.kill(s.rungv_pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
  }, 180_000);
});
