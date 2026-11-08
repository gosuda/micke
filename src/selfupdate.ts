// selfupdate — `micke upgrade`: replace the running micke binary in place.
//
// The upgrade story: resolve the latest release (a /releases/latest request
// whose redirect Location names the tag), download the release's SHA256SUMS
// and the new binary, verify the digest, swap the binary atomically, then
// bounce the service so the daemon comes back on the new build. Re-running
// with an explicit tag — even the current one — is the repair path for a
// broken install, so same-tag reinstall is allowed.
//
// Trust model: the checksum travels with the release (same origin), so this
// guards against corruption and partial downloads, NOT against a compromised
// publisher — the same deal as the rungv self-provisioning in rungvinstall.ts.
//
// Swap mechanics: on unix the candidate lands in the SAME directory as the
// running binary and is renamed over it — a same-dir rename is atomic and
// never crosses a filesystem, so no observer sees a half-written micke. On
// Windows a running exe may be renamed but not overwritten, so the old
// binary dances aside first: exe → exe.old, then candidate → exe.
//
// The post-swap service bounce is best-effort and lossless: rungv child
// sandboxes keep running through it and the next daemon adopts them from
// their pidfiles, so an upgrade never costs a session.

import { chmodSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseSums, sha256File } from "./release.js";
import { serviceRestart } from "./service.js";
import { MICKE_VERSION } from "./version.js";

export const MICKE_RELEASE_BASE = "https://github.com/gosuda/micke/releases";

/** Mirrors MICKE_RUNGV_RELEASE_BASE: point micke at a mirror or a test server. */
function base(): string {
  return process.env.MICKE_RELEASE_BASE || MICKE_RELEASE_BASE;
}

/**
 * Release asset for a platform, or null when micke publishes none. Assets are
 * RAW single-file binaries — the whole app is one executable, no archive.
 * NB: no darwin-amd64, the same exclusion as the rungv asset map in
 * rungvinstall.ts: gvx publishes no darwin-amd64 release for micke to run
 * underneath it.
 */
export function assetNameFor(platform: string, arch: string, tag: string): string | null {
  const p = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const a = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!p || !a) return null;
  if (p === "darwin" && a === "amd64") return null; // no such asset
  return `micke-${tag}-${p}-${a}${p === "windows" ? ".exe" : ""}`;
}

/**
 * The latest release tag, via GitHub's /releases/latest redirect: its
 * Location header is <base>/tag/<tag>, so the last path segment IS the tag —
 * no second API round-trip, no JSON to parse.
 */
export async function latestTag(): Promise<string> {
  const url = `${base()}/releases/latest`;
  const res = await fetch(url, { redirect: "manual" });
  if (res.status === 404) {
    throw new Error(`no micke releases published yet (HTTP 404 from ${url})`);
  }
  if (res.status < 300 || res.status > 399) {
    throw new Error(`expected /releases/latest to redirect, got HTTP ${res.status} (${url})`);
  }
  const location = res.headers.get("location");
  if (!location) {
    throw new Error(`/releases/latest redirected (HTTP ${res.status}) without a Location header`);
  }
  const tag = location.replace(/\/+$/, "").split("/").filter(Boolean).pop();
  if (!tag) {
    throw new Error(`no tag in the /releases/latest redirect (HTTP ${res.status}): ${location}`);
  }
  return tag;
}

export interface UpgradeResult {
  from: string;
  to: string;
  path: string;
  restarted: boolean;
}

/**
 * The binary being upgraded. Throws under bun (the dev tree): swapping
 * ~/.bun/bin/bun would corrupt the toolchain, not update micke. Remedy: use
 * the install command in the README, then `micke upgrade` from that binary.
 */
function requireCompiled(): string {
  const exe = process.execPath;
  if (!basename(exe).toLowerCase().startsWith("micke")) {
    throw new Error(
      `self-update needs the compiled micke binary, not the dev tree (running from ${exe}). ` +
        "Use the install command in the README, then run `micke upgrade` from the installed binary.",
    );
  }
  return exe;
}

/** Download, verify and atomically swap release `tag` over the running binary. */
export async function performUpgrade(
  opts: { tag?: string; currentPath?: string; restart?: () => void } = {},
): Promise<UpgradeResult> {
  const to = opts.tag ?? await latestTag();
  const current = opts.currentPath ?? requireCompiled();

  const asset = assetNameFor(process.platform, process.arch, to);
  if (!asset) {
    throw new Error(`micke publishes no release binary for ${process.platform}/${process.arch} (tag ${to})`);
  }

  // Beside the target, so the final rename never crosses a filesystem (unix)
  // and the two-step Windows dance stays within one directory.
  const candidate = join(dirname(current), `.micke-${to}.new${process.platform === "win32" ? ".exe" : ""}`);
  try {
    // 1. Checksums first: know the expected digest before the bits land.
    const sumsUrl = `${base()}/download/${to}/SHA256SUMS`;
    const sumsRes = await fetch(sumsUrl);
    if (!sumsRes.ok) throw new Error(`fetching SHA256SUMS failed: HTTP ${sumsRes.status} (${sumsUrl})`);
    const expected = parseSums(await sumsRes.text()).get(asset);
    if (!expected) throw new Error(`SHA256SUMS for ${to} has no entry for ${asset}`);

    // 2. The binary itself.
    const assetUrl = `${base()}/download/${to}/${asset}`;
    const assetRes = await fetch(assetUrl);
    if (!assetRes.ok) throw new Error(`downloading ${asset} failed: HTTP ${assetRes.status}`);
    await Bun.write(candidate, assetRes);

    // 3. Verify against the release's own sums file.
    const got = await sha256File(candidate);
    if (got !== expected) {
      throw new Error(`sha256 mismatch for ${asset}: got ${got}, SHA256SUMS says ${expected}`);
    }
    chmodSync(candidate, 0o755);

    // 4. Swap in (see the swap-mechanics note in the header).
    if (process.platform === "win32") {
      try { rmSync(`${current}.old`, { force: true }); } catch { /* stale .old from a prior upgrade */ }
      try { renameSync(current, `${current}.old`); } catch { /* best-effort */ }
      renameSync(candidate, current);
    } else {
      renameSync(candidate, current); // same-dir rename: atomic replace
    }
  } finally {
    // Any failure after the candidate landed must leave no `.micke-*.new`
    // residue; after a successful swap there is nothing left at that path.
    try { rmSync(candidate, { force: true }); } catch { /* best-effort */ }
  }

  // 5. Bounce the daemon, best-effort: the binary is already swapped, so an
  // unregistered host (or a failed bounce) must not fail the upgrade. The
  // opts.restart seam exists so tests never bounce a REAL registration — a
  // dev host can carry its own ~/.config/systemd/user/micke.service.
  let restarted = false;
  const restart = opts.restart ?? serviceRestart;
  try {
    restart();
    restarted = true;
  } catch {
    restarted = false;
  }

  return { from: MICKE_VERSION, to, path: current, restarted };
}
