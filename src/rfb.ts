// rfb — capture a full-desktop screenshot by speaking RFB (VNC) THROUGH the
// session's websockify proxy.
//
// Every micke session already publishes exactly one loopback port for the
// desktop: websockify on the host, bridging WebSocket to the guest's x11vnc
// (:5900). A screenshot therefore needs NO new host port and NO image change:
// we open one more WebSocket to the same proxy a browser's noVNC page uses.
// x11vnc runs -shared, so a second client is always welcome — and we still
// send ClientInit shared=1 below so WE never kick the human's viewer.
//
// The mismatch this file lives around: RFB is a byte-STREAM protocol, but
// WebSocket is message-framed, and websockify promises nothing about framing —
// in practice it forwards TCP segments, so one RFB unit may arrive split
// across WS messages and several units may arrive merged into one. Everything
// below therefore reads through WsRfbStream, which reassembles the message
// stream into a byte stream with readExact(n); no protocol unit is ever
// assumed to align with a WS message.

import { createCipheriv } from "node:crypto";
import { encodePng } from "./png.js";

export interface Screenshot {
  png: Uint8Array;
  width: number;
  height: number;
}

export const DEFAULT_RFB_TIMEOUT_MS = 5_000;

/**
 * Assemble WS messages back into the RFB byte stream. Reads are sequential
 * (the protocol is strictly request/response), so ONE waiter slot suffices;
 * close/error/timeout fail the stream once and reject whatever is pending.
 */
class WsRfbStream {
  /**
   * The protocol step a read is currently waiting for — only used to make the
   * timeout/close errors name where the conversation died.
   */
  step = "the WebSocket connect";

  private ws: WebSocket | null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private dead: Error | null = null;
  private openSettled = false;
  readonly opened: Promise<void>;
  private resolveOpen!: () => void;
  private rejectOpen!: (e: Error) => void;

  constructor(url: string) {
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    // Belt for the case where open() fails and nobody is awaiting yet.
    this.opened.catch(() => {});
    const ws = new WebSocket(url);
    this.ws = ws;
    // "arraybuffer" is Bun's default for binary frames, but the handler below
    // coerces every binary shape (ArrayBuffer, Buffer, Uint8Array view) to
    // bytes, so a runtime/driver delivering "nodebuffer" works too.
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.openSettled = true;
      this.resolveOpen();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => this.fail(new Error(`rfb: connection closed while waiting for ${this.step}`));
    ws.onerror = () => this.fail(new Error(`rfb: WebSocket error while waiting for ${this.step}`));
  }

  private onMessage(data: unknown): void {
    if (this.dead) return;
    if (typeof data === "string") {
      this.fail(new Error(`rfb: got a text WebSocket frame during ${this.step}; websockify must carry binary`));
      return;
    }
    // Copy defensively: the runtime owns the delivery buffer and may reuse it.
    const chunk = data instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(data))
      : Buffer.from(new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength));
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.pump();
  }

  private pump(): void {
    const w = this.waiter;
    if (!w || this.buffered < w.n) return;
    this.waiter = null;
    w.resolve(this.take(w.n));
  }

  /** Remove exactly n bytes from the chunk queue (linear; no re-concat). */
  private take(n: number): Buffer {
    const out = Buffer.alloc(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0];
      const need = n - filled;
      if (c.length <= need) {
        out.set(c, filled);
        filled += c.length;
        this.chunks.shift();
      } else {
        out.set(c.subarray(0, need), filled);
        this.chunks[0] = c.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** Read exactly n bytes, accumulating across however many WS messages that takes. */
  async readExact(n: number, step: string): Promise<Buffer> {
    if (this.dead) throw this.dead;
    this.step = step;
    if (this.buffered >= n) return this.take(n);
    return new Promise<Buffer>((resolve, reject) => {
      this.waiter = { n, resolve, reject };
    });
  }

  send(bytes: Uint8Array): void {
    if (this.dead || !this.ws) throw new Error(`rfb: cannot send during ${this.step}: connection is closed`);
    this.ws.send(bytes);
  }

  /** Fail every pending wait with a named error and drop the socket. Idempotent. */
  fail(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    const w = this.waiter;
    this.waiter = null;
    if (!this.openSettled) {
      this.openSettled = true;
      this.rejectOpen(err);
    }
    w?.reject(err);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already gone */ }
  }

  /** Quiet teardown for the success path (or finally): settles nothing, never errors. */
  close(): void {
    // Mark dead BEFORE closing so our own onclose (fired asynchronously) finds
    // the guard set and cannot fabricate a failure after a clean capture.
    this.dead ??= new Error(`rfb: connection closed after ${this.step}`);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already gone */ }
  }
}

