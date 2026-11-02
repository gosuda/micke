// tests/e2e/micke-type.test.ts — the text path against the real image.
//
// The mission friction this proves fixed: `agent-desktop type` is refused by
// real pages (ACTION_NOT_SUPPORTED / POLICY_DENIED), and the workaround agents
// invent by hand is clipboard + ctrl+v. micke-type ships that workaround. A
// page with ONE labeled <input> is written inside the guest, opened with
// micke-chromium, focused with a click, typed into with micke-type (Hangul +
// spaces — the exact case that failed), and the field's value is asserted
// from the a11y tree.
//
// Run: MICKE_E2E=1 bun test tests/e2e/micke-type.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, type Daemon } from "../helpers.js";

const TEXT = "네이버 웹툰 검색 micke-type 42";

describe.skipIf(!E2E)("e2e: micke-type", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;

  const shell = (command: string, extra: Record<string, unknown> = {}) =>
    callTool<any>(client, "session_shell", { session_id: sessionId, command, ...extra });
  let sessionId: string;

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-type-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-type");
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

  test("click a page input, micke-type Hangul + spaces, value shows up in the a11y tree", async () => {
    const write = await shell("cat > /tmp/type-probe.html <<'EOF'\n<!doctype html>\n<html><head><title>type-probe</title></head>\n<body><h1>type probe</h1>\n<input aria-label=\"probe-field\" type=\"text\" size=\"40\">\n</body></html>\nEOF\n");
    expect(write.rc).toBe(0);

    const launch = JSON.parse((await shell("micke-chromium file:///tmp/type-probe.html", { timeout_ms: 60_000 })).stdout);
    expect(launch.ok).toBe(true);

    const wait = JSON.parse((await shell(
      'agent-desktop wait --window "type-probe" --app chromium --timeout 20000',
      { timeout_ms: 30_000 },
    )).stdout);
    expect(wait.data.found).toBe(true);

    const found = await shell('micke-find "probe-field" --role textfield', { timeout_ms: 40_000 });
    const ref = found.stdout.trim().split("\n")[0]?.split("\t")[0] ?? "";
    expect(found.rc).toBe(0);
    expect(ref).toMatch(/^@.+/);

    const click = JSON.parse((await shell(`agent-desktop click "${ref}"`, { timeout_ms: 30_000 })).stdout);
    expect(click.ok).toBe(true);

    const typed = await shell(`micke-type '${TEXT}'`, { timeout_ms: 30_000 });
    expect(typed.rc).toBe(0);
    const receipt = JSON.parse(typed.stdout.trim().split("\n")[0]);
    expect(receipt.sent).toBe(true);
    expect(receipt.bytes).toBe(Buffer.byteLength(TEXT, "utf8"));

    // The paste lands asynchronously in the tree; poll the filtered snapshot.
    let value = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await shell(
        "agent-desktop snapshot --app chromium -i --compact --timeout-ms 5000 2>/dev/null"
        + " | jq -r '.. | objects | select(.name?==\"probe-field\") | .value' 2>/dev/null",
        { timeout_ms: 30_000 },
      );
      if (r.rc === 0 && r.stdout.trim() !== "") {
        value = r.stdout.trim();
        if (value === TEXT) break;
      }
      await Bun.sleep(1_000);
    }
    console.log(`textfield value -> ${JSON.stringify(value)}`);
    expect(value).toBe(TEXT); // the paste actually landed in the input
  }, 300_000);
});
