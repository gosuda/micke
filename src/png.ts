// png — a minimal, dependency-free PNG encoder.
//
// Why hand-rolled: the only PNG micke produces is the full-desktop RGB frame
// from the RFB client (src/rfb.ts), and a codec dependency for that one call
// is not worth the supply chain. The output is a minimal correct file:
// signature, IHDR (8-bit truecolor, color type 2), ONE IDAT holding the
// filter-0 scanlines, IEND. Every scanline uses filter "None": desktop pixels
// are photographic, Sub/Up gain little there, and skipping the filter logic
// keeps this branch-free and obviously correct.

import { deflateSync } from "node:zlib";

// Standard CRC-32 (IEEE 802.3), table-driven. PNG chunks end with the CRC of
// type+data; zlib does not compute it for us.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: u32 BE length, 4-char type, data, u32 BE CRC of type+data. */
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode `rgb` (row-major, 3 bytes/pixel) as a 24-bit PNG. Decodes in any
 * standard tool; the caller owns dimension agreement (`rgb.length` must be
 * exactly width*height*3 — anything else is a caller bug we refuse to encode).
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) {
    throw new Error(`png: expected ${width}x${height}x3 = ${width * height * 3} rgb bytes, got ${rgb.length}`);
  }
  const stride = width * 3;
  // Pre-deflate payload: per scanline one filter byte 0 (None) + the row's RGB.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // [10] compression 0, [11] filter 0, [12] interlace 0 — zero-allocated.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
