// tests/micke-state.test.ts — the one-line verification channel.
//
// `micke-state` answers "is chromium alive / did the click land?" from the
// a11y tree (window title, address bar, ref count) instead of a PNG. The
// guest calls the real agent-desktop; here a PATH stub stands in, so the
// test covers the script's contract without an image rebuild.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = join(import.meta.dir, "..", "image", "micke-state.sh");

let bin: string;

const WINDOW = `{"version":"2.5","ok":true,"command":"list-windows","data":[{"title":"Npay 증권 - Chromium"}]}`;
const SNAPSHOT = `{"version":"2.5","ok":true,"data":{"ref_count":547,"tree":{"name":"Npay 증권 - Chromium","children":[{"name":"Address and search bar","role":"textfield","value":"stock.naver.com"}]}}}`;

function run(opts: {
  windows?: string;
  windowsRc?: number;
  snapshot?: string;
  snapshotRc?: number;
  chromiumProcess?: boolean;
}): {
  rc: number;
  stdout: string;
  stderr: string;
  files: string[];
} {
  writeFileSync(join(bin, "windows.json"), opts.windows ?? WINDOW);
  writeFileSync(join(bin, "snapshot.json"), opts.snapshot ?? SNAPSHOT);
  const stub = join(bin, "agent-desktop");
  writeFileSync(
    stub,
    `#!/bin/sh
case "$1" in
  list-windows) cat "$MICKE_STUB_WINDOWS"; exit \${MICKE_STUB_WINDOWS_RC:-0} ;;
  snapshot) cat "$MICKE_STUB_SNAPSHOT"; exit \${MICKE_STUB_SNAPSHOT_RC:-0} ;;
  *) echo "unexpected: $1" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(stub, 0o755);

  // `pgrep -x chromium` is how the script tells "dead" from "alive, no window".
  const pgrep = join(bin, "pgrep");
  writeFileSync(
    pgrep,
    `#!/bin/sh
exit \${MICKE_STUB_PGREP_RC:-1}
`,
  );
  chmodSync(pgrep, 0o755);

  const proc = Bun.spawnSync(["sh", STATE], {
    cwd: bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MICKE_STUB_WINDOWS: join(bin, "windows.json"),
      MICKE_STUB_SNAPSHOT: join(bin, "snapshot.json"),
      MICKE_STUB_WINDOWS_RC: String(opts.windowsRc ?? 0),
      MICKE_STUB_SNAPSHOT_RC: String(opts.snapshotRc ?? 0),
      MICKE_STUB_PGREP_RC: opts.chromiumProcess === false ? "1" : "0",
    },
  });
  return {
    rc: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    files: readdirSync(bin).filter((f) => !["agent-desktop", "pgrep", "windows.json", "snapshot.json"].includes(f)),
  };
}

function oneLine(stdout: string): any {
  const lines = stdout.split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(1); // exactly one line of JSON, nothing else
  return JSON.parse(lines[0]);
}

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "micke-state-"));
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("micke-state", () => {
  test("alive chromium: one JSON line with title, url and refs", () => {
    const r = run({});
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    expect(oneLine(r.stdout)).toEqual({
      alive: true,
      title: "Npay 증권",
      url: "stock.naver.com",
      refs: 547,
    });
  });

  test("no chromium window: alive:false, exit 1, human-readable stderr", () => {
    const r = run({ windows: `{"version":"2.5","ok":true,"command":"list-windows","data":[]}` });
    expect(r.rc).toBe(1);
    expect(oneLine(r.stdout)).toEqual({ alive: false, title: null, url: null, refs: null });
    expect(r.stderr).toContain("micke-state:");
    expect(r.stderr.trim()).not.toBe("");
  });

  test("a failed list-windows with no chromium process says it is not running", () => {
    const r = run({
      windows: `{"version":"2.5","ok":false,"error":{"code":"NO_APP"}}`,
      windowsRc: 1,
      chromiumProcess: false,
    });
    expect(r.rc).toBe(1);
    expect(oneLine(r.stdout).alive).toBe(false);
    expect(r.stderr).toContain("not running");
    expect(r.stderr).toContain("pgrep found no chromium process");
  });

  test("a process alive with no window is reported differently from a dead one", () => {
    const r = run({
      windows: `{"version":"2.5","ok":false,"error":{"code":"NO_APP"}}`,
      windowsRc: 1,
      chromiumProcess: true,
    });
    expect(r.rc).toBe(1);
    expect(oneLine(r.stdout).alive).toBe(false);
    expect(r.stderr).toContain("running but exposes no window");
  });

  test("snapshot failure keeps the browser alive, url/refs null", () => {
    const r = run({ snapshot: `{"version":"2.5","ok":false,"error":{"code":"TIMEOUT"}}`, snapshotRc: 1 });
    expect(r.rc).toBe(0);
    expect(oneLine(r.stdout)).toEqual({
      alive: true,
      title: "Npay 증권",
      url: null,
      refs: null,
    });
  });

  test("a missing title is null, never the word 'null'", () => {
    const r = run({ windows: `{"version":"2.5","ok":true,"data":[{"title":null}]}` });
    expect(r.rc).toBe(0);
    expect(oneLine(r.stdout).title).toBeNull();
  });

  test("writes no files", () => {
    const r = run({});
    expect(r.rc).toBe(0);
    expect(r.files).toEqual([]);
  });
});
