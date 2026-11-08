// tests/dashboard.test.ts — the SPA shell + the surface it relies on,
// against a fake rungv.
//
// The page is static by design: it embeds no session data, rows arrive via
// /api/sessions. These tests pin the shell contract (title, mount element,
// inline script), prove the served HTML is session-independent while the
// API carries the rows, and keep the one live property of the old
// server-rendered page — a ready session's novnc_url really serves noVNC.
// Loopback bind and 404s stay. All fast tier.

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

const listRows = async (): Promise<any[]> => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/sessions`);
  return (await res.json()).sessions;
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
  test("GET / serves the SPA shell: title, mount element, inline script", async () => {
    const { status, body } = await page();
    expect(status).toBe(200);
    expect(body).toContain("<title>micke dashboard</title>");
    expect(body).toContain('id="app"'); // the mount the SPA renders rows into
    expect(body).toContain("<script"); // the SPA itself is inline by design
  });

  test("the served page is session-independent: rows arrive via /api, not HTML", async () => {
    const s = await callTool<any>(client, "session_create");
    try {
      expect((await listRows()).map((r) => r.session_id)).toContain(s.session_id); // visible via the API…
      const { body } = await page();
      expect(body).not.toContain(s.session_id); // …but the page is the same static shell for everyone
    } finally {
      await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
    }
  }, 15_000);

  test("a ready session's novnc_url serves a noVNC page", async () => {
    const s = await callTool<any>(client, "session_create");
    try {
      const row = (await listRows()).find((r: any) => r.session_id === s.session_id);
      expect(row?.novnc_url).toBeTruthy(); // ready rows carry one to check
      const res = await fetch(row.novnc_url);
      expect(res.status).toBe(200);
      expect((await res.text()).toLowerCase()).toContain("novnc");
    } finally {
      await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
    }
  }, 15_000);

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
});
