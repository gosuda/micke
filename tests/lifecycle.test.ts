// tests/lifecycle.test.ts — supervisor lifecycle against the fake rungv.
//
// create/list/close, daemon-death adoption and orphan reaping are host code.
// The fake rungv is a real child process with a real pid, real listeners and
// real SIGTERM/SIGKILL behavior, so the pidfile, port discovery and process
// reaping paths run unchanged — without a 2 GB sandbox.
//
// Run: bun test tests/lifecycle.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, callToolErr, waitUntil, type Daemon } from "./helpers.js";
import { fakeState, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

const pidfile = (state: FakeState, id: string) => join(state.stateDir, "sessions", `${id}.json`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("create, list, close", () => {
  const state = fakeState("micke-lifecycle-");
  let daemon: Daemon;
  let client: Client;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
    client = await daemon.connect("micke-lifecycle");
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("create returns a ready session with a noVNC URL and a pidfile", async () => {
    const s = await callTool<any>(client, "session_create");
    try {
      expect(s.session_id).toMatch(/^[0-9a-f]{8}$/);
      expect(s.status).toBe("ready");
      expect(s.novnc_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html$/);
      expect(existsSync(pidfile(state, s.session_id))).toBe(true);
    } finally {
      await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
    }
  }, 15_000);

  test("session_list reports the same row the create receipt returned", async () => {
    const s = await callTool<any>(client, "session_create");
    try {
      const rows = (await callTool<any>(client, "session_list")).sessions;
      const row = rows.find((r: any) => r.session_id === s.session_id);
      expect(row).toBeDefined();
      expect(row.status).toBe("ready");
      expect(row.novnc_url).toBe(s.novnc_url);
      expect(row.rungv_pid).toBe(s.rungv_pid);
    } finally {
      await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
    }
  }, 15_000);

  test("close kills the sandbox process and deletes the pidfile", async () => {
    const s = await callTool<any>(client, "session_create");
    const closed = await callTool<any>(client, "session_close", { session_id: s.session_id });
    expect(closed.sandbox_removed).toBe(true);
    await waitUntil("fake rungv to exit", async () => !alive(s.rungv_pid), 3_000);
    expect(existsSync(pidfile(state, s.session_id))).toBe(false);
    expect(alive(s.rungv_pid)).toBe(false);
  }, 15_000);
});

describe("adoption after daemon death", () => {
  const state = fakeState("micke-adopt-");
  let daemon: Daemon;
  let client: Client;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
    client = await daemon.connect("micke-adopt");
  }, 30_000);

  afterAll(async () => {
    // Whatever daemon is current, stop it; the session was closed by the test.
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("a new daemon adopts the same sandbox and keeps its pidfile and ports", async () => {
    const s = await callTool<any>(client, "session_create");
    const rec = JSON.parse(readFileSync(pidfile(state, s.session_id), "utf8"));

    await client.close();
    await daemon.kill(); // SIGKILL: fake rungv is reparented, like real gvx
    expect(existsSync(pidfile(state, s.session_id))).toBe(true);
    expect(alive(s.rungv_pid)).toBe(true);

    daemon = await spawnFakeDaemon(state); // new ephemeral port, same state dir
    client = await daemon.connect("micke-adopt-restart");

    const rows = (await callTool<any>(client, "session_list")).sessions;
    const adopted = rows.find((r: any) => r.session_id === s.session_id);
    expect(adopted?.status).toBe("ready"); // adopted, not orphaned
    expect(adopted?.novnc_url).toBe(s.novnc_url); // ports survived in the pidfile
    expect(JSON.parse(readFileSync(pidfile(state, s.session_id), "utf8"))).toEqual(rec);

    const r = await callTool<any>(client, "session_shell", {
      session_id: s.session_id,
      command: "echo adopted",
    });
    expect(r.stdout).toBe("adopted\n"); // a fresh shell re-attaches to the same sandbox

    await callTool(client, "session_close", { session_id: s.session_id });
    await waitUntil("adopted sandbox to exit", async () => !alive(s.rungv_pid), 3_000);
    expect(existsSync(pidfile(state, s.session_id))).toBe(false);
  }, 30_000);
});

describe("orphaned records", () => {
  const state = fakeState("micke-orphan-");
  let daemon: Daemon;
  let client: Client;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
    client = await daemon.connect("micke-orphan");
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("a pidfile whose sandbox is gone lists as orphaned and close reaps it", async () => {
    const s = await callTool<any>(client, "session_create");

    await client.close();
    await daemon.kill();
    process.kill(s.rungv_pid, "SIGKILL"); // the sandbox dies behind the record
    await waitUntil("sandbox to die", async () => !alive(s.rungv_pid), 3_000);

    daemon = await spawnFakeDaemon(state);
    client = await daemon.connect("micke-orphan-restart");

    const rows = (await callTool<any>(client, "session_list")).sessions;
    const orphan = rows.find((r: any) => r.session_id === s.session_id);
    expect(orphan?.status).toBe("orphaned");
    expect(orphan?.novnc_url).toBeNull();

    const err = await callToolErr(client, "session_shell", {
      session_id: s.session_id,
      command: "echo nope",
    });
    expect(err.code).toBe("SESSION_ORPHANED");

    const closed = await callTool<any>(client, "session_close", { session_id: s.session_id });
    expect(closed.sandbox_removed).toBe(true);
    expect(existsSync(pidfile(state, s.session_id))).toBe(false);
    expect((await callTool<any>(client, "session_list")).sessions).toEqual([]);
  }, 30_000);
});
