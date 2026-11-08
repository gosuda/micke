// tests/install-script.test.ts — install.sh against a fake release server.
//
// The installer is the first thing users run, so it gets the same treatment
// as the updater: a local Bun.serve stands in for the GitHub release URL
// space (the exact paths install.sh hits), and the "binary" it serves is a
// /bin/sh script that answers `version` with its tag and `service install`
// by touching a marker — so the tests prove the real script's behavior
// (resolve → download → verify → install → register) end to end while the
// fast tier stays off the network and away from any real service manager.
//
// Each run scrubs the environment with `env -i` (only HOME, PATH and the
// MICKE_* overrides set): an installer that only works because it inherits
// the developer's shell would be a landmine for the curl|sh user.
//
// The fake server's base ends in /releases — the DEFAULT's shape. v0.1.0
// shipped with the installer requesting <base>/releases/latest (doubled) and
// 404ing on real GitHub, because these tests stood the server up at a bare
// origin: the override and the default disagreed on the convention and the
// mismatch was invisible. The base now mirrors the default exactly, so any
// future drift between the two URL constructions fails here first.
// Fast tier: no sandbox, no network, no service manager.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "install.sh");
const TAG = "v9.9.9";
const PINNED = "v1.2.3";

/** The served "binary": a sh script whose version IS its tag. */
const fakeBinary = (tag: string): string =>
  `#!/bin/sh
case "$1" in
  version) echo "${tag}" ;;
  service)
    case "$2" in
      install) echo ok > "\${MICKE_FAKE_MARKER:?}" ;;
      status) echo "fake-status" ;;
    esac
    ;;
esac
`;

const sha = (bytes: string): string => {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
};

describe.skipIf(process.platform === "win32")("install.sh (fake release server)", () => {
  let server: Bun.Server;
  let latestHits = 0;
  let latestTag = TAG;
  let tampered = false;
  const workdirs: string[] = [];

  /** SHA256SUMS as a real release writes it (all assets); tampered zeroes the digest. */
  const sumsFor = (tag: string): string => {
    const hex = tampered ? "0".repeat(64) : sha(fakeBinary(tag));
    // The darwin line proves matching is by exact filename, not substring.
    return `${hex}  micke-${tag}-darwin-arm64\n${hex}  micke-${tag}-linux-amd64\n${hex}  micke-${tag}-linux-arm64\n`;
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const origin = url.origin;
        if (url.pathname === "/releases/latest") {
          // Same shape as GitHub: Location names the tag page; curl -L then
          // GETs it and the -f flag requires it to be 200.
          latestHits++;
          return new Response(null, { status: 302, headers: { Location: `${origin}/tag/${latestTag}` } });
        }
        if (/^\/tag\/[^/]+$/.test(url.pathname)) return new Response("<html>release</html>");
        const m = url.pathname.match(/^\/releases\/download\/([^/]+)\/([^/]+)$/);
        if (!m) return new Response("not found", { status: 404 });
        if (m[2] === "SHA256SUMS") return new Response(sumsFor(m[1]));
        if (/^micke-.*-linux-(amd64|arm64)$/.test(m[2])) return new Response(fakeBinary(m[1]));
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    for (const w of workdirs) rmSync(w, { recursive: true, force: true });
  });

  beforeEach(() => {
    latestHits = 0;
    latestTag = TAG;
    tampered = false;
  });

  /**
   * One installer run in a scrubbed env (env -i proves no inherited reliance).
   * Spawned ASYNC on purpose: the installer's curl must talk to this suite's
   * own Bun.serve, and a synchronous spawnSync would block the event loop
   * that answers it — deadlock.
   */
  const runInstaller = async (args: string[]) => {
    const work = mkdtempSync(join(tmpdir(), "micke-install-"));
    workdirs.push(work);
    const binDir = join(work, "bin");
    const marker = join(work, "marker");
    const proc = Bun.spawn(
      [
        "env", "-i",
        `HOME=${work}`,
        "PATH=/usr/bin:/bin",
        `MICKE_RELEASE_BASE=http://${server.hostname}:${server.port}/releases`,
        `MICKE_BIN_DIR=${binDir}`,
        `MICKE_FAKE_MARKER=${marker}`,
        "sh", SCRIPT,
        ...args,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { rc: await proc.exited, stdout, stderr, work, micke: join(binDir, "micke"), marker };
  };

  /** Run the installed fake binary; only file I/O, but async for uniformity. */
  const runMicke = async (micke: string, ...args: string[]): Promise<string> => {
    const proc = Bun.spawn([micke, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const rc = await proc.exited;
    if (rc !== 0) throw new Error(`fake micke ${args.join(" ")} exited ${rc}`);
    return stdout.trim();
  };

  test("installs the verified asset as $MICKE_BIN_DIR/micke, executable, running the served bytes", async () => {
    const { rc, micke } = await runInstaller([PINNED]);
    expect(rc).toBe(0);
    expect(existsSync(micke)).toBe(true);
    expect(statSync(micke).mode & 0o111).not.toBe(0); // shebang script needs +x
    expect(await runMicke(micke, "version")).toBe(PINNED);
  }, 15_000);

  test("resolves latest through the /releases/latest redirect and installs that tag", async () => {
    const { rc, micke } = await runInstaller([]);
    expect(rc).toBe(0);
    expect(latestHits).toBe(1); // the redirect was the tag source
    expect(await runMicke(micke, "version")).toBe(TAG);
  }, 15_000);

  test("runs `service install` on the installed binary", async () => {
    const { rc, marker } = await runInstaller([PINNED]);
    expect(rc).toBe(0);
    expect(existsSync(marker)).toBe(true);
  }, 15_000);

  test("a pinned tag never requests /releases/latest", async () => {
    const { rc, micke } = await runInstaller([PINNED]);
    expect(rc).toBe(0);
    expect(latestHits).toBe(0);
    expect(await runMicke(micke, "version")).toBe(PINNED);
  }, 15_000);

  test("a tampered SHA256SUMS aborts with nothing installed", async () => {
    tampered = true;
    const { rc, stderr, micke } = await runInstaller([PINNED]);
    expect(rc).not.toBe(0);
    expect(stderr).toContain("sha256 mismatch");
    expect(existsSync(micke)).toBe(false); // die before install: no binary lands
  }, 15_000);
});
