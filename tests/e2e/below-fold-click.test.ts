// tests/e2e/below-fold-click.test.ts — the below-fold click recipe, real image.
//
// Cycle-4 mission evidence: `agent-desktop click` on below-the-fold links and
// `agent-desktop scroll-to` burn their whole 5 s actionability budget and
// return TIMEOUT / not_delivered. The working pattern (found mid-mission at
// real cost) is keyboard-scroll with micke-key, re-find (refs are
// snapshot-scoped), then click. This file proves both halves on a real
// Xvfb + chromium: the timeout envelope carries the shim's stderr hint, and
// the recipe actually lands the click.
//
// How the timeout is produced (measured, 2026-11): on a QUIET local page
// chromium reports below-fold content actionable and DoAction scrolls
// internally, so a default-budget click lands in 1-4 s (lease_hold_ms 3239 on
// a naver.com footer link — the same machinery that times out at 5000 ms on
// heavy churning pages, which is how the missions hit it). A starved
// `--timeout-ms 1` budget on the same real below-fold target produces the
// identical TIMEOUT/not_delivered envelope from the real binary,
// deterministically — same code path (ref_action_poll timeout), same fields.
//
// Run: MICKE_E2E=1 bun test tests/e2e/below-fold-click.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, type Daemon } from "../helpers.js";

describe.skipIf(!E2E)("e2e: below-fold click recipe", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;
  let sessionId: string;

  const shell = (command: string, extra: Record<string, unknown> = {}) =>
    callTool<any>(client, "session_shell", { session_id: sessionId, command, ...extra });

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-belowfold-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-belowfold");
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

  // One tall local page: the only link sits ~6000 px below the fold.
  const TALL_HTML = `<!doctype html>
<html><head><title>tall-probe</title></head>
<body><h1>tall probe top</h1>
<div style="height:6000px"></div>
<p><a href="after.html">far-below-target</a></p>
</body></html>
`;
  const AFTER_HTML = `<!doctype html>
<html><head><title>after-probe</title></head>
<body><h1>landed below the fold</h1></body></html>
`;

  let belowRef = ""; // the below-fold link's ref, set by the first test

  test("a below-fold click TIMEOUT/not_delivered carries the keyboard-scroll hint on stderr", async () => {
    const write = await shell(`cat > /tmp/tall.html <<'EOF'\n${TALL_HTML}EOF\ncat > /tmp/after.html <<'EOF'\n${AFTER_HTML}EOF\n`);
    expect(write.rc).toBe(0);

    const launch = JSON.parse(
      (await shell("micke-chromium file:///tmp/tall.html", { timeout_ms: 60_000 }))
        .stdout.trim().split("\n")[0],
    );
    expect(launch.ok).toBe(true);

    const wait = JSON.parse((await shell(
      'agent-desktop wait --window "tall-probe" --app chromium --timeout 20000',
      { timeout_ms: 30_000 },
    )).stdout);
    expect(wait.data.found).toBe(true);

    // The offscreen link IS in the a11y tree — micke-find sees it fine.
    const found = await shell('micke-find "far-below" --role link', { timeout_ms: 40_000 });
    belowRef = found.stdout.trim().split("\n")[0]?.split("\t")[0] ?? "";
    expect(found.rc).toBe(0);
    expect(belowRef).toMatch(/^@.+/);

    // Starved actionability budget (see file header): the real binary returns
    // the exact envelope shape the missions saw. The shim must append exactly
    // ONE micke: stderr line with the recipe while stdout stays the envelope.
    const failed = await shell(`agent-desktop click "${belowRef}" --timeout-ms 1`, { timeout_ms: 60_000 });
    console.log(`below-fold click rc=${failed.rc} dur=${failed.duration_ms}ms`);
    console.log(`below-fold click envelope=${failed.stdout.trim()}`);
    console.log(`below-fold click stderr=${JSON.stringify(failed.stderr.trim())}`);
    expect(failed.rc).not.toBe(0);
    const outLines = failed.stdout.trimEnd().split("\n");
    expect(outLines).toHaveLength(1); // stdout is the envelope, nothing added
    const envelope = JSON.parse(outLines[0]);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("click");
    expect(envelope.error.code).toBe("TIMEOUT");
    expect(envelope.error.disposition.delivery).toBe("not_delivered");
    const hints = failed.stderr.trim().split("\n").filter((l) => l.startsWith("micke:"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("micke-key");
    expect(hints[0]).toContain("ctrl+End");
    expect(hints[0]).toContain("re-find");
  }, 180_000);

  test("scroll-to dying the same way gets the same hint", async () => {
    const failed = await shell(`agent-desktop scroll-to "${belowRef}" --timeout-ms 1`, { timeout_ms: 60_000 });
    console.log(`scroll-to envelope=${failed.stdout.trim()}`);
    expect(failed.rc).not.toBe(0);
    const envelope = JSON.parse(failed.stdout.trimEnd());
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("scroll-to");
    expect(envelope.error.code).toBe("TIMEOUT");
    expect(envelope.error.disposition.delivery).toBe("not_delivered");
    const hints = failed.stderr.trim().split("\n").filter((l) => l.startsWith("micke:"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("micke-key");
  }, 120_000);

  test("the recipe lands it: micke-key ctrl+End, re-find, click navigates to after.html", async () => {
    // 1. Keyboard-scroll to the bottom (the scroll path that always works).
    const key = await shell("micke-key ctrl+End", { timeout_ms: 30_000 });
    expect(key.rc).toBe(0);
    expect(JSON.parse(key.stdout.trim()).sent).toBe(true);
    await Bun.sleep(1_000); // let the scroll settle

    // 2. Re-find: refs are snapshot-scoped and the page has shifted.
    const refound = await shell('micke-find "far-below" --role link', { timeout_ms: 40_000 });
    const ref2 = refound.stdout.trim().split("\n")[0]?.split("\t")[0] ?? "";
    expect(refound.rc).toBe(0);
    expect(ref2).toMatch(/^@.+/);

    // 3. Click the now-visible target at the default budget.
    const click = await shell(`agent-desktop click "${ref2}"`, { timeout_ms: 60_000 });
    console.log(`recipe click rc=${click.rc} stdout=${click.stdout.trim().slice(0, 300)}`);
    expect(click.rc).toBe(0);
    expect(JSON.parse(click.stdout.trim().split("\n")[0]).ok).toBe(true);

    // Navigation settles asynchronously; poll the one-line receipt.
    let state: any = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await shell("micke-state", { timeout_ms: 20_000 });
      if (r.rc === 0) {
        state = JSON.parse(r.stdout);
        if (state.alive && typeof state.url === "string" && /after\.html/i.test(state.url)) break;
      }
      await Bun.sleep(1_000);
    }
    console.log(`micke-state -> ${JSON.stringify(state)}`);
    expect(state?.alive).toBe(true);
    expect(state?.url).toMatch(/after\.html/i); // the click actually navigated
  }, 180_000);
});
