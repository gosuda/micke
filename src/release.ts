// release — shared GitHub-release download plumbing.
//
// WHY this module exists: both the rungv self-provisioning (rungvinstall.ts)
// and micke's own self-update (selfupdate, a later unit) download artifacts
// from GitHub releases and must verify them the same way, so the helpers live
// here once instead of drifting in two places.
//
// Trust model: the checksum travels with the release (same origin), so this
// guards against corruption and partial downloads, NOT against a compromised
// publisher. Environments that care pin or audit releases themselves.

/** One SHA256SUMS line: `<hex>  <filename>` → Map<filename, hex>. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** Hex sha256 of a file, streamed (archives are ~27 MB). */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}
