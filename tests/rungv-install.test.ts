// tests/rungv-install.test.ts — rungv self-provisioning.
//
// A host with no rungv (no MICKE_RUNGV, nothing on PATH) gets the pinned gvx
// release downloaded from GitHub, checksum-verified, extracted and installed
// under MICKE_RUNGV_DIR. The tests below drive that machinery against a local
// HTTP server shaped like the GitHub release URL space — the fast tier never
// touches the network. Properties, one per test: the asset map, the sums
// parser, the resolution order, checksum enforcement, fetch failure cleanup,
// and the end-to-end "first create downloads rungv, the second does not".
// Fast tier: no sandbox, no real rungv, no network.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assetNameFor, installManagedRungv, parseSums } from "../src/rungvinstall.js";
import { rungvBinary, rungvBinaryName } from "../src/gvxio.js";
import { callTool, spawnDaemon, type Daemon } from "./helpers.js";
import { FAKE_RUNGV, fakeState, type FakeState } from "./fake/harness.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const TAG = "v0.0.0-test";

// ---- pure mapping -----------------------------------------------------------

describe("assetNameFor", () => {
  test("linux maps to tar.gz per arch", () => {
    expect(assetNameFor("linux", "x64", TAG)).toBe(`rungv-${TAG}-linux-amd64.tar.gz`);
    expect(assetNameFor("linux", "arm64", TAG)).toBe(`rungv-${TAG}-linux-arm64.tar.gz`);
  });

  test("darwin maps arm64 only — gvx publishes no darwin-amd64 archive", () => {
    expect(assetNameFor("darwin", "arm64", TAG)).toBe(`rungv-${TAG}-darwin-arm64.tar.gz`);
    expect(assetNameFor("darwin", "x64", TAG)).toBeNull();
  });

  test("win32 maps to zip per arch", () => {
    expect(assetNameFor("win32", "x64", TAG)).toBe(`rungv-${TAG}-windows-amd64.zip`);
    expect(assetNameFor("win32", "arm64", TAG)).toBe(`rungv-${TAG}-windows-arm64.zip`);
  });

  test("anything else has no asset", () => {
    expect(assetNameFor("sunos", "x64", TAG)).toBeNull();
    expect(assetNameFor("linux", "ia32", TAG)).toBeNull();
  });
});

describe("parseSums", () => {
  test("reads `<hex>  <file>` lines and skips junk", () => {
    const hex = "a".repeat(64);
    const sums = parseSums(`# comment\n\n${hex}  rungv-${TAG}-linux-amd64.tar.gz\nshort  other\n`);
    expect(sums.size).toBe(1);
    expect(sums.get(`rungv-${TAG}-linux-amd64.tar.gz`)).toBe(hex);
  });
});

// ---- resolution order -------------------------------------------------------

describe("rungvBinary resolution", () => {
  const saved = { ...process.env };
  let dir: string; // holds: bin/ (managed), with-rungv/ (PATH copy), empty/

  const shellRungv = (dir: string) => {
    const path = join(dir, "rungv");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
    return path;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "micke-resolve-"));
    for (const sub of ["bin", "with-rungv", "empty"]) mkdirSync(join(dir, sub));
    // The managed copy for the pinned version.
    mkdirSync(join(dir, "bin", `rungv-${TAG}`), { recursive: true });
    writeFileSync(join(dir, "bin", `rungv-${TAG}`, "rungv"), "fake-managed\n");
    shellRungv(join(dir, "with-rungv"));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  afterEach(() => {
    process.env = { ...saved };
  });

  test("MICKE_RUNGV wins over PATH and the managed copy", () => {
    process.env.MICKE_RUNGV = "/opt/custom-rungv";
    process.env.PATH = join(dir, "with-rungv");
    process.env.MICKE_RUNGV_DIR = join(dir, "bin");
    process.env.MICKE_RUNGV_VERSION = TAG;
    expect(rungvBinary()).toBe("/opt/custom-rungv");
  });

  test("a PATH rungv beats the managed copy", () => {
    delete process.env.MICKE_RUNGV;
    process.env.PATH = join(dir, "with-rungv");
    process.env.MICKE_RUNGV_DIR = join(dir, "bin");
    process.env.MICKE_RUNGV_VERSION = TAG;
    expect(rungvBinary()).toBe("rungv");
  });

  test("the managed copy serves hosts with neither", () => {
    delete process.env.MICKE_RUNGV;
    process.env.PATH = join(dir, "empty");
    process.env.MICKE_RUNGV_DIR = join(dir, "bin");
    process.env.MICKE_RUNGV_VERSION = TAG;
    expect(rungvBinary()).toBe(join(dir, "bin", `rungv-${TAG}`, "rungv"));
  });

  test("bare `rungv` when nothing exists anywhere", () => {
    delete process.env.MICKE_RUNGV;
    process.env.PATH = join(dir, "empty");
    process.env.MICKE_RUNGV_DIR = join(dir, "empty");
    expect(rungvBinary()).toBe("rungv");
  });
});

