// tests/rfb.test.ts — the RFB-over-websockify screenshot client, fast.
//
// src/rfb.ts is pure host code: it needs only a WebSocket that carries bytes,
// so the "session" here is tests/fake/rfb-server.ts — a Bun.serve speaking
// just enough RFB to answer ONE capture, with every server reply fragmented
// across WS messages (that fragmentation is the condition the client exists
// to survive: RFB is a byte stream, WebSocket is message-framed, and
// websockify forwards TCP segments, which never align with protocol units).
// The scenario matrix lives here; the server itself is shared with
// tests/fake/rungv so the daemon-spawned fake speaks the identical wire.
//
// One named test = one property (see AGENTS.md): PNG bytes, DES auth, auth
// rejection, timeout + hangup, unsupported encoding.

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { captureScreenshot, desVncResponse } from "../src/rfb.js";
import { rfbPixel, startFakeRfbServer, type FakeRfbServer, type RfbMode } from "./fake/rfb-server.js";

const FB_W = 4;
const FB_H = 2;
const PASSWORD = "sesame";
const CHALLENGE = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i));
const TIMEOUT_MS = 3_000; // per-capture ceiling; tests that hang fail on this

/** Recognizable, position-derived pixels so a byte-level diff names the error. */
const pixel = rfbPixel;

/** What encodePng's IDAT must contain: filter-0 scanlines of exactly `pixel`. */
function expectedScanlines(): Buffer {
  const stride = FB_W * 3 + 1;
  const out = Buffer.alloc(stride * FB_H);
  for (let y = 0; y < FB_H; y++) {
    out[y * stride] = 0; // filter None
    for (let x = 0; x < FB_W; x++) {
      const [r, g, b] = pixel(x, y);
      out.set([r, g, b], y * stride + 1 + x * 3);
    }
  }
  return out;
}

/** One scenario fake on a kernel-picked port; dims/pixels pinned so the
 * assertions below name any drift in the shared server's defaults. */
function startFakeVnc(mode: RfbMode): FakeRfbServer {
  return startFakeRfbServer({
    mode,
    width: FB_W,
    height: FB_H,
    pixel: rfbPixel,
    password: PASSWORD,
    challenge: CHALLENGE,
  });
}

describe("captureScreenshot (RFB through websockify)", () => {
  test("returns a decodable PNG of the served framebuffer: magic, IHDR 4x2, exact IDAT scanlines", async () => {
    const vnc = startFakeVnc("none");
    try {
      const r = await captureScreenshot(vnc.port, undefined, TIMEOUT_MS);
      expect(r.width).toBe(FB_W);
      expect(r.height).toBe(FB_H);

      const png = Buffer.from(r.png);
      // Signature: the 8 bytes every PNG decoder checks first.
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // IHDR (first chunk, data starts at offset 16): our geometry, 8-bit RGB.
      expect(png.toString("ascii", 12, 16)).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(FB_W);
      expect(png.readUInt32BE(20)).toBe(FB_H);
      expect(png[24]).toBe(8); // bit depth
      expect(png[25]).toBe(2); // color type: truecolor
      // Walk the chunks, inflate IDAT, and demand the exact filtered bytes.
      let idat = Buffer.alloc(0);
      for (let off = 8; off + 8 <= png.length;) {
        const len = png.readUInt32BE(off);
        const type = png.toString("ascii", off + 4, off + 8);
        if (type === "IDAT") idat = Buffer.concat([idat, png.subarray(off + 8, off + 8 + len)]);
        off += 12 + len;
        if (type === "IEND") break;
      }
      expect(inflateSync(idat)).toEqual(expectedScanlines());
    } finally {
      vnc.stop();
    }
  });

  test("authenticates with the VNC DES challenge-response when a password is given", async () => {
    const vnc = startFakeVnc("auth");
    try {
      const r = await captureScreenshot(vnc.port, PASSWORD, TIMEOUT_MS);
      expect(r.png.length).toBeGreaterThan(0);
      // The server verified the response against the exported helper and would
      // have dropped the socket otherwise; assert it here too so the property
      // is visible in the failure message, not just "capture failed".
      expect(vnc.state.authResponse).not.toBeNull();
      expect(vnc.state.authResponse!).toEqual(desVncResponse(PASSWORD, CHALLENGE));
    } finally {
      vnc.stop();
    }
  });

  test("rejects with an error naming the auth step when the server refuses the password", async () => {
    const vnc = startFakeVnc("auth-reject");
    try {
      await expect(captureScreenshot(vnc.port, PASSWORD, TIMEOUT_MS)).rejects.toThrow(/VNC auth/i);
    } finally {
      vnc.stop();
    }
  });

  test("rejects quickly and hangs up when the server goes silent after the handshake", async () => {
    const vnc = startFakeVnc("silent");
    try {
      const t0 = Date.now();
      await expect(captureScreenshot(vnc.port, undefined, 300)).rejects.toThrow(/timed out/i);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(250); // honored the deadline
      expect(elapsed).toBeLessThan(2_000); // did not hang until the bun default
      // The server must actually SEE the hangup (the finally always closes).
      const deadline = Date.now() + 2_000;
      while (!vnc.state.closed && Date.now() < deadline) await Bun.sleep(25);
      expect(vnc.state.closed).toBe(true);
    } finally {
      vnc.stop();
    }
  });

  test("rejects naming the encoding when the server answers with a non-raw encoding", async () => {
    const vnc = startFakeVnc("bad-encoding");
    try {
      await expect(captureScreenshot(vnc.port, undefined, TIMEOUT_MS)).rejects.toThrow(/encoding 5/);
    } finally {
      vnc.stop();
    }
  });
});
