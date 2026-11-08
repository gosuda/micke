// tests/screenshot.test.ts — GET /api/sessions/:id/screenshot.png, fast.
//
// The endpoint composes three layers — supervisor lookup, per-session
// capture serialization, and the RFB client from src/rfb.ts — and the fake
// rungv's 6080 port now speaks real RFB over WebSocket (tests/fake/
// rfb-server.ts), so every request crosses the whole daemon stack for real.
// One named test = one property; every session is closed in a finally, and
// every daemon/listener a test starts is gone by afterAll.
//
// Run: bun test tests/screenshot.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil, type Daemon } from "./helpers.js";
import { fakeState, rungvEvents, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

// tests/fake/rfb-server.ts's default framebuffer, mirrored here so a
// dimension/header mismatch names itself instead of "headers were wrong".
const FB_W = 4;
const FB_H = 2;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Created {
  id: string;
  rungv_pid: number;
}

/** Shared request helpers against whatever daemon is current (the getter is
 * re-evaluated per call, so tests that replace the daemon mid-flight — the
 * orphan dance — keep working). */
function useDaemon(daemon: () => Daemon) {
  const base = () => `http://127.0.0.1:${daemon().port}`;
  const create = async (): Promise<Created> => {
    const res = await fetch(`${base()}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const json = await res.json();
    if (res.status !== 201) throw new Error(`create failed (${res.status}): ${JSON.stringify(json)}`);
    return { id: json.session.session_id, rungv_pid: json.session.rungv_pid };
  };
  const close = (id: string) => fetch(`${base()}/api/sessions/${id}`, { method: "DELETE" });
  const screenshot = (id: string) => fetch(`${base()}/api/sessions/${id}/screenshot.png`);
  return { create, close, screenshot };
}

describe("screenshot of a live session", () => {
  const state = fakeState("micke-shot-");
  let daemon: Daemon;
  const { create, close, screenshot } = useDaemon(() => daemon);

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
  }, 30_000);

  afterAll(async () => {
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("GET screenshot returns a decodable PNG for a ready session", async () => {
    const s = await create();
    try {
      const res = await screenshot(s.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("no-store"); // a frame is a moment, never a cache entry
      // Dimensions without decoding: that is the whole point of the headers.
      expect(res.headers.get("x-micke-width")).toBe(String(FB_W));
      expect(res.headers.get("x-micke-height")).toBe(String(FB_H));
      const png = Buffer.from(await res.arrayBuffer());
      expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC);
    } finally {
      await close(s.id).catch(() => {});
    }
  }, 15_000);

  test("screenshot of an unknown session id is 404", async () => {
    const res = await screenshot("deadbeef");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("SESSION_NOT_FOUND");
  }, 15_000);

  test("a successful screenshot appends a web.session_screenshot ok line", async () => {
    const s = await create();
    try {
      const res = await screenshot(s.id);
      expect(res.status).toBe(200); // the line below is only meaningful once one succeeded
      const lines = readFileSync(join(state.stateDir, "audit.log"), "utf8").split("\n").filter(Boolean);
      expect(lines.at(-1)).toMatch(
        new RegExp(`^\\S+ web\\.session_screenshot sid=${s.id} w=${FB_W} h=${FB_H} took=\\d+ms ok$`),
      );
    } finally {
      await close(s.id).catch(() => {});
    }
  }, 15_000);

  test("a non-GET method on the screenshot path is 405 with Allow: GET", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/sessions/deadbeef/screenshot.png`, {
      method: "DELETE",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET"); // routing answers before the id is even looked up
  }, 15_000);
});

describe("screenshot when the session's noVNC dies", () => {
  const state = fakeState("micke-shot-dead-");
  let daemon: Daemon;
  const { create, close, screenshot } = useDaemon(() => daemon);

  beforeAll(async () => {
    // The drop variant: the noVNC port accepts the WebSocket upgrade and
    // dies before any RFB bytes — a sandbox whose websockify/x11vnc is gone
    // while the session record still says ready. (A kernel-dead port makes
    // Bun's WS client wait out the whole RFB timeout; the drop fails in
    // milliseconds and pins the same property.)
    daemon = await spawnFakeDaemon(state, { MICKE_FAKE_NOVNC_MODE: "drop" });
  }, 30_000);

  afterAll(async () => {
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("screenshot failure maps to 502 SCREENSHOT_FAILED", async () => {
    const s = await create(); // boots ready — only the noVNC side is broken
    try {
      const res = await screenshot(s.id);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error.code).toBe("SCREENSHOT_FAILED");
      expect(json.error.message).toMatch(/^rfb: /); // the step-named cause, not a generic blob
      expect(typeof json.error.hint).toBe("string");
      expect(json.error.hint!.length).toBeGreaterThan(0);
    } finally {
      await close(s.id).catch(() => {});
    }
  }, 15_000);
});

describe("screenshot of an orphaned session", () => {
  const state = fakeState("micke-shot-orphan-");
  let daemon: Daemon;
  const { create, close, screenshot } = useDaemon(() => daemon);

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
  }, 30_000);

  afterAll(async () => {
    await daemon?.terminate().catch(() => {}); // whichever daemon is current
    state.cleanup();
  }, 30_000);

  test("screenshot of an orphaned session is 409 and no connection is attempted", async () => {
    // Tripwire: the record's noVNC port will point HERE. If the endpoint
    // dares open so much as one socket before answering, this counts it.
    let connections = 0;
    const tripwire = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          connections += 1;
          socket.end();
        },
        data() { /* never expected — the count happens in open */ },
      },
    });
    const pidfile = (id: string) => join(state.stateDir, "sessions", `${id}.json`);

    const s = await create();
    try {
      await daemon.kill(); // daemon crashes; the pidfile and sandbox survive
      process.kill(s.rungv_pid, "SIGKILL"); // …then the sandbox dies too
      await waitUntil("sandbox to die", async () => !alive(s.rungv_pid), 3_000);

      // Aim the dead record's noVNC port at the tripwire, then let a fresh
      // daemon adopt the pidfile — as orphaned, since the pid is gone.
      const rec = JSON.parse(readFileSync(pidfile(s.id), "utf8"));
      rec.novnc_host_port = tripwire.port;
      writeFileSync(pidfile(s.id), JSON.stringify(rec, null, 2) + "\n");
      daemon = await spawnFakeDaemon(state);

      const res = await screenshot(s.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("SESSION_ORPHANED");
      expect(connections).toBe(0); // refused before any connect() was attempted
    } finally {
      await close(s.id).catch(() => {});
      tripwire.stop(true);
    }
  }, 30_000);
});

