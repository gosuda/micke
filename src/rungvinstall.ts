// rungvinstall — self-provision the `rungv` binary into micke's cache.
//
// gvx publishes release archives on GitHub (linux/darwin/windows × amd64/arm64,
// plus a SHA256SUMS file and a sigstore provenance bundle). When a host has no
// rungv at all — no MICKE_RUNGV, nothing on PATH — micke downloads the pinned
// release, verifies the archive against its SHA256SUMS entry, extracts just
// the binary and installs it as
//   <MICKE_RUNGV_DIR>/rungv-<tag>/rungv(.exe)
// The version is PINNED in gvxio (RUNGV_DEFAULT_VERSION), never "latest": gvx
// releases move daily and its on-disk formats have broken across tags before.
//
// Trust model: see release.ts — the checksum guards corruption, not a
// compromised publisher. Environments that care install rungv themselves —
// an explicit MICKE_RUNGV or a PATH binary always wins, and
// MICKE_RUNGV_AUTO_DOWNLOAD=0 turns this path off entirely.
//
// Every failure cleans up its temp files and throws a plain Error; the
// supervisor wraps it into MickeError("RUNGV_INSTALL_FAILED", …) with the
// manual-install remedy.

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { managedRungvPath, rungvBinDir, rungvBinaryName, rungvVersion } from "./gvxio.js";
import { parseSums, sha256File } from "./release.js";

export const GVX_RELEASE_BASE = "https://github.com/gfire-sigs/gvx/releases";

function releaseBase(): string {
  return process.env.MICKE_RUNGV_RELEASE_BASE || GVX_RELEASE_BASE;
}

/**
 * Release asset for a platform, or null when gvx publishes none. Archive
 * layout is `rungv-<tag>-<platform>/rungv(.exe)` plus license files.
 * NB: gvx ships no darwin-amd64 archive (Apple Silicon only) — and micke
 * mirrors the exclusion for its own binaries (selfupdate.ts,
 * scripts/build.ts): there is no gvx release for a darwin-amd64 micke to
 * run underneath, so micke publishes none either.
 */
export function assetNameFor(platform: string, arch: string, tag: string): string | null {
  const p = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const a = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!p || !a) return null;
  if (p === "darwin" && a === "amd64") return null; // no such asset
  const ext = p === "windows" ? "zip" : "tar.gz";
  return `rungv-${tag}-${p}-${a}.${ext}`;
}

/** Await a child process; returns {rc, stderr} (tar/powershell extract). */
async function run(cmd: string[], timeoutMs = 120_000): Promise<{ rc: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stderr = await new Response(proc.stderr).text();
  const rc = await proc.exited;
  clearTimeout(timer);
  return { rc, stderr };
}

/** tar -x for both layouts: GNU tar reads tar.gz, bsdtar (Windows) reads zip. */
async function extract(archive: string, dir: string): Promise<void> {
  const flags = archive.endsWith(".zip") ? ["-xf"] : ["-xzf"];
  let r = await run(["tar", ...flags, archive, "-C", dir]);
  if (r.rc === 0) return;
  // Windows without bsdtar: PowerShell is always there.
  if (process.platform === "win32" && archive.endsWith(".zip")) {
    r = await run(
      ["powershell", "-NoProfile", "-Command", "Expand-Archive", "-Force", archive, dir],
    );
    if (r.rc === 0) return;
  }
  throw new Error(`extraction failed (rc=${r.rc}): ${r.stderr.trim().slice(0, 300)}`);
}

/** First file named `name` anywhere under `dir` (archives nest one level). */
function findBinary(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findBinary(path, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

/**
 * Download + verify + install the pinned rungv into the managed bin dir.
 * Returns the installed binary path. Idempotent-fast: an existing managed
 * copy is returned as-is (callers only invoke this when it is absent).
 */
export async function installManagedRungv(): Promise<string> {
  const tag = rungvVersion();
  const binDir = rungvBinDir();
  const target = managedRungvPath();
  try {
    if (statSync(target).isFile()) return target; // concurrent retry landed first
  } catch { /* not installed yet — this is the normal path */ }

  const asset = assetNameFor(process.platform, process.arch, tag);
  if (!asset) {
    throw new Error(
      `gvx publishes no release archive for ${process.platform}/${process.arch} (tag ${tag})`,
    );
  }

  mkdirSync(binDir, { recursive: true });
  const work = mkdtempSync(join(binDir, ".install-")); // same filesystem → atomic rename
  try {
    // 1. Checksums first: know the expected digest before the archive lands.
    const sumsUrl = `${releaseBase()}/download/${tag}/SHA256SUMS`;
    const sumsRes = await fetch(sumsUrl);
    if (!sumsRes.ok) throw new Error(`fetching SHA256SUMS failed: HTTP ${sumsRes.status} (${sumsUrl})`);
    const expected = parseSums(await sumsRes.text()).get(asset);
    if (!expected) throw new Error(`SHA256SUMS for ${tag} has no entry for ${asset}`);

    // 2. Archive.
    const assetUrl = `${releaseBase()}/download/${tag}/${asset}`;
    const assetRes = await fetch(assetUrl);
    if (!assetRes.ok) throw new Error(`downloading ${asset} failed: HTTP ${assetRes.status}`);
    const archive = join(work, asset);
    await Bun.write(archive, assetRes);

    // 3. Verify against the release's own sums file.
    const got = await sha256File(archive);
    if (got !== expected) {
      throw new Error(`sha256 mismatch for ${asset}: got ${got}, SHA256SUMS says ${expected}`);
    }

    // 4. Extract, locate the binary, install it atomically.
    const xdir = join(work, "x");
    mkdirSync(xdir);
    await extract(archive, xdir);
    const src = findBinary(xdir, rungvBinaryName());
    if (!src) throw new Error(`no ${rungvBinaryName()} inside ${asset}`);
    mkdirSync(join(binDir, `rungv-${tag}`), { recursive: true });
    renameSync(src, target); // same-tree rename: replaces any broken remnant atomically
    try { chmodSync(target, 0o755); } catch { /* Windows: exec bit is not a thing */ }

    // 5. Smoke-test the exact binary we installed.
    const smoke = await run([target, "version"], 30_000);
    if (smoke.rc !== 0) {
      try { rmSync(join(binDir, `rungv-${tag}`), { recursive: true, force: true }); } catch { /* keep going */ }
      throw new Error(`installed rungv failed \`version\` (rc=${smoke.rc}): ${smoke.stderr.trim().slice(0, 300)}`);
    }
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
