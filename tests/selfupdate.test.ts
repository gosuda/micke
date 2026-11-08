// tests/selfupdate.test.ts — micke's self-update.
//
// `micke upgrade` downloads the release binary, verifies it against the
// release's own SHA256SUMS and renames it over the running binary, then
// bounces the service. These tests drive that machinery against a local HTTP
// server shaped like the GitHub release URL space — the fast tier never
// touches the network. The "binaries" are /bin/sh scripts, so the server
// suite skips Windows.
//
// Every performUpgrade call injects BOTH a currentPath and a restart stub:
// the production defaults need a compiled micke binary (the packaging unit
// smoke-tests those), and the default restart would try to bounce whatever
// registration THIS host really carries — including a developer's own
// micke.service — which the tests must never do.
// Fast tier: no sandbox, no network, no service manager.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNameFor, latestTag, performUpgrade } from "../src/selfupdate.js";

const TAG = "v9.9.9";
const OLD_MARKER = "v0.1.0-old";
const NEW_MARKER = "v9.9.9";

/** Stands in for serviceRestart on an unregistered host. */
const notInstalled = () => {
  throw new Error("micke service is not installed (run: micke service install)");
};

// ---- pure mapping -----------------------------------------------------------

describe("assetNameFor (selfupdate)", () => {
  test("linux x64 and win32 arm64 resolve to raw single-file binaries", () => {
    expect(assetNameFor("linux", "x64", TAG)).toBe(`micke-${TAG}-linux-amd64`);
    expect(assetNameFor("win32", "arm64", TAG)).toBe(`micke-${TAG}-windows-arm64.exe`);
  });

  test("darwin x64 and unknown arches have no asset", () => {
    expect(assetNameFor("darwin", "x64", TAG)).toBeNull(); // gvx has no darwin-amd64 to run under
    expect(assetNameFor("linux", "ia32", TAG)).toBeNull();
  });
});

// ---- upgrade against a fake release server ----------------------------------

describe.skipIf(process.platform === "win32")("performUpgrade (fake release server)", () => {
  const saved = { ...process.env };
  let work: string;
  let current: string; // the "installed" micke binary the upgrade swaps over
  let server: Bun.Server;
  let sums: "good" | "tampered" | "missing" = "good";
  let restartCalls = 0;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "micke-upgrade-"));
    current = join(work, "micke");
    const newBinary = `#!/bin/sh\necho ${NEW_MARKER}\n`;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(newBinary);
    const newSha = hasher.digest("hex"); // digest once; the handler only reads
    const asset = assetNameFor(process.platform, process.arch, TAG)!;

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const origin = new URL(req.url).origin;
        const path = new URL(req.url).pathname;
        if (path === "/releases/latest") {
          // Trailing slash on purpose: the tag must be the LAST path segment.
          return new Response(null, { status: 302, headers: { Location: `${origin}/tag/${TAG}/` } });
        }
        const m = path.match(/^\/download\/([^/]+)\/([^/]+)$/);
        if (!m) return new Response("not found", { status: 404 });
        if (m[2] === "SHA256SUMS") {
          if (sums === "missing") return new Response("not found", { status: 404 });
          const hex = sums === "tampered" ? "0".repeat(64) : newSha;
          return new Response(`${hex}  ${asset}\n`);
        }
        if (m[2] === asset) return new Response(newBinary);
        return new Response("not found", { status: 404 });
      },
    });
    process.env.MICKE_RELEASE_BASE = `http://${server.hostname}:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(work, { recursive: true, force: true });
    // Never leak the fake release server into other suites.
    process.env = { ...saved };
  });

  beforeEach(() => {
    // Every test starts from the old binary, whatever the one before did.
    writeFileSync(current, `#!/bin/sh\necho ${OLD_MARKER}\n`);
    chmodSync(current, 0o755);
    sums = "good";
    restartCalls = 0;
  });

  const runCurrent = () => Bun.spawnSync([current], { stdin: "ignore" }).stdout.toString().trim();

  test("latestTag parses the tag out of the redirect Location", async () => {
    await expect(latestTag()).resolves.toBe(TAG);
  }, 15_000);

  test("an explicit tag swaps the binary; a failed restart reports restarted=false", async () => {
    const r = await performUpgrade({ tag: TAG, currentPath: current, restart: notInstalled });
    expect(r.from).toBe("0.0.0-dev"); // the dev-tree fallback: this runs under bun
    expect(r.to).toBe(TAG);
    expect(r.path).toBe(current);
    expect(r.restarted).toBe(false);
    expect(runCurrent()).toBe(NEW_MARKER);
  }, 15_000);

  test("the restart seam runs exactly once and success reports restarted=true", async () => {
    const r = await performUpgrade({
      tag: TAG,
      currentPath: current,
      restart: () => {
        restartCalls++;
      },
    });
    expect(restartCalls).toBe(1);
    expect(r.restarted).toBe(true);
  }, 15_000);

  test("a tampered checksum fails the swap, keeps the old binary and leaves no residue", async () => {
    sums = "tampered";
    await expect(
      performUpgrade({ tag: TAG, currentPath: current, restart: notInstalled }),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runCurrent()).toBe(OLD_MARKER);
    expect(readdirSync(work).filter((n) => n.startsWith(".micke-"))).toHaveLength(0);
  }, 15_000);

  test("a missing SHA256SUMS (404) fails clean, naming the status and the tag", async () => {
    sums = "missing";
    await expect(
      performUpgrade({ tag: TAG, currentPath: current, restart: notInstalled }),
    ).rejects.toThrow(/HTTP 404.*v9\.9\.9/s);
    expect(runCurrent()).toBe(OLD_MARKER);
  }, 15_000);
});
