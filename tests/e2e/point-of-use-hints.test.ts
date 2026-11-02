// tests/e2e/point-of-use-hints.test.ts — the point-of-use hints, real image.
//
// Three mission cycles showed agents obey the agent-desktop envelope and the
// command receipts but not the manual: headless `type` refusals (POLICY_DENIED)
// were retried blindly, `press` killed chromium, and the helper names never
// surfaced. The image now puts each remedy where attention already is: one
// `micke:`-prefixed stderr line from the agent-desktop shim, and one trailing
// pointer line after a successful micke-chromium launch.
//
// Run: MICKE_E2E=1 bun test tests/e2e/point-of-use-hints.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, type Daemon } from "../helpers.js";

describe.skipIf(!E2E)("e2e: point-of-use hints", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;
  let sessionId: string;

  const shell = (command: string, extra: Record<string, unknown> = {}) =>
    callTool<any>(client, "session_shell", { session_id: sessionId, command, ...extra });

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-hints-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-hints");
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

  test("micke-chromium success output ends with the 'micke: next' pointer", async () => {
    const write = await shell("cat > /tmp/hint-probe.html <<'EOF'\n<!doctype html>\n<html><head><title>hint-probe</title></head>\n<body><h1>hint probe</h1>\n<input aria-label=\"probe-field\" type=\"text\" size=\"40\">\n</body></html>\nEOF\n");
    expect(write.rc).toBe(0);

    const launch = await shell("micke-chromium file:///tmp/hint-probe.html", { timeout_ms: 60_000 });
    expect(launch.rc).toBe(0);
    const lines = launch.stdout.trimEnd().split("\n");
    const envelope = JSON.parse(lines[0]); // the receipt stays line 1
    expect(envelope.ok).toBe(true);
    const next = lines[lines.length - 1];
    expect(next.startsWith("micke: next")).toBe(true);
    expect(next).toContain("micke-type"); // the text-path pointer agents need
  }, 120_000);

  test("a headless type refusal carries the micke-type remedy on stderr", async () => {
    const wait = JSON.parse((await shell(
      'agent-desktop wait --window "hint-probe" --app chromium --timeout 20000',
      { timeout_ms: 30_000 },
    )).stdout);
    expect(wait.data.found).toBe(true);

    const found = await shell('micke-find "probe-field" --role textfield', { timeout_ms: 40_000 });
    const ref = found.stdout.trim().split("\n")[0]?.split("\t")[0] ?? "";
    expect(found.rc).toBe(0);
    expect(ref).toMatch(/^@.+/);

    // Strict headless delivery is denied on this element, so `type` fails —
    // and the shim must append exactly ONE remedy line on stderr while stdout
    // stays the envelope alone and the failure stays a failure.
    const refused = await shell(`agent-desktop type "${ref}" 'hint probe text'`, { timeout_ms: 30_000 });
    console.log(`type refusal rc=${refused.rc} stderr=${JSON.stringify(refused.stderr.trim())}`);
    expect(refused.rc).not.toBe(0);
    const outLines = refused.stdout.trimEnd().split("\n");
    expect(outLines).toHaveLength(1); // stdout is the envelope, nothing added
    expect(JSON.parse(outLines[0]).ok).toBe(false);
    const hints = refused.stderr.trim().split("\n").filter((l) => l.startsWith("micke:"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("micke-type");
    expect(hints[0]).toContain("--headed type");
  }, 120_000);
});