// ---- install against a fake release server ----------------------------------
// (tar.gz flows only: the local `tar` builds and extracts them; Windows zips
// need bsdtar, which the fast tier does not assume.)

describe.skipIf(process.platform === "win32")("installManagedRungv (fake release server)", () => {
  let work: string;
  let archive: Uint8Array;
  let archiveSha: string;
  let server: Bun.Server;
  let downloads = 0;
  let mode: "good" | "tampered" | "no-sums" = "good";

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "micke-relsrv-"));
    // A real tar.gz shaped like the gvx release: <pkg>/rungv + a license file.
    const pkg = `rungv-${TAG}-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "x64" ? "amd64" : "arm64"}`;
    const root = join(work, "pkg");
    mkdirSync(join(root, pkg), { recursive: true });
    writeFileSync(join(root, pkg, "LICENSE"), "test\n");
    const bin = join(root, pkg, "rungv");
    writeFileSync(bin, "#!/bin/sh\necho 'rungv v0.0.0-fake-download'\n");
    chmodSync(bin, 0o755);
    const tarball = join(work, `${pkg}.tar.gz`);
    const t = Bun.spawnSync(["tar", "-czf", tarball, "-C", root, pkg]);
    if (t.exitCode !== 0) throw new Error(`test tar build failed: ${t.stderr}`);
    archive = new Uint8Array(await Bun.file(tarball).arrayBuffer());
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(archive);
    archiveSha = hasher.digest("hex");

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        const m = path.match(/^\/download\/([^/]+)\/([^/]+)$/);
        if (!m) return new Response("not found", { status: 404 });
        if (m[2] === "SHA256SUMS") {
          if (mode === "no-sums") return new Response("not found", { status: 404 });
          const hex = mode === "tampered" ? "0".repeat(64) : archiveSha;
          return new Response(`${hex}  ${m[1] === TAG ? assetNameFor(process.platform, process.arch, TAG) : m[2]}\n`);
        }
        downloads++;
        return new Response(archive);
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(work, { recursive: true, force: true });
  });

  const envFor = (binDir: string, tag: string) => {
    process.env.MICKE_RUNGV_DIR = binDir;
    process.env.MICKE_RUNGV_VERSION = tag;
    process.env.MICKE_RUNGV_RELEASE_BASE = `http://${server.hostname}:${server.port}`;
  };

  afterEach(() => {
    // These tests point the installer at temp dirs and this server; never
    // leak that into other suites (resolution order reads the same env).
    delete process.env.MICKE_RUNGV_DIR;
    delete process.env.MICKE_RUNGV_VERSION;
    delete process.env.MICKE_RUNGV_RELEASE_BASE;
  });

  test("downloads, checksum-verifies and installs a runnable rungv", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "micke-install-"));
    try {
      envFor(binDir, TAG);
      mode = "good";
      const installed = await installManagedRungv();
      expect(installed).toBe(join(binDir, `rungv-${TAG}`, rungvBinaryName()));
      expect(existsSync(installed)).toBe(true);
      const smoke = Bun.spawnSync([installed, "version"]);
      expect(smoke.exitCode).toBe(0);
      expect(smoke.stdout.toString()).toContain("rungv v0.0.0-fake-download");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a tampered archive fails the checksum and installs nothing", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "micke-install-"));
    try {
      envFor(binDir, TAG);
      mode = "tampered";
      await expect(installManagedRungv()).rejects.toThrow(/sha256 mismatch/);
      expect(readdirSync(binDir).filter((n) => n.startsWith("rungv-"))).toHaveLength(0);
      expect(readdirSync(binDir).filter((n) => n.startsWith(".install-"))).toHaveLength(0);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a missing SHA256SUMS (404) fails clean with the tag in the message", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "micke-install-"));
    try {
      envFor(binDir, "v0.0.0-nosuchtag");
      mode = "no-sums";
      await expect(installManagedRungv()).rejects.toThrow(/SHA256SUMS failed: HTTP 404.*v0.0.0-nosuchtag/s);
      expect(readdirSync(binDir)).toHaveLength(0);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 15_000);
});

