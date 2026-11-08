// tests/api.test.ts — the /api/* JSON surface against the fake rungv.
//
// Pure HTTP (no MCP client): the origin gate, status codes and the JSON
// error shape are the properties. Every session a test creates is closed in
// a finally block — even on failure paths nothing sandbox-shaped is left
// behind. All fast tier.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Daemon } from "./helpers.js";
import { fakeState, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

const state: FakeState = fakeState("micke-api-");
let daemon: Daemon;

const base = () => `http://127.0.0.1:${daemon.port}`;

beforeAll(async () => {
  daemon = await spawnFakeDaemon(state);
}, 30_000);

afterAll(async () => {
  await daemon?.terminate().catch(() => {});
  state.cleanup();
}, 30_000);

async function postSession(body: unknown): Promise<{ res: Response; json: any }> {
  const res = await fetch(`${base()}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function deleteSession(id: string): Promise<Response> {
  return fetch(`${base()}/api/sessions/${id}`, { method: "DELETE" });
}

async function listIds(): Promise<string[]> {
  const res = await fetch(`${base()}/api/sessions`);
  const json = await res.json();
  return json.sessions.map((s: any) => s.session_id);
}

describe("json api", () => {
  test("POST /api/sessions creates a session that then appears in GET /api/sessions", async () => {
    const { res, json } = await postSession({});
    try {
      expect(res.status).toBe(201);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(json.session.session_id).toMatch(/^[0-9a-f]{8}$/);
      expect(await listIds()).toContain(json.session.session_id);
    } finally {
      if (json?.session?.session_id) await deleteSession(json.session.session_id).catch(() => {});
    }
  }, 15_000);

  test("POST with a disallowed Origin header is 403 and creates no session", async () => {
    const res = await fetch(`${base()}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://rebind.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await listIds()).toEqual([]); // rejected before any handler ran
  }, 15_000);

  test("DELETE /api/sessions/:id closes the session and it is gone from the list", async () => {
    const { json } = await postSession({});
    const id = json.session.session_id;
    try {
      const res = await deleteSession(id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ closed: id, sandbox_removed: true });
      expect(await listIds()).not.toContain(id);
    } finally {
      await deleteSession(id).catch(() => {}); // no-op on success, cleanup on failure
    }
  }, 15_000);

  test("DELETE of an unknown id is 404 with SESSION_NOT_FOUND in the JSON error body", async () => {
    const res = await deleteSession("deadbeef");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("SESSION_NOT_FOUND");
    expect(typeof json.error.message).toBe("string");
  }, 15_000);

  test("POST with an invalid screen is 400 with SCREEN_INVALID in the JSON error body", async () => {
    const { res, json } = await postSession({ screen: "nope" });
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("SCREEN_INVALID");
  }, 15_000);
});