// ---- VNC auth (DES challenge-response) ---------------------------------------
//
// Classic VNC auth is DES-ECB over the 16-byte challenge with a key derived
// from the password in the most awkward way imaginable: truncate/pad to 8 NUL
// bytes, then bit-reverse EVERY key byte, because VNC feeds the key to DES
// LSB-first while the cipher (and node:crypto) wants it MSB-first.

function bitReverse(b: number): number {
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
  b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
  return b >>> 0;
}

/** The 16-byte VNC auth response for a password + server challenge. */
export function desVncResponse(password: string, challenge: Uint8Array): Uint8Array {
  if (challenge.length !== 16) {
    throw new Error(`rfb: VNC auth challenge must be 16 bytes, got ${challenge.length}`);
  }
  const key = Buffer.alloc(8, 0); // password truncated/padded to 8 NUL bytes
  key.set(Buffer.from(password, "latin1").subarray(0, 8));
  for (let i = 0; i < 8; i++) key[i] = bitReverse(key[i]);
  const cipher = createCipheriv("des-ecb", key, null);
  cipher.setAutoPadding(false); // the challenge is exactly two ECB blocks
  return Buffer.concat([cipher.update(Buffer.from(challenge)), cipher.final()]);
}

// SetPixelFormat: 32bpp / depth 24 / true-colour / max 255 / shifts
// r=16 g=8 b=0 / big-endian. With those shifts the pixel value is
// V = r<<16 | g<<8 | b (V>>24 is always 0), so big-endian makes each pixel
// arrive as bytes [0, r, g, b] — the channels land on fixed byte offsets and
// the extraction below is a plain shift of the assembled u32. The client must
// re-send this even though ServerInit
// carries a format, because we do NOT support whatever the server defaults to.
const SET_PIXEL_FORMAT = Buffer.from([
  0, // message type: SetPixelFormat
  0, 0, 0, // padding
  32, 24, // bits-per-pixel, depth
  1, // big-endian-flag
  1, // true-colour-flag
  0, 255, 0, 255, 0, 255, // red/green/blue max
  16, 8, 0, // red/green/blue shift
  0, 0, 0, // padding
]);

const SET_ENCODINGS_RAW = Buffer.from([
  2, // message type: SetEncodings
  0, // padding
  0, 1, // one encoding
  0, 0, 0, 0, // raw (0) — the only encoding this client can decode
]);

/** Read the security-type list (RFB 3.8 form). count 0 = refusal + reason. */
async function readSecurityTypes(s: WsRfbStream): Promise<number[]> {
  const count = (await s.readExact(1, "the security-type list"))[0];
  if (count === 0) {
    const len = (await s.readExact(4, "the auth failure reason")).readUInt32BE(0);
    const reason = len
      ? (await s.readExact(len, "the auth failure reason")).toString("utf8")
      : "";
    throw new Error(`rfb: server refused the connection: ${reason || "(no reason given)"}`);
  }
  return Array.from(await s.readExact(count, "the security-type list"));
}

/**
 * Read up to the framebuffer-update header (type 0 + pad + u16 nrects),
 * skipping the two harmless asynchronous server messages x11vnc can emit
 * mid-conversation: Bell (desktop beep) and ServerCutText (clipboard sync).
 */
async function readUpdateHeader(s: WsRfbStream): Promise<number> {
  for (;;) {
    const type = (await s.readExact(1, "the framebuffer update header"))[0];
    if (type === 0) {
      const rest = await s.readExact(3, "the framebuffer update header");
      return rest.readUInt16BE(1);
    }
    if (type === 2) continue; // Bell: 1 byte total
    if (type === 3) {
      const h = await s.readExact(7, "a ServerCutText header");
      const len = h.readUInt32BE(3);
      if (len > 0) await s.readExact(len, "the ServerCutText text");
      continue;
    }
    throw new Error(`rfb: unexpected message type ${type} while waiting for the framebuffer update (want 0)`);
  }
}

/**
 * Capture one full screenshot from the session's websockify port (the same
 * port noVNC's page uses; connect to `ws://127.0.0.1:<port>/websockify`).
 * `password` empty/absent means security type None — which is exactly how
 * x11vnc runs when MICKE_VNC_PASSWORD is unset (-nopw).
 */
