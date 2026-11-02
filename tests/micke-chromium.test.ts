// tests/micke-chromium.test.ts — the wrapper must never launch a browser for a
// flag. `micke-chromium --help` used to become `--arg=--help`: chromium stayed
// up and the session_shell call hung until it was killed.
//
// No sandbox needed: `agent-desktop` is stubbed on PATH and records its argv.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "..", "image", "micke-chromium.sh");

let bin: string;
let argvFile: string;

function run(
  args: string[],
  env: Record<string, string> = {},
): { rc: number; stdout: string; stderr: string; argv: string[] | null } {
  rmSync(argvFile, { force: true });
  const proc = Bun.spawnSync(["sh", WRAPPER, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MICKE_ARGV_FILE: argvFile,
      ...env,
    },
  });
  const argv = existsSync(argvFile)
    ? readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean)
    : null;
  return {
    rc: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    argv,
  };
}

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "micke-chromium-bin-"));
  argvFile = join(bin, "argv.txt");
  // MICKE_STUB_RC makes the stub fail, to test the wrapper's failure path.
  writeFileSync(
    join(bin, "agent-desktop"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$MICKE_ARGV_FILE"\necho '{"version":"2.5","ok":true,"command":"launch","data":{}}'\nexit "\${MICKE_STUB_RC:-0}"\n`,
  );
  chmodSync(join(bin, "agent-desktop"), 0o755);
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("micke-chromium argument handling", () => {
  test("--help prints usage and launches nothing", () => {
    const r = run(["--help"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("micke-chromium https://example.com");
    expect(r.argv).toBeNull();
  });

  test("-h is the same thing", () => {
    const r = run(["-h"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.argv).toBeNull();
  });

  test("an unknown flag fails fast instead of becoming the URL", () => {
    const r = run(["--bogus"]);
    expect(r.rc).toBe(2);
    expect(r.stderr).toContain("unknown flag");
    expect(r.argv).toBeNull();
  });

  test("URL + --arg passthrough keep their order", () => {
    const r = run(["https://example.com", "--arg=--load-extension=/tmp/x"]);
    expect(r.rc).toBe(0);
    expect(r.argv).toEqual([
      "launch",
      "chromium",
      "--arg=--no-sandbox",
      "--arg=--force-renderer-accessibility",
      "--arg=--enable-logging",
      "--arg=--log-file=/tmp/chromium.log",
      "--arg=https://example.com",
      "--arg=--load-extension=/tmp/x",
    ]);
  });

  test("bare call opens about:blank with both required flags", () => {
    const r = run([]);
    expect(r.rc).toBe(0);
    expect(r.argv).toEqual([
      "launch",
      "chromium",
      "--arg=--no-sandbox",
      "--arg=--force-renderer-accessibility",
      "--arg=--enable-logging",
      "--arg=--log-file=/tmp/chromium.log",
    ]);
  });
});

describe("micke-chromium next-pointer (point-of-use hint)", () => {
  test("a successful launch appends exactly one 'micke: next' line after the envelope", () => {
    const r = run(["https://example.com"]);
    expect(r.rc).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain(`"command":"launch"`); // receipt stays line 1
    const next = lines[lines.length - 1];
    expect(next.startsWith("micke: next")).toBe(true); // pointer is the last line
    expect(next).toContain("micke-find");
    expect(next).toContain("micke-type");
    expect(next).toContain("micke-state");
    expect(lines.filter((l) => l.startsWith("micke: next"))).toHaveLength(1);
  });

  test("a failed launch still prints the receipt but adds no pointer", () => {
    const r = run([], { MICKE_STUB_RC: "1" });
    expect(r.rc).toBe(1); // exit code passes through
    expect(r.stdout).toContain(`"command":"launch"`); // envelope still printed
    expect(r.stdout).not.toContain("micke: next");
  });

  test("--help output carries no pointer (nothing was launched)", () => {
    const r = run(["--help"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).not.toContain("micke: next");
  });
});
