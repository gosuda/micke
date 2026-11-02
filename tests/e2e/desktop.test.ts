// tests/e2e/desktop.test.ts — desktop smoke against the real image.
//
// One session, one honest round trip: launch chromium at a known page, locate
// a real click target with micke-find (one filtered snapshot), click it, and
// verify the navigation with micke-state (a11y receipt, no screenshot).
// This is the only tier where AT-SPI, Xvfb and chromium are real.
//
// Run: MICKE_E2E=1 bun test tests/e2e/desktop.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, type Daemon } from "../helpers.js";

describe.skipIf(!E2E)("e2e: desktop smoke", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;

  const shell = (command: string, extra: Record<string, unknown> = {}) =>
    callTool<any>(client, "session_shell", { session_id: sessionId, command, ...extra });
  let sessionId: string;

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-desktop-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-desktop");
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

  test("chromium -> micke-find -> click -> micke-state shows the navigation", async () => {
    const status = JSON.parse((await shell("agent-desktop status", { timeout_ms: 30_000 })).stdout);
    expect(status.data.permissions.accessibility.state).toBe("granted");

    const launch = JSON.parse((await shell("micke-chromium https://example.com", { timeout_ms: 60_000 })).stdout);
    expect(launch.ok).toBe(true);

    const wait = JSON.parse((await shell(
      'agent-desktop wait --window "Example Domain" --app chromium --timeout 20000',
      { timeout_ms: 30_000 },
    )).stdout);
    expect(wait.data.found).toBe(true);

    const found = await shell('micke-find "Learn more" --role link', { timeout_ms: 40_000 });
    const ref = found.stdout.trim().split("\n")[0]?.split("\t")[0] ?? "";
    expect(found.rc).toBe(0);
    expect(ref).toMatch(/^@.+/);

    const click = JSON.parse((await shell(`agent-desktop click "${ref}"`, { timeout_ms: 30_000 })).stdout);
    expect(click.ok).toBe(true);

    // Navigation settles asynchronously; poll the one-line receipt instead of
    // sleeping a fixed amount. Each attempt is a fresh bash, as in real use.
    let state: any = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await shell("micke-state", { timeout_ms: 20_000 });
      if (r.rc === 0) {
        state = JSON.parse(r.stdout);
        if (state.alive && typeof state.url === "string" && /iana\.org/i.test(state.url)) break;
      }
      await Bun.sleep(1_000);
    }
    console.log(`micke-state -> ${JSON.stringify(state)}`);
    expect(state?.alive).toBe(true);
    expect(state?.url).toMatch(/iana\.org/i); // the click actually navigated
    expect(state?.refs).toBeGreaterThan(0);
  }, 300_000);
});
