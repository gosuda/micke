// tests/dashboard.test.ts — the static dashboard against a fake rungv.
//
// The dashboard reads supervisor rows only; it does not care whether the
// sandbox is gvx or the fake. This covers the empty table, meta refresh,
// loopback-only bind, live row (id/status/uptime/noVNC link), the link itself
// and the row disappearing after close — all in the fast tier.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { networkInterfaces } from "node:os";
import { callTool, type Daemon } from "./helpers.js";
import { fakeState, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

const state: FakeState = fakeState("micke-dashboard-");
let daemon: Daemon;
let client: Client;

const page = async (): Promise<{ status: number; body: string }> => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/`);
  return { status: res.status, body: await res.text() };
};

function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

beforeAll(async () => {
  daemon = await spawnFakeDaemon(state);
  client = await daemon.connect("micke-dashboard");
}, 30_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  await daemon?.terminate().catch(() => {});
  state.cleanup();
}, 30_000);

describe("dashboard", () => {
  test("an empty daemon renders the no-sessions table with meta refresh", async () => {
    const { status, body } = await page();
    expect(status).toBe(200);
    expect(body).toContain('<meta http-equiv="refresh" content="5">');
    expect(body).toContain("no sessions");
    expect(body).not.toContain("<script"); // no-JS is a requirement
  });

  test("unknown paths are 404", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/other`);
    expect(res.status).toBe(404);
  });

  test("the bind is loopback-only", async () => {
    const ip = nonLoopbackIPv4();
    if (!ip) {
      console.log("skip: no non-loopback IPv4 interface on this host");
      return;
    }
    await expect(
      fetch(`http://${ip}:${daemon.port}/`, { signal: AbortSignal.timeout(1_500) }),
    ).rejects.toThrow();
  });

  test("a live row has id/status/uptime/a working link and disappears after close", async () => {
    const s = await callTool<any>(client, "session_create");
    try {
      const { body } = await page();
      expect(body).toContain(s.session_id);
      expect(body).toContain(`>${s.status}<`);
      expect(body).toMatch(/\d+s/); // human uptime
      expect(body).toContain(`href="${s.novnc_url}"`);

      const res = await fetch(s.novnc_url);
      expect(res.status).toBe(200);
      expect((await res.text()).toLowerCase()).toContain("novnc");
    } finally {
      await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
    }
    const { body } = await page();
    expect(body).not.toContain(s.session_id);
  }, 15_000);
});
