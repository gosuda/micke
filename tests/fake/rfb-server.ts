// tests/fake/rfb-server.ts — the minimal RFB server shared by the fast tier.
//
// WHY shared: captureScreenshot's wire behavior must be identical whether
// the peer is a scenario fake (tests/rfb.test.ts: auth, silence, bad
// encoding) or the noVNC port of a fake session (tests/fake/rungv, which
// runs as a standalone bun process and imports this with a plain relative
// path). One implementation keeps both honest about the same protocol.
//
// Everything the server sends is deliberately fragmented (`fragmentSize`
// bytes per WS message): websockify forwards TCP segments, which never
// align with protocol units, so the client's stream assembler is exercised
// for real. The server side needs the same assembling trick to parse the
// client's messages — both halves run for real here.

import { desVncResponse } from "../../src/rfb.js";

export type RfbMode =
  | "none" // security None, one raw rect → success
  | "auth" // ONLY security type 2, verify the DES response → success
  | "auth-reject" // type 2, then SecurityResult != 0
  | "silent" // full handshake, then never send the update
  | "bad-encoding" // update rect with a non-raw encoding
  | "drop"; // accept the WS upgrade, then die before any RFB bytes

/** Recognizable, position-derived pixels so a byte-level diff names the error. */
export function rfbPixel(x: number, y: number): [number, number, number] {
  return [16 + x * 32, 64 + y * 16, 128 + x * 8 + y * 4];
}

export interface FakeRfbOptions {
  /** Scenario (default "none" — how x11vnc runs without MICKE_VNC_PASSWORD). */
  mode?: RfbMode;
  /** Framebuffer ServerInit announces (defaults 4x2: small is the point). */
  width?: number;
  height?: number;
  /** Framebuffer contents (default rfbPixel). */
  pixel?: (x: number, y: number) => [number, number, number];
  /** What the auth modes expect (default "sesame"). */
  password?: string;
  /** The 16 bytes the auth modes challenge with. */
  challenge?: Buffer;
  /** Server-send WS message size — the fragmentation being tested (default 3). */
  fragmentSize?: number;
  /** Hold the conversation open this long before the frame (default 0). Gives
   * concurrency tests an overlap window worth observing. */
  captureDelayMs?: number;
  hostname?: string; // default "127.0.0.1"
  port?: number; // default 0 (kernel-picked)
  /** Plain-HTTP requests (no Upgrade header); default 426 websocket-only. */
  http?: (req: Request) => Response;
  /** Capture bookkeeping for the surrounding process (e.g. JSONL logging). */
  onEvent?: (ev: { type: "capture_open" | "capture_close"; inFlight: number }) => void;
}

export interface FakeRfbState {
  clientVersion: string;
  authResponse: Buffer | null;
  shared: number;
  closed: boolean;
  /** Conversations started (WS upgrades), and how many overlapped. */
  captures: number;
  inFlight: number;
  maxInFlight: number;
}

export interface FakeRfbServer {
  port: number;
  stop(): void;
  state: FakeRfbState;
}

