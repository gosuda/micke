// tests/e2e/micke-help.test.ts — the in-guest manual against the real image.
//
// The cycle-2 mission evidence: a fresh agent used ZERO micke helpers across
// 39 shells because it oriented from `agent-desktop --help` / `skills get
// desktop`, which mention none of them. Two properties here, one per test:
//
//  1. `micke-help` is installed in the image and lists every helper — the
//     in-guest manual page exists where agents actually look around.
//  2. `agent-desktop skills` cannot carry a micke skill: its docs are
//     compiled into the binary (`skills path` reports location "embedded"),
//     which is WHY micke-help exists as a separate script. Pinned so a
//     future file-based skills dir (location change) reopens the question.
//
// Run: MICKE_E2E=1 bun test tests/e2e/micke-help.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, type Daemon } from "../helpers.js";

const HELPERS = [
  "micke-chromium",
  "micke-find",
  "micke-type",
  "micke-key",
  "micke-state",
  "micke-page-text",
] as const;

describe.skipIf(!E2E)("e2e: micke-help", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;
  let sessionId: string;

  const shell = (command: string, extra: Record<string, unknown> = {}) =>
    callTool<any>(client, "session_shell", { session_id: sessionId, command, ...extra });

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-help-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-help");
    const s = await callTool<any>(client, "session_create");
    sessionId = s.session_id;
    expect(s.status).toBe("ready");
  }, 600_000);

  afterAll(async () => {
    if (sessionId) await callTool(client, "session_close", { session_id: sessionId }).catch(() => {});
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  test("micke-help is on PATH in the session and lists every helper", async () => {
    const r = await shell("micke-help", { timeout_ms: 30_000 });
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    for (const h of HELPERS) expect(r.stdout).toContain(h);
    expect(r.stdout).toContain("agent-desktop click");
    console.log(`micke-help ->\n${r.stdout.trim()}`);
  }, 120_000);

  test("agent-desktop skills are embedded (non-extensible): no file-based skill injection point", async () => {
    const r = await shell("agent-desktop skills path", { timeout_ms: 30_000 });
    expect(r.rc).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.data.location).toBe("embedded");
    expect(env.data.available).not.toContain("micke");
    console.log(`skills path -> ${JSON.stringify(env.data)}`);
  }, 120_000);
});