// ---- end to end: the daemon provisions rungv, then boots a session ----------

describe.skipIf(process.platform === "win32")("supervisor self-provisioning", () => {
  const state: FakeState = fakeState("micke-provision-");
  let daemon: Daemon;
  let client: Client;
  let server: Bun.Server;
  let downloads = 0;
  const created: string[] = [];

  beforeAll(async () => {
    // The "release" wraps tests/fake/rungv in a /bin/sh exec, so the archive
    // needs no bundled imports — the installed binary boots real fake sessions.
    const work = mkdtempSync(join(tmpdir(), "micke-provision-pkg-"));
    const pkg = "rungv-dl";
    mkdirSync(join(work, pkg), { recursive: true });
    writeFileSync(join(work, pkg, "rungv"), `#!/bin/sh\nexec ${JSON.stringify(FAKE_RUNGV)} "$@"\n`);
    chmodSync(join(work, pkg, "rungv"), 0o755);
    const tarball = join(work, `${pkg}.tar.gz`);
    const t = Bun.spawnSync(["tar", "-czf", tarball, "-C", work, pkg]);
    if (t.exitCode !== 0) throw new Error(`test tar build failed: ${t.stderr}`);
    const archive = new Uint8Array(await Bun.file(tarball).arrayBuffer());
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(archive);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        const m = path.match(/^\/download\/([^/]+)\/([^/]+)$/);
        if (!m) return new Response("not found", { status: 404 });
        if (m[2] === "SHA256SUMS") {
          return new Response(`${hasher.digest("hex")}  ${assetNameFor(process.platform, process.arch, TAG)}\n`);
        }
        downloads++;
        return new Response(archive);
      },
    });
    rmSync(work, { recursive: true, force: true });

    // No MICKE_RUNGV (empty string is falsy to the resolver) and a PATH with
    // no rungv on it (this host's rungv lives in /usr/local/bin — excluded on
    // purpose): only bun, sh and the base tools. First create must provision
    // from the fake release server, then boot through the download.
    daemon = await spawnDaemon({
      MICKE_STATE_DIR: state.stateDir,
      MICKE_RUNGV: "",
      MICKE_IMAGE: "micke-fake:test",
      MICKE_GVX_CACHE: join(state.stateDir, "gvx-cache"),
      MICKE_FAKE_SHELL_LOG: state.shellLog,
      MICKE_FAKE_RUNGV_LOG: state.rungvLog,
      MICKE_MIN_FREE_MB: "0",
      MICKE_BOOT_TIMEOUT_MS: "5000",
      MICKE_RUNGV_DIR: join(state.stateDir, "bin"),
      MICKE_RUNGV_VERSION: TAG,
      MICKE_RUNGV_RELEASE_BASE: `http://${server.hostname}:${server.port}`,
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    });
    client = await daemon.connect("micke-provision");
  }, 30_000);

  afterAll(async () => {
    for (const id of created) {
      await callTool(client, "session_close", { session_id: id }).catch(() => {});
    }
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    server?.stop(true);
    state.cleanup();
  }, 30_000);

  test("first create downloads rungv once and boots through it", async () => {
    const row = await callTool<any>(client, "session_create");
    created.push(row.session_id);
    expect(row.status).toBe("ready");
    expect(downloads).toBe(1);
    expect(existsSync(join(state.stateDir, "bin", `rungv-${TAG}`, "rungv"))).toBe(true);
  }, 20_000);

  test("later creates reuse the install — no second download", async () => {
    const row = await callTool<any>(client, "session_create");
    created.push(row.session_id);
    expect(row.status).toBe("ready");
    expect(downloads).toBe(1);
  }, 20_000);
});