/** Server-side byte-stream assembler over incoming WS binary messages. */
class WsReader {
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

export function startFakeRfbServer(opts: FakeRfbOptions = {}): FakeRfbServer {
  const mode = opts.mode ?? "none";
  const width = opts.width ?? 4;
  const height = opts.height ?? 2;
  const pixel = opts.pixel ?? rfbPixel;
  const password = opts.password ?? "sesame";
  const challenge = opts.challenge ?? Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i));
  const fragSize = opts.fragmentSize ?? 3;
  const delayMs = opts.captureDelayMs ?? 0;
  const state: FakeRfbState = {
    clientVersion: "",
    authResponse: null,
    shared: -1,
    closed: false,
    captures: 0,
    inFlight: 0,
    maxInFlight: 0,
  };

  async function converse(ws: Bun.ServerWebSocket<WsReader>): Promise<void> {
    const reader = ws.data;
    // Everything we send is deliberately split `fragSize` bytes at a time.
    const frag = (b: Buffer) => {
      for (let i = 0; i < b.length; i += fragSize) ws.send(b.subarray(i, i + fragSize));
    };
    const bail = (why: string): never => {
      throw new Error(`fake-vnc: ${why}`);
    };

    if (mode === "drop") {
      // A noVNC that is half-dead: the upgrade succeeds, then the socket goes
      // away before a single RFB byte. The client must fail FAST with a
      // step-named error — no 5 s timeout round-trip.
      ws.close();
      return;
    }

    frag(Buffer.from("RFB 003.008\n", "latin1"));
    state.clientVersion = (await reader.read(12)).toString("latin1");
    if (!/^RFB 003\.00\d\n$/.test(state.clientVersion)) bail(`bad client version ${state.clientVersion}`);

    if (mode === "auth" || mode === "auth-reject") {
      frag(Buffer.from([1, 2])); // one security type: VNC Auth (2) ONLY
      if ((await reader.read(1))[0] !== 2) bail("client did not choose VNC Auth (2)");
      frag(challenge);
      state.authResponse = await reader.read(16);
      if (!state.authResponse.equals(desVncResponse(password, challenge))) {
        bail("client DES response did not match desVncResponse(password, challenge)");
      }
      // SecurityResult: 0 = ok, nonzero = rejected
      frag(Buffer.from([0, 0, 0, mode === "auth-reject" ? 1 : 0]));
      if (mode === "auth-reject") return; // the client must give up here
    } else {
      frag(Buffer.from([1, 1])); // one security type: None (1)
      if ((await reader.read(1))[0] !== 1) bail("client did not choose None (1)");
      // RFC 6143: RFB 3.8 sends a SecurityResult u32 for EVERY security
      // type, None included — real x11vnc answers the None selection with
      // 00 00 00 00 before ServerInit.
      frag(Buffer.from([0, 0, 0, 0]));
    }

    state.shared = (await reader.read(1))[0];
    if (state.shared !== 1) bail(`ClientInit shared must be 1 (never kick the noVNC viewer), got ${state.shared}`);

    // ServerInit: the announced framebuffer, a pixel format the client must
    // discard, name "fake".
    frag(Buffer.concat([
      Buffer.from([width >> 8, width & 0xff, height >> 8, height & 0xff]),
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
    if (ur.readUInt16BE(6) !== width || ur.readUInt16BE(8) !== height) {
      bail("the request must cover the full screen");
    }

    if (mode === "silent") return; // handshake complete; now hold our breath
    if (delayMs > 0) await Bun.sleep(delayMs); // simulated frame-grab time

    const header = Buffer.alloc(16);
    header.writeUInt16BE(1, 2); // one rect
    header.writeUInt16BE(width, 8);
    header.writeUInt16BE(height, 10);
    header.writeInt32BE(mode === "bad-encoding" ? 5 : 0, 12); // 5 = hextile: NOT raw
    frag(header);
    if (mode === "bad-encoding") return; // no pixel data after a rect we cannot honor

    // Pack per the format the client requested: BE u32, V = r<<16 | g<<8 | b.
    // V's top byte is always 0, so each pixel's wire bytes are [0, r, g, b].
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixel(x, y);
        const p = (y * width + x) * 4;
        data[p + 1] = r;
        data[p + 2] = g;
        data[p + 3] = b;
      }
    }
    frag(data);
  }

  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      // Upgrade ANY path: websockify never routes, and both the daemon's
      // screenshot client (/websockify) and noVNC's own page hit this.
      if (srv.upgrade(req, { data: new WsReader() })) return;
      return (opts.http ?? (() => new Response("websocket only", { status: 426 })))(req);
    },
    websocket: {
      open: (ws) => {
        state.captures += 1;
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        opts.onEvent?.({ type: "capture_open", inFlight: state.inFlight });
        converse(ws).catch(() => {
          try { ws.close(); } catch { /* already gone */ }
        });
      },
      message: (ws, msg) => ws.data.push(Buffer.from(msg as Buffer)),
      close: () => {
        state.closed = true;
        state.inFlight -= 1;
        opts.onEvent?.({ type: "capture_close", inFlight: state.inFlight });
      },
    },
  });

  return { port: server.port, stop: () => server.stop(true), state };
}