describe("concurrent screenshots of one session", () => {
  const state = fakeState("micke-shot-conc-");
  let daemon: Daemon;
  const { create, close, screenshot } = useDaemon(() => daemon);

  beforeAll(async () => {
    // The per-capture delay holds every RFB conversation open long enough
    // that three concurrently-dispatched requests would genuinely overlap
    // if the endpoint allowed more than one capture at a time.
    daemon = await spawnFakeDaemon(state, { MICKE_FAKE_CAPTURE_DELAY_MS: "250" });
  }, 30_000);

  afterAll(async () => {
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("concurrent screenshots of one session are serialized", async () => {
    const s = await create();
    try {
      const [a, b, c] = await Promise.all([screenshot(s.id), screenshot(s.id), screenshot(s.id)]);
      for (const res of [a, b, c]) {
        expect(res.status).toBe(200);
        expect(res.headers.get("x-micke-width")).toBe(String(FB_W));
        expect(res.headers.get("x-micke-height")).toBe(String(FB_H));
      }
      // The fake RFB server (inside the fake rungv process) saw exactly ONE
      // conversation — never a second while the first was open. The delay
      // guarantees the three requests really were in flight together.
      const opens = rungvEvents(state)
        .filter((e) => e.ev === "novnc_capture" && e.phase === "capture_open");
      expect(opens.length).toBe(1);
      expect(Math.max(...opens.map((e) => Number(e.inflight)))).toBe(1);
    } finally {
      await close(s.id).catch(() => {});
    }
  }, 15_000);
});
