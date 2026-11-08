// scripts/build — cross-compile every release asset from one host + sums.
//
// WHY a matrix in a script instead of a CI matrix job per target: bun's
// --compile cross-compiles the five release platforms on one linux runner
// (verified with bun 1.4.4: bun-linux-x64, bun-linux-arm64, bun-darwin-arm64,
// bun-windows-x64, bun-windows-arm64 — all five build; none dropped), so one
// job produces the whole release in one pass and SHA256SUMS covers exactly
// the files this run built. A CI matrix would need a merge job to assemble
// consistent sums for `gh release create dist/*`.
//
// The asset names are not free text: `micke upgrade` (src/selfupdate.ts
// assetNameFor) downloads files by these exact names, so the script asserts
// every produced filename against that function and fails the build on drift
// — shipping a name the updater can't find is a broken release. Any compile
// failure also exits nonzero naming the target: CI must go red rather than
// silently publish a release with a missing asset.
//
// The current platform's binary is smoke-run (`<binary> version` must print
// the tag) before sums are written: a binary that compiles but doesn't start
// is the classic cross-compile footgun, and this host can at least prove the
// one platform it can execute.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256File } from "../src/release.js";
import { assetNameFor } from "../src/selfupdate.js";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "cli.ts");
const DIST = join(ROOT, "dist");

/** One release target: bun's --target triple and the asset name it ships as. */
interface Target {
  bun: string;
  platform: "linux" | "darwin" | "windows";
  arch: "amd64" | "arm64";
  /** process.platform spelling assetNameFor speaks. */
  nodePlatform: "linux" | "darwin" | "win32";
}

const TARGETS: Target[] = [
  { bun: "bun-linux-x64", platform: "linux", arch: "amd64", nodePlatform: "linux" },
  { bun: "bun-linux-arm64", platform: "linux", arch: "arm64", nodePlatform: "linux" },
  { bun: "bun-darwin-arm64", platform: "darwin", arch: "arm64", nodePlatform: "darwin" },
  // No darwin-amd64 row: gvx publishes no darwin-amd64 release for micke to
  // run underneath it, so micke doesn't either (assetNameFor returns null).
  { bun: "bun-windows-x64", platform: "windows", arch: "amd64", nodePlatform: "win32" },
  { bun: "bun-windows-arm64", platform: "windows", arch: "arm64", nodePlatform: "win32" },
];

const die = (msg: string): never => {
  console.error(`micke: ${msg}`);
  process.exit(1);
};

const tag = process.argv[2] ?? "dev";
if (!process.argv[2]) {
  console.error(
    "micke: no tag given — building a dev-labeled local binary " +
      "(asset names will say -dev-). For a release pass the tag: bun scripts/build.ts v0.2.0",
  );
}

// Fresh dist: `gh release create dist/*` uploads the whole directory, so a
// stale asset from an earlier tag must not ride along, and SHA256SUMS must
// describe exactly this build.
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const nodeArch = (a: Target["arch"]): string => (a === "amd64" ? "x64" : "arm64");
const assetName = (t: Target): string => `micke-${tag}-${t.platform}-${t.arch}${t.platform === "windows" ? ".exe" : ""}`;

for (const t of TARGETS) {
  const name = assetName(t);
  // The contract check: whatever this matrix produces must be exactly what
  // assetNameFor tells `micke upgrade` to download.
  if (assetNameFor(t.nodePlatform, nodeArch(t.arch), tag) !== name) {
    die(`asset-name drift for ${t.bun}: build says ${name}, assetNameFor disagrees — fix scripts/build.ts or src/selfupdate.ts`);
  }

  const outfile = join(DIST, name);
  const r = Bun.spawnSync(
    [
      process.execPath, "build", "--compile",
      "--sourcemap=none", // supported since bun 1.x; release binaries carry no maps
      `--target=${t.bun}`,
      "--define", `MICKE_BUILD_VERSION:'${tag}'`, // what `micke version` prints
      // src/dashboard.ts reads dashboard.html at runtime via
      // readFileSync(import.meta.dir + ...), which --compile does not bundle —
      // embed it explicitly. --asset preserves the relative path, so inside
      // the executable it lands at $bunfs/root/src/dashboard.html, exactly
      // where import.meta.dir resolves. Relative + cwd: ROOT keeps that true
      // no matter where the script is invoked from.
      "--asset", "src/dashboard.html",
      "--outfile", outfile,
      ENTRY,
    ],
    { cwd: ROOT, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  if (r.exitCode !== 0 || !statSync(outfile, { throwIfNoEntry: false })?.isFile()) {
    die(`build failed for ${t.bun} (asset ${name}) — release aborted`);
  }
  console.log(`micke: built ${name} (${Math.round(statSync(outfile).size / 1e6)} MB)`);
}

// Smoke-run the one binary this host can execute; on the linux/amd64 release
// runner that check always fires.
const here = TARGETS.find((t) => t.nodePlatform === process.platform && nodeArch(t.arch) === process.arch);
if (here) {
  const bin = join(DIST, assetName(here));
  const r = Bun.spawnSync([bin, "version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0 || out !== tag) {
    die(`smoke run failed: ${basename(bin)} version exited ${r.exitCode} printing "${out}" (wanted "${tag}")`);
  }
  console.log(`micke: smoke ok — ${basename(bin)} version prints ${tag}`);
} else {
  console.error(
    `micke: no release target for ${process.platform}/${process.arch} (dev host) — skipped the smoke run`,
  );
}

// SHA256SUMS: `<64-hex-lowercase>  <filename>` (two spaces), exactly what
// parseSums in src/release.ts reads back in the updater and installers.
const sumsPath = join(DIST, "SHA256SUMS");
const names = readdirSync(DIST).filter((n) => n !== "SHA256SUMS").sort();
let sums = "";
for (const n of names) {
  sums += `${await sha256File(join(DIST, n))}  ${n}\n`;
}
writeFileSync(sumsPath, sums);
console.log(`micke: wrote dist/SHA256SUMS (${names.length} assets)`);
