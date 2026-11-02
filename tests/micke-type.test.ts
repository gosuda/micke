// tests/micke-type.test.ts — the text path into page inputs.
//
// `agent-desktop type` is refused by real pages on this image
// (ACTION_NOT_SUPPORTED on search containers, POLICY_DENIED on textfields);
// `micke-type` sets the clipboard with xclip in daemon mode (never
// `-loops 1`: chromium's TARGETS probe eats the only loop) and sends ONE
// ctrl+v via the micke-key path. The guest calls real xclip/xdotool; here
// PATH stubs record every call, so the script's contract is asserted
// without an image rebuild.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TYPE = join(import.meta.dir, "..", "image", "micke-type");
const CALLS = "calls.log";
const CLIP = "clip.bin";

let bin: string;

function run(args: string[], opts: { noWindow?: boolean; title?: string; active?: string; stale?: boolean } = {}): {
  rc: number;
  stdout: string;
  stderr: string;
  calls: string[];
  files: string[];
} {
  rmSync(join(bin, CALLS), { force: true });
  rmSync(join(bin, CLIP), { force: true });

  const xdotool = join(bin, "xdotool");
  writeFileSync(
    xdotool,
    `#!/bin/sh
printf 'xdotool %s\\n' "$*" >> "$MICKE_CALLS"
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
  chmodSync(xdotool, 0o755);

  const xclip = join(bin, "xclip");
  writeFileSync(
    xclip,
    `#!/bin/sh
printf 'xclip %s\\n' "$*" >> "$MICKE_CALLS"
out=0
for a in "$@"; do
  case "$a" in -o|-out|--output) out=1 ;; esac
done
if [ "\$out" = 1 ]; then
  # A stale owner answers the read-back with the OLD selection.
  [ -n "\${MICKE_STUB_STALE:-}" ] && { printf 'old text'; exit 0; }
  cat "$MICKE_CLIP" 2>/dev/null
else
  cat > "$MICKE_CLIP"
fi
`,
  );
  chmodSync(xclip, 0o755);

  const proc = Bun.spawnSync(["sh", TYPE, ...args], {
    cwd: bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MICKE_CALLS: join(bin, CALLS),
      MICKE_CLIP: join(bin, CLIP),
      MICKE_STUB_NO_WINDOW: opts.noWindow ? "1" : "",
      MICKE_STUB_TITLE: opts.title ?? "NAVER - Chromium",
      MICKE_STUB_ACTIVE: opts.active ?? "4242",
      MICKE_STUB_STALE: opts.stale ? "1" : "",
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
    files: readdirSync(bin).filter((f) => !["xdotool", "xclip", CALLS, CLIP].includes(f)),
  };
}

function clip(): string {
  try {
    return readFileSync(join(bin, CLIP), "utf8");
  } catch {
    return "";
  }
}

function oneLine(stdout: string): any {
  const lines = stdout.split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]);
}

const HANGUL = "네이버 웹툰 검색";

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "micke-type-"));
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("micke-type", () => {
  test("--help prints usage and sends nothing", () => {
    const r = run(["-h"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("usage: micke-type");
    expect(r.calls).toEqual([]);
  });

  test("missing argument: usage on stderr, exit 2, nothing touched", () => {
    const r = run([]);
    expect(r.rc).toBe(2);
    expect(r.stderr).toContain("usage: micke-type");
    expect(r.calls).toEqual([]);
    expect(clip()).toBe("");
  });

  test("empty argument: usage on stderr, exit 2", () => {
    const r = run([""]);
    expect(r.rc).toBe(2);
    expect(r.stderr).toContain("usage: micke-type");
    expect(r.calls).toEqual([]);
  });

  test("extra arguments: usage error, exit 2", () => {
    const r = run(["hello", "world"]);
    expect(r.rc).toBe(2);
    expect(r.stderr).toContain("exactly one text argument");
    expect(r.calls).toEqual([]);
  });

  test("focus first, clipboard second, ctrl+v last — in that order", () => {
    const r = run(["hello world"]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.calls).toEqual([
      "xdotool search --onlyvisible --name Chromium",
      "xdotool getwindowname 4242",
      "xdotool windowactivate --sync 4242",
      "xdotool getactivewindow",
      "xclip -selection clipboard -in",
      "xclip -selection clipboard -out",
      "xdotool key --clearmodifiers ctrl+v",
    ]);
    expect(oneLine(r.stdout)).toEqual({
      sent: true,
      combo: "ctrl+v",
      bytes: 11,
      window: "NAVER - Chromium",
    });
  });

  test("spaces and Korean reach the clipboard byte-exact (no -loops anywhere)", () => {
    const r = run([HANGUL]);
    expect(r.rc).toBe(0);
    expect(clip()).toBe(HANGUL);
    expect(oneLine(r.stdout).bytes).toBe(Buffer.byteLength(HANGUL, "utf8"));
    expect(r.calls.some((c) => c.startsWith("xclip") && c.includes("-loops"))).toBe(false);
  });

  test("no chromium window: exit non-zero, clipboard untouched, nothing pasted", () => {
    const r = run(["hello"], { noWindow: true });
    expect(r.rc).not.toBe(0);
    expect(r.stderr).toContain("micke-type:");
    expect(r.stderr).toContain("no chromium window");
    expect(r.calls.some((c) => c.startsWith("xclip"))).toBe(false);
    expect(r.calls.some((c) => c.startsWith("xdotool key"))).toBe(false);
    expect(r.stdout).toBe("");
    expect(clip()).toBe("");
  });

  test("chromium not focused after activation: refuse, clipboard untouched", () => {
    const r = run(["hello"], { active: "9999" });
    expect(r.rc).not.toBe(0);
    expect(r.stderr).toContain("could not focus chromium window");
    expect(r.calls.some((c) => c.startsWith("xclip"))).toBe(false);
    expect(r.calls.some((c) => c.startsWith("xdotool key"))).toBe(false);
  });

  test("clipboard read-back mismatch: exit non-zero, no ctrl+v", () => {
    const r = run(["fresh text"], { stale: true });
    expect(r.rc).not.toBe(0);
    expect(r.stderr).toContain("read-back mismatch");
    expect(r.calls.some((c) => c.startsWith("xdotool key"))).toBe(false);
    expect(r.stdout).toBe("");
  });

  test("writes no files", () => {
    const r = run(["hello world"]);
    expect(r.rc).toBe(0);
    expect(r.files).toEqual([]);
  });
});
