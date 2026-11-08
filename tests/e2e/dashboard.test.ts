// tests/e2e/dashboard.test.ts — dashboard + screenshot chain, real image.
//
// The fast tier already pins the shell contract and the /api/* surface
// against the fake guest (tests/dashboard.test.ts, tests/screenshot.test.ts).
// What only the real image can prove, one property per test:
//
//   1. GET / serves the SPA shell from the real daemon (cheap, no session).
//   2. GET /api/sessions/<id>/screenshot.png crosses the whole real chain —
//      websockify in the guest, x11vnc's pixel-format negotiation, a raw
//      full-frame grab, our hand-rolled PNG — and returns a genuine PNG
//      sized to the session's screen (IHDR + scanline length agree).
//   3. With MICKE_VNC_PASSWORD set, x11vnc demands VNC auth and the capture
//      must pass it: the only real-world check of desVncResponse() against
//      x11vnc's DES implementation (the fake server shares our code, so it
//      can never catch a shared misunderstanding).
//
// One sandbox at a time: bun:test runs tests and describes sequentially, and
// every session is closed in a finally/afterAll before the next boot.
//
// Run: MICKE_E2E=1 bun test tests/e2e/dashboard.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { inflateSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, ensureImage, spawnDaemon, waitUntil, type Daemon } from "../helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Small explicit screen: raw frame transfer over loopback stays tiny while
// still exercising the real Xvfb/x11vnc path at a non-default size.
const SCREEN = "320x200x24";
const SCREEN_W = 320;
const SCREEN_H = 200;

/**
 * Poll GET screenshot until 200 — the first request can race websockify
 * startup inside the guest. On timeout the error names the LAST response
 * body, so an auth/protocol failure says so instead of "kept being false".
 */
async function screenshotUntilOk(url: string, timeoutMs = 60_000): Promise<Response> {
  let last = "(no response yet)";
  try {
    return await waitUntil("a successful screenshot", async () => {
      const res = await fetch(url);
      if (res.ok) return res;
      last = `HTTP ${res.status}: ${(await res.text().catch(() => "")).trim()}`;
      return false;
    }, timeoutMs);
  } catch (err) {
    throw new Error(`${(err as Error).message} — last response: ${last}`);
  }
}

describe.skipIf(!E2E)("e2e: dashboard shell + real screenshots", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;
  const base = () => `http://127.0.0.1:${daemon.port}`;

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-dash-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir, MICKE_MIN_FREE_MB: "0" });
    client = await daemon.connect("micke-e2e-dash");
  }, 600_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  test("GET / serves the micke dashboard shell on the real daemon", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<title>micke dashboard</title>");
    expect(body).toContain('id="app"'); // the mount the SPA renders rows into
    expect(body).toContain("<script"); // the SPA itself is inline by design
  }, 30_000);

  test("the screenshot endpoint returns a real PNG sized to the session screen", async () => {
    const s = await callTool<any>(client, "session_create", { screen: SCREEN });
    try {
      expect(s.status).toBe("ready");
      const res = await screenshotUntilOk(`${base()}/api/sessions/${s.session_id}/screenshot.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-micke-width")).toBe(String(SCREEN_W));
      expect(res.headers.get("x-micke-height")).toBe(String(SCREEN_H));
      const png = Buffer.from(await res.arrayBuffer());
      expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC);

      // The PNG's own IHDR must agree with the screen x11vnc negotiated:
      // 320x200, 8-bit truecolor (color type 2) — the headers could be lies,
      // the encoded bytes cannot.
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(SCREEN_W);
      expect(png.readUInt32BE(20)).toBe(SCREEN_H);
      expect(png[24]).toBe(8); // bit depth
      expect(png[25]).toBe(2); // color type: truecolor RGB

      // And the one IDAT must inflate to exactly the scanline buffer — one
      // filter byte (0 = None) per 320*3-byte row, 200 rows.
      const idat: Buffer[] = [];
      for (let o = 8; o < png.length;) {
        const len = png.readUInt32BE(o);
        const type = png.subarray(o + 4, o + 8).toString("ascii");
        if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
        if (type === "IEND") break;
        o += 12 + len;
      }
      const raw = inflateSync(Buffer.concat(idat));
      const stride = SCREEN_W * 3 + 1;
      expect(raw.length).toBe(stride * SCREEN_H);
      for (let y = 0; y < SCREEN_H; y++) {
        if (raw[y * stride] !== 0) {
          expect(`scanline ${y} filter byte`).toBe("0 (None)");
        }
      }
    } finally {
      await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
    }
  }, 180_000);
});

describe.skipIf(!E2E)("e2e: VNC password auth (real DES against x11vnc)", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;
  let sessionId: string;

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-vncpw-"));
    daemon = await spawnDaemon({
      MICKE_STATE_DIR: stateDir,
      MICKE_MIN_FREE_MB: "0",
      MICKE_VNC_PASSWORD: "micke-e2e",
    });
    client = await daemon.connect("micke-e2e-vncpw");
    const s = await callTool<any>(client, "session_create", { screen: SCREEN });
    sessionId = s.session_id;
    expect(s.status).toBe("ready");
  }, 600_000);

  afterAll(async () => {
    if (sessionId) await callTool(client, "session_close", { session_id: sessionId }).catch(() => {});
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  test("a MICKE_VNC_PASSWORD daemon screenshots through real DES auth", async () => {
    // Wrong-DES or no-auth would surface as 502 SCREENSHOT_FAILED with
    // "VNC authentication rejected"; screenshotUntilOk names it on timeout.
    const res = await screenshotUntilOk(`http://127.0.0.1:${daemon.port}/api/sessions/${sessionId}/screenshot.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-micke-width")).toBe(String(SCREEN_W));
    expect(res.headers.get("x-micke-height")).toBe(String(SCREEN_H));
    const png = Buffer.from(await res.arrayBuffer());
    expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC);
  }, 120_000);
});