export async function captureScreenshot(
  port: number,
  password?: string,
  timeoutMs: number = DEFAULT_RFB_TIMEOUT_MS,
): Promise<Screenshot> {
  const stream = new WsRfbStream(`ws://127.0.0.1:${port}/websockify`);
  const timer = setTimeout(
    () => stream.fail(new Error(`rfb: timed out after ${timeoutMs}ms while waiting for ${stream.step}`)),
    timeoutMs,
  );
  try {
    await stream.opened;

    // -- Version handshake ---------------------------------------------------
    // Any 003.00x the server sends interoperates with an 008 client, so we
    // tolerate all of them but always answer with exactly "RFB 003.008\n".
    const version = (await stream.readExact(12, "the RFB version handshake")).toString("latin1");
    if (!/^RFB 003\.00\d\n$/.test(version)) {
      throw new Error(`rfb: bad version handshake ${JSON.stringify(version)}`);
    }
    stream.send(Buffer.from("RFB 003.008\n", "latin1"));

    // -- Security (RFB 3.8 list form) -----------------------------------------
    const types = await readSecurityTypes(stream);
    const useVncAuth = !!password && types.includes(2);
    if (!useVncAuth && !types.includes(1)) {
      if (types.includes(2)) {
        throw new Error("rfb: the server requires VNC auth but no password was given (set MICKE_VNC_PASSWORD)");
      }
      throw new Error(`rfb: server offered no supported security type: [${types.join(", ")}] (want None=1 or VNC Auth=2)`);
    }
    stream.send(Buffer.from([useVncAuth ? 2 : 1]));
    if (useVncAuth) {
      const challenge = await stream.readExact(16, "the VNC-auth challenge");
      stream.send(desVncResponse(password!, challenge));
      const result = (await stream.readExact(4, "the VNC-auth result")).readUInt32BE(0);
      if (result !== 0) throw new Error(`rfb: VNC authentication rejected by the server (result ${result})`);
    }
    // Security type None in RFB 3.8 sends NO SecurityResult — reading a u32
    // here would eat the first ServerInit byte. (3.3 always sends one; we
    // never speak 3.3.)

    // -- ClientInit ------------------------------------------------------------
    // shared=1: join the desktop WITHOUT disconnecting whoever is already
    // viewing it. The human's noVNC tab must survive every screenshot.
    stream.send(Buffer.from([1]));

    // -- ServerInit --------------------------------------------------------------
    const si = await stream.readExact(24, "ServerInit"); // w, h, 16B format, u32 name len
    const width = si.readUInt16BE(0);
    const height = si.readUInt16BE(2);
    const nameLen = si.readUInt32BE(20);
    if (nameLen > 0) await stream.readExact(nameLen, "the ServerInit name"); // discarded
    if (width === 0 || height === 0) {
      throw new Error(`rfb: ServerInit reported a ${width}x${height} framebuffer`);
    }

    // -- Ask for one full raw frame ---------------------------------------------
    stream.send(SET_PIXEL_FORMAT);
    stream.send(SET_ENCODINGS_RAW);
    stream.send(Buffer.from([
      3, // message type: FramebufferUpdateRequest
      0, // incremental = 0: send the FULL frame, not a diff against a buffer we never filled
      0, 0, 0, 0, // x = 0, y = 0
      width >> 8, width & 0xff, height >> 8, height & 0xff,
    ]));

    const nrects = await readUpdateHeader(stream);
    if (nrects === 0) {
      throw new Error("rfb: server answered the full-frame request with an empty update (0 rects)");
    }
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < nrects; i++) {
      const rh = await stream.readExact(12, `rect ${i + 1}/${nrects} of the framebuffer update`);
      const x = rh.readUInt16BE(0);
      const y = rh.readUInt16BE(2);
      const w = rh.readUInt16BE(4);
      const h = rh.readUInt16BE(6);
      const encoding = rh.readInt32BE(8);
      if (encoding !== 0) {
        throw new Error(`rfb: server sent encoding ${encoding} for update rect ${i + 1} (${w}x${h}@${x},${y}); only raw (0) is supported`);
      }
      if (x + w > width || y + h > height) {
        throw new Error(`rfb: update rect ${i + 1} (${w}x${h}@${x},${y}) falls outside the ${width}x${height} framebuffer`);
      }
      const data = await stream.readExact(w * h * 4, `rect ${i + 1}/${nrects} raw bytes`);
      // Composite at (x,y): servers may tile the screen into several rects.
      // Channels per the format WE requested: BE u32, r<<16 | g<<8 | b.
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const p = (row * w + col) * 4;
          const px = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
          const o = ((y + row) * width + (x + col)) * 3;
          rgb[o] = (px >> 16) & 0xff;
          rgb[o + 1] = (px >> 8) & 0xff;
          rgb[o + 2] = px & 0xff;
        }
      }
    }

    return { png: encodePng(width, height, rgb), width, height };
  } finally {
    // ALWAYS: the deadline covers connect..capture, and even a failed capture
    // leaves no dangling WS against the session's proxy.
    clearTimeout(timer);
    stream.close();
  }
}
