// tests/rfb.test.ts — the RFB-over-websockify screenshot client, fast.
//
// src/rfb.ts is pure host code: it needs only a WebSocket that carries bytes,
// so the "session" here is an inline Bun.serve speaking just enough RFB to
// answer ONE capture. The fake deliberately FRAGMENTS every server reply
// (3 bytes per WS message) because that is the condition the client exists
// to survive: RFB is a byte stream, WebSocket is message-framed, and
// websockify forwards TCP segments, which never align with protocol units.
// The server side needs the same stream-assembling trick to parse the
// client's messages, so both halves are exercised for real.
//
// One named test = one property (see AGENTS.md): PNG bytes, DES auth, auth
// rejection, timeout + hangup, unsupported encoding.

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { captureScreenshot, desVncResponse } from "../src/rfb.js";

const FB_W = 4;
const FB_H = 2;
const PASSWORD = "sesame";
const CHALLENGE = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i));
const TIMEOUT_MS = 3_000; // per-capture ceiling; tests that hang fail on this

/** Recognizable, position-derived pixels so a byte-level diff names the error. */
function pixel(x: number, y: number): [number, number, number] {
  return [16 + x * 32, 64 + y * 16, 128 + x * 8 + y * 4];
}

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

/** Minimal server-side byte-stream assembler over incoming WS binary messages. */
class TestReader {
  private buf = Buffer.alloc(0);
  private waiter: { n: number; resolve: (b: Buffer) => void } | null = null;

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const w = this.waiter;
    if (w && this.buf.length >= w.n) {
      const out = Buffer.from(this.buf.subarray(0, w.n));
      this.buf = this.buf.subarray(w.n);
      this.waiter = null;
      w.resolve(out);
    }
  }

  read(n: number): Promise<Buffer> {
    if (this.buf.length >= n) {
      const out = Buffer.from(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise((resolve) => {
      this.waiter = { n, resolve };
    });
  }
}

type Mode =
  | "none" // security None, one raw rect -> success
  | "auth" // ONLY security type 2, verify the DES response -> success
  | "auth-reject" // type 2, then SecurityResult != 0
  | "silent" // full handshake, then never send the update
  | "bad-encoding"; // update rect with a non-raw encoding

interface FakeVnc {
  port: number;
  stop(): void;
  state: {
    clientVersion: string;
    authResponse: Buffer | null;
    shared: number;
    closed: boolean;
  };
}

function startFakeVnc(mode: Mode): FakeVnc {
  const state = { clientVersion: "", authResponse: null as Buffer | null, shared: -1, closed: false };
  const reader = new TestReader();

  async function runFlow(ws: Bun.ServerWebSocket<undefined>): Promise<void> {
    // Everything we send is deliberately split 3 bytes at a time.
    const frag = (b: Buffer) => {
      for (let i = 0; i < b.length; i += 3) ws.send(b.subarray(i, i + 3));
    };
    const bail = (why: string): never => {
      throw new Error(`fake-vnc: ${why}`);
    };

    frag(Buffer.from("RFB 003.008\n", "latin1"));
    state.clientVersion = (await reader.read(12)).toString("latin1");
    if (!/^RFB 003\.00\d\n$/.test(state.clientVersion)) bail(`bad client version ${state.clientVersion}`);

    if (mode === "auth" || mode === "auth-reject") {
      frag(Buffer.from([1, 2])); // one security type: VNC Auth (2) ONLY
      if ((await reader.read(1))[0] !== 2) bail("client did not choose VNC Auth (2)");
      frag(CHALLENGE);
      state.authResponse = await reader.read(16);
      if (!state.authResponse.equals(desVncResponse(PASSWORD, CHALLENGE))) {
        bail("client DES response did not match desVncResponse(password, challenge)");
      }
      // SecurityResult: 0 = ok, nonzero = rejected
      frag(Buffer.from([0, 0, 0, mode === "auth-reject" ? 1 : 0]));
      if (mode === "auth-reject") return; // the client must give up here
    } else {
      frag(Buffer.from([1, 1])); // one security type: None (1)
      if ((await reader.read(1))[0] !== 1) bail("client did not choose None (1)");
      // No SecurityResult follows None in RFB 3.8.
    }

    state.shared = (await reader.read(1))[0];
    if (state.shared !== 1) bail(`ClientInit shared must be 1 (never kick the noVNC viewer), got ${state.shared}`);

    // ServerInit: 4x2, a pixel format the client must discard, name "fake".
    frag(Buffer.concat([
      Buffer.from([FB_W >> 8, FB_W & 0xff, FB_H >> 8, FB_H & 0xff]),
      Buffer.alloc(16, 0),
      Buffer.from([0, 0, 0, 4]),
      Buffer.from("fake"),
    ]));

    // SetPixelFormat must be the exact 20-byte 32bpp/depth-24/BE request.
    const spf = await reader.read(20);
    const wantSpf = Buffer.from([
      0, 0, 0, 0, 32, 24, 1, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
    ]);
    if (!spf.equals(wantSpf)) bail(`unexpected SetPixelFormat ${spf.toString("hex")}`);

    if ((await reader.read(1))[0] !== 2) bail("expected SetEncodings");
    const seRest = await reader.read(3); // pad + u16 count
    if (seRest.readUInt16BE(1) !== 1) bail("client must request exactly one encoding");
    if ((await reader.read(4)).readInt32BE(0) !== 0) bail("the one encoding must be raw (0)");

    const ur = await reader.read(10); // FramebufferUpdateRequest
    if (ur[0] !== 3 || ur[1] !== 0) bail("expected a non-incremental FramebufferUpdateRequest");
    if (ur.readUInt16BE(2) !== 0 || ur.readUInt16BE(4) !== 0) bail("the request must start at 0,0");
    if (ur.readUInt16BE(6) !== FB_W || ur.readUInt16BE(8) !== FB_H) bail("the request must cover the full screen");

    if (mode === "silent") return; // handshake complete; now hold our breath

    const header = Buffer.alloc(16);
    header.writeUInt16BE(1, 2); // one rect
    header.writeUInt16BE(FB_W, 8);
    header.writeUInt16BE(FB_H, 10);
    header.writeInt32BE(mode === "bad-encoding" ? 5 : 0, 12); // 5 = hextile: NOT raw
    frag(header);
    if (mode === "bad-encoding") return; // no pixel data after a rect we cannot honor

    // Pack per the format the client requested: BE u32, V = r<<16 | g<<8 | b.
    // V's top byte is always 0, so each pixel's wire bytes are [0, r, g, b].
    const data = Buffer.alloc(FB_W * FB_H * 4);
    for (let y = 0; y < FB_H; y++) {
      for (let x = 0; x < FB_W; x++) {
        const [r, g, b] = pixel(x, y);
        const p = (y * FB_W + x) * 4;
        data[p + 1] = r;
        data[p + 2] = g;
        data[p + 3] = b;
      }
    }
    frag(data);
  }

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return; // any path: websockify never routes
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      open: (ws) => {
        runFlow(ws).catch(() => {
          try { ws.close(); } catch { /* already gone */ }
        });
      },
      message: (_ws, msg) => reader.push(Buffer.from(msg as Buffer)),
      close: () => { state.closed = true; },
    },
  });

  return { port: server.port, stop: () => server.stop(true), state };
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
