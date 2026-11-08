// tests/e2e/stock-surface.test.ts — the stock image surface, real image.
//
// a9f9508 deleted every guest helper CLI and the agent-desktop shim: the image
// is stock Debian + chromium + pinned agent-desktop@1.2.0 + pinned
// agent-browser@0.41.2 (the web half of the agent surface), with the chromium
// flags baked via /etc/chromium.d. These are the residue checks that genuinely
// need the real image — one property per test, on one shared session:
//
//   1. PATH carries no micke-* helper anymore.
//   2. agent-desktop reports the pinned 1.2.0.
//   3. `launch chromium` puts BOTH baked flags (--no-sandbox,
//      --force-renderer-accessibility) on the MAIN chromium process, read from
//      /proc/[0-9]*/cmdline (the image ships no procps).
//   4. The desktop is drivable: a compact snapshot returns ok with refs.
//   5. agent-browser reports the pinned 0.41.2.
//   6. The baked AGENT_BROWSER_EXECUTABLE_PATH is set and its target is an
//      executable — agent-browser must find the system chromium wrapper.
//
// agent-desktop@1.2.0 quirk: `wait` rejects --timeout/--timeout-ms
// (INVALID_ARGS — --help only offers --wait-timeout for --wait-for polling),
// so readiness below is polled via snapshot retries instead of `wait`.
//
// Requires an image built from >= a9f9508 (e.g. a local micke:dev or the next
// ghcr push): the published ghcr.io/gosuda/micke:latest predating it still
// carries the helpers and fails test 1 by design; tests 5-6 additionally need
// an image with the agent-browser layer.
//
// Run: MICKE_E2E=1 MICKE_IMAGE=micke:dev bun test tests/e2e/stock-surface.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, waitUntil, type Daemon } from "../helpers.js";

/** Every helper CLI a9f9508 deleted; none may resolve on PATH anymore. */
const REMOVED_HELPERS = [
  "micke-chromium",
  "micke-find",
  "micke-type",
  "micke-key",
  "micke-state",
  "micke-page-text",
  "micke-help",
] as const;

describe.skipIf(!E2E)("e2e: stock surface", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;

  const shell = (command: string, extra: Record<string, unknown> = {}) =>
    callTool<any>(client, "session_shell", { session_id: sessionId, command, ...extra });
  let sessionId: string;

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-stock-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-stock");
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

  test("no micke-* helper remains on PATH (command -v comes up empty)", async () => {
    const r = await shell(
      `for b in ${REMOVED_HELPERS.join(" ")}; do printf '%s=' "$b"; command -v "$b" || echo EMPTY; done`,
      { timeout_ms: 30_000 },
    );
    expect(r.rc).toBe(0);
    const present = REMOVED_HELPERS.filter((h) => !r.stdout.includes(`${h}=EMPTY`));
    expect(present, `still on PATH: ${present.join(", ")}`).toEqual([]);
  }, 60_000);

  test("agent-desktop version reports the pinned 1.2.0", async () => {
    const r = await shell("agent-desktop version", { timeout_ms: 30_000 });
    expect(r.rc).toBe(0);
    const env = JSON.parse(r.stdout.trim().split("\n")[0]);
    expect(env.ok).toBe(true);
    expect(env.data.version).toBe("1.2.0");
  }, 60_000);

  test("agent-browser --version exits 0 and reports the pinned 0.41.2", async () => {
    const r = await shell("agent-browser --version", { timeout_ms: 30_000 });
    expect(r.rc).toBe(0);
    expect(r.stdout.trim()).toContain("0.41.2");
  }, 60_000);

  test("the baked AGENT_BROWSER_EXECUTABLE_PATH is set and its target is executable", async () => {
    // agent-browser must land on the Debian /usr/bin/chromium wrapper (the
    // /etc/chromium.d flags ride along through it); no network, no browser.
    const r = await shell(
      `test -n "$AGENT_BROWSER_EXECUTABLE_PATH" && printf '%s' "$AGENT_BROWSER_EXECUTABLE_PATH" && test -x "$AGENT_BROWSER_EXECUTABLE_PATH"`,
      { timeout_ms: 30_000 },
    );
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("/usr/bin/chromium");
  }, 60_000);

  test("launch chromium is ok and the MAIN process carries both baked flags", async () => {
    const launch = JSON.parse(
      (await shell("agent-desktop launch chromium --arg=about:blank", { timeout_ms: 120_000 }))
        .stdout.trim().split("\n")[0],
    );
    expect(launch.ok).toBe(true);
    expect(launch.data.app).toBe("chromium");

    // The MAIN process: chromium in argv and no --type= switch (zygote, gpu,
    // renderer children all carry --type= and never --force-renderer-accessibility).
    // /proc is the only source — the image ships no procps. Transient /proc
    // entries vanish mid-scan; stderr noise is ignored, stdout decides.
    const procs = await waitUntil("the chromium main process to appear in /proc", async () => {
      const r = await shell(
        `for f in /proc/[0-9]*/cmdline; do c=$(tr '\\0' ' ' < "$f" 2>/dev/null); `
          + `case "$c" in *chromium*) case "$c" in *--type=*) ;; *) printf '%s\\n' "$c";; esac;; esac; done`,
        { timeout_ms: 30_000 },
      );
      const lines = r.stdout.split("\n").filter((l) => l.includes("chromium"));
      return lines.length ? lines : false;
    }, 60_000);
    const main = procs.find((l) => l.includes("--no-sandbox") && l.includes("--force-renderer-accessibility"));
    expect(main, `main cmdline without both flags: ${JSON.stringify(procs)}`).toBeDefined();
  }, 240_000);

  test("the desktop is drivable: compact snapshot returns ok with ref_count > 0", async () => {
    const snap = await waitUntil("an ok snapshot with refs", async () => {
      const r = await shell("agent-desktop snapshot --app chromium -i --compact", { timeout_ms: 60_000 });
      if (r.rc !== 0) return false;
      try {
        return JSON.parse(r.stdout.trim().split("\n")[0]);
      } catch {
        return false;
      }
    }, 90_000);
    expect(snap.ok).toBe(true);
    expect(Number(snap.data.ref_count)).toBeGreaterThan(0);
  }, 180_000);
});
