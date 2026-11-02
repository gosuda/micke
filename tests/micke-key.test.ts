// tests/micke-key.test.ts — the safe key path.
//
// `agent-desktop press` SIGSEGVs chromium on this image (AT-SPI
// DeviceEventController path); `micke-key` delivers the same combo with
// `xdotool key --clearmodifiers` after resolving and activating the window.
// The guest calls the real xdotool; here a PATH stub records every call, so
// the script's contract is asserted without an image rebuild.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = join(import.meta.dir, "..", "image", "micke-key");
const CALLS = "calls.log";

let bin: string;

function run(args: string[], opts: { noWindow?: boolean; title?: string; active?: string } = {}): {
  rc: number;
  stdout: string;
  stderr: string;
  calls: string[];
  files: string[];
} {
  rmSync(join(bin, CALLS), { force: true });
  const stub = join(bin, "xdotool");
  writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$MICKE_CALLS"
case "$1" in
  search) [ -n "\${MICKE_STUB_NO_WINDOW:-}" ] && exit 1; echo "\${MICKE_STUB_WIN:-4242}" ;;
  getwindowname) echo "\${MICKE_STUB_TITLE:-NAVER - Chromium}" ;;
  windowactivate) exit 0 ;;
  getactivewindow) echo "\${MICKE_STUB_ACTIVE:-\${MICKE_STUB_WIN:-4242}}" ;;
  key) exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(stub, 0o755);

  const proc = Bun.spawnSync(["sh", KEY, ...args], {
    cwd: bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MICKE_CALLS: join(bin, CALLS),
      MICKE_STUB_NO_WINDOW: opts.noWindow ? "1" : "",
      MICKE_STUB_TITLE: opts.title ?? "NAVER - Chromium",
      MICKE_STUB_ACTIVE: opts.active ?? "4242",
    },
  });

  let calls: string[] = [];
  try {
    calls = readFileSync(join(bin, CALLS), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  return {
    rc: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    calls,
    files: readdirSync(bin).filter((f) => !["xdotool", CALLS].includes(f)),
  };
}

function oneLine(stdout: string): any {
  const lines = stdout.split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]);
}

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "micke-key-"));
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("micke-key", () => {
  test("--help prints usage and sends nothing", () => {
    const r = run(["-h"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("usage: micke-key");
    expect(r.calls).toEqual([]);
  });

  test("resolves the window, activates it, then sends the combo verbatim", () => {
    const r = run(["ctrl+r"]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.calls).toEqual([
      "search --onlyvisible --name Chromium",
      "getwindowname 4242",
      "windowactivate --sync 4242",
      "getactivewindow",
      "key --clearmodifiers ctrl+r",
    ]);
    expect(oneLine(r.stdout)).toEqual({ sent: true, combo: "ctrl+r", window: "NAVER - Chromium" });
  });

  test("multi-key combos are passed through untouched", () => {
    const r = run(["ctrl+shift+q"]);
    expect(r.rc).toBe(0);
    expect(r.calls.at(-1)).toBe("key --clearmodifiers ctrl+shift+q");
    expect(oneLine(r.stdout).combo).toBe("ctrl+shift+q");
  });

  test("no chromium window: exit non-zero, clear stderr, nothing sent", () => {
    const r = run(["ctrl+r"], { noWindow: true });
    expect(r.rc).not.toBe(0);
    expect(r.stderr).toContain("micke-key:");
    expect(r.stderr).toContain("no chromium window");
    expect(r.calls.some((c) => c.startsWith("key "))).toBe(false);
    expect(r.stdout).toBe("");
  });

  test("chromium not focused after activation: refuse and send nothing", () => {
    const r = run(["ctrl+r"], { active: "9999" });
    expect(r.rc).not.toBe(0);
    expect(r.stderr).toContain("could not focus chromium window");
    expect(r.calls.some((c) => c.startsWith("key "))).toBe(false);
  });

  test("extra arguments are a usage error", () => {
    const r = run(["ctrl", "r"]);
    expect(r.rc).toBe(2);
    expect(r.stderr).toContain("exactly one combo");
    expect(r.calls).toEqual([]);
  });

  test("writes no files", () => {
    const r = run(["ctrl+r"]);
    expect(r.rc).toBe(0);
    expect(r.files).toEqual([]);
  });
});
