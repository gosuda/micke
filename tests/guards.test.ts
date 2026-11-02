// tests/guards.test.ts — daemon guards that need no sandbox.
//
// Create-time validation, the free-RAM floor and pull serialization are
// decided before (or around) a guest boots. They run here against the fake
// rungv, so `bun test tests/` stays fast and a failure names the guard instead
// of "phase 2". The instance lock lives in the gated tier (its 1.5 s retry
// alone would eat the fast budget) — see tests/e2e/daemon-lock.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool, callToolErr, type Daemon } from "./helpers.js";
import { fakeState, readEvents, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

describe("create guards", () => {
  const state = fakeState("micke-guards-");
  let daemon: Daemon;
  let client: Client;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
    client = await daemon.connect("micke-guards");
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("an unknown session is SESSION_NOT_FOUND for shell", async () => {
    const err = await callToolErr(client, "session_shell", { session_id: "deadbeef", command: "x" });
    expect(err.code).toBe("SESSION_NOT_FOUND");
  });

  test("an unknown session is SESSION_NOT_FOUND for close", async () => {
    const err = await callToolErr(client, "session_close", { session_id: "deadbeef" });
    expect(err.code).toBe("SESSION_NOT_FOUND");
  });

  test("a nonexistent workspace is WORKSPACE_INVALID", async () => {
    const err = await callToolErr(client, "session_create", { workspace: "/nonexistent/xyz" });
    expect(err.code).toBe("WORKSPACE_INVALID");
  });

  test("a relative workspace is WORKSPACE_INVALID", async () => {
    const err = await callToolErr(client, "session_create", { workspace: "relative/path" });
    expect(err.code).toBe("WORKSPACE_INVALID");
  });

  test("an invalid screen is SCREEN_INVALID", async () => {
    const err = await callToolErr(client, "session_create", { screen: "huge" });
    expect(err.code).toBe("SCREEN_INVALID");
  });

  test("a workspace the guest cannot write is WORKSPACE_NOT_WRITABLE", async () => {
    // 0555 lacks w for the owner too, so this holds regardless of host uid.
    const ro = mkdtempSync(join(tmpdir(), "micke-ro-ws-"));
    chmodSync(ro, 0o555);
    try {
      const err = await callToolErr(client, "session_create", { workspace: ro });
      expect(err.code).toBe("WORKSPACE_NOT_WRITABLE");
      expect(err.hint).toContain("chmod -R a+w");
    } finally {
      chmodSync(ro, 0o755);
      rmSync(ro, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(process.platform !== "linux")("free-RAM floor (Linux only)", () => {
  const state = fakeState("micke-floor-");
  let daemon: Daemon;
  let client: Client;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state, { MICKE_MIN_FREE_MB: "99999999" });
    client = await daemon.connect("micke-floor");
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("MICKE_MIN_FREE_MB above MemAvailable is INSUFFICIENT_MEMORY", async () => {
    const err = await callToolErr(client, "session_create");
    expect(err.code).toBe("INSUFFICIENT_MEMORY");
    expect(err.message).toMatch(/MemAvailable|free/i);
  }, 15_000);
});

describe("pull serialization", () => {
  const state: FakeState = fakeState("micke-pull-");

  test("two concurrent creates of a missing image share one pull", async () => {
    const daemon = await spawnFakeDaemon(state, {
      MICKE_IMAGE: "hello-world",
      MICKE_FAKE_MISSING_IMAGE: "hello-world",
      MICKE_FAKE_PULL_MS: "50",
    });
    const client = await daemon.connect("micke-pull");
    const created: string[] = [];
    try {
      const [a, b] = await Promise.all([
        callTool<any>(client, "session_create"),
        callTool<any>(client, "session_create"),
      ]);
      created.push(a.session_id, b.session_id);
      expect(a.status).toBe("ready");
      expect(b.status).toBe("ready");

      const pulls = readEvents(state.rungvLog).filter((e) => e.ev === "pull_start");
      expect(pulls).toHaveLength(1);
      expect(readEvents(state.rungvLog).filter((e) => e.ev === "pull_end")).toHaveLength(1);
    } finally {
      for (const id of created) {
        await callTool(client, "session_close", { session_id: id }).catch(() => {});
      }
      await client.close().catch(() => {});
      await daemon.terminate().catch(() => {});
      state.cleanup();
    }
  }, 30_000);
});
