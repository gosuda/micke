// tests/micke-find.test.ts — locating a click target without `find`.
//
// `micke-find` filters ONE compact snapshot in the guest instead of asking
// `agent-desktop find` for two stable passes of a mutating tree. The stub on
// PATH returns a scripted sequence of snapshots and records each invocation,
// so the retry ladder is asserted without a sandbox.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIND = join(import.meta.dir, "..", "image", "micke-find");
const CALLS = "calls.log";

type Node = { role: string; name: string; ref_id: string };

function node(role: string, name: string, ref: string): Node {
  return { role, name, ref_id: ref };
}

function snapshot(nodes: Node[], opts: { truncated?: boolean } = {}): string {
  const truncated = opts.truncated ?? false;
  return JSON.stringify({
    version: "2.5",
    ok: true,
    command: "snapshot",
    data: {
      app: "chromium",
      snapshot_id: "s1",
      ref_count: nodes.length,
      complete: !truncated,
      truncated,
      tree: { role: "window", name: "Chromium", children: nodes },
    },
  });
}

let bin: string;

function run(opts: { snapshots: string[]; args: string[] }): {
  rc: number;
  stdout: string;
  stderr: string;
  calls: string[];
  files: string[];
} {
  const snaps = opts.snapshots.length > 0 ? opts.snapshots : [snapshot([])];
  for (let i = 0; i < snaps.length; i++) {
    writeFileSync(join(bin, `snap-${i + 1}.json`), snaps[i]);
  }
  writeFileSync(join(bin, "max"), String(snaps.length));
  rmSync(join(bin, CALLS), { force: true });

  const stub = join(bin, "agent-desktop");
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "snapshot" ]; then
  printf '%s\\n' "$*" >> "$MICKE_CALLS"
  n=$(wc -l < "$MICKE_CALLS" | tr -d ' ')
  max=$(cat "$MICKE_MAX")
  [ "$n" -gt "$max" ] && n=$max
  cat "$MICKE_DIR/snap-$n.json"
  exit \${MICKE_STUB_RC:-0}
fi
echo "unexpected: $*" >&2
exit 2
`,
  );
  chmodSync(stub, 0o755);

  const proc = Bun.spawnSync(["sh", FIND, ...opts.args], {
    cwd: bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MICKE_DIR: bin,
      MICKE_MAX: join(bin, "max"),
      MICKE_CALLS: join(bin, CALLS),
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
    files: readdirSync(bin).filter(
      (f) => !["agent-desktop", "max", CALLS].includes(f) && !f.startsWith("snap-"),
    ),
  };
}

function lines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l !== "");
}

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "micke-find-"));
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("micke-find", () => {
  test("matches a name substring and prints ref<TAB>role<TAB>name", () => {
    const r = run({
      snapshots: [
        snapshot([
          node("link", "Npay 증권", "@s1:e7"),
          node("link", "Npay 뉴스", "@s1:e8"),
        ]),
      ],
      args: ["증권"],
    });
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    const [line] = lines(r.stdout);
    expect(line.split("\t")).toEqual(["@s1:e7", "link", "Npay 증권"]);
  });

  test("substring matching is case-insensitive", () => {
    const r = run({
      snapshots: [snapshot([node("link", "Learn more about us", "@s1:e2")])],
      args: ["learn MORE"],
    });
    expect(r.rc).toBe(0);
    expect(lines(r.stdout)).toEqual(["@s1:e2\tlink\tLearn more about us"]);
  });

  test("matches Korean text byte-for-byte", () => {
    const r = run({
      snapshots: [snapshot([node("link", "증권", "@s1:e3")])],
      args: ["증권"],
    });
    expect(r.rc).toBe(0);
    expect(lines(r.stdout)).toEqual(["@s1:e3\tlink\t증권"]);
  });

  test("--role filters by role", () => {
    const r = run({
      snapshots: [
        snapshot([
          node("link", "증권 열기", "@s1:e4"),
          node("button", "증권 열기", "@s1:e5"),
        ]),
      ],
      args: ["증권", "--role", "button"],
    });
    expect(r.rc).toBe(0);
    expect(lines(r.stdout)).toEqual(["@s1:e5\tbutton\t증권 열기"]);
  });

  test("--limit caps the number of matches", () => {
    const r = run({
      snapshots: [
        snapshot([
          node("link", "news 1", "@s1:e1"),
          node("link", "news 2", "@s1:e2"),
          node("link", "news 3", "@s1:e3"),
        ]),
      ],
      args: ["news", "--limit", "2"],
    });
    expect(r.rc).toBe(0);
    expect(lines(r.stdout)).toHaveLength(2);
    expect(lines(r.stdout)[1]).toBe("@s1:e2\tlink\tnews 2");
  });

  test("--json prints an array of {ref,role,name}", () => {
    const r = run({
      snapshots: [snapshot([node("link", "증권", "@s1:e9")])],
      args: ["증권", "--json"],
    });
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { ref: "@s1:e9", role: "link", name: "증권" },
    ]);
  });

  test("truncated tree retries once at 10000 and stops on a match", () => {
    const r = run({
      snapshots: [snapshot([], { truncated: true }), snapshot([node("link", "증권", "@s2:e7")])],
      args: ["증권"],
    });
    expect(r.rc).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toContain("--timeout-ms 5000");
    expect(r.calls[1]).toContain("--timeout-ms 10000");
    expect(lines(r.stdout)).toEqual(["@s2:e7\tlink\t증권"]);
  });

  test("truncated tree climbs the full ladder to 20000", () => {
    const r = run({
      snapshots: [
        snapshot([], { truncated: true }),
        snapshot([], { truncated: true }),
        snapshot([node("link", "증권", "@s3:e7")], { truncated: true }),
      ],
      args: ["증권"],
    });
    expect(r.rc).toBe(0);
    expect(r.calls).toHaveLength(3);
    expect(r.calls[2]).toContain("--timeout-ms 20000");
    expect(lines(r.stdout)).toEqual(["@s3:e7\tlink\t증권"]);
  });

  test("a complete tree with no match does NOT retry and exits 1", () => {
    const r = run({
      snapshots: [snapshot([node("link", "뉴스", "@s1:e1")], { truncated: false })],
      args: ["증권"],
    });
    expect(r.rc).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("micke-find: no element");
    expect(r.stderr).toContain("증권");
    expect(r.stderr).toContain("5000");
    expect(r.stderr).not.toContain("10000");
  });

  test("truncated with no match exhausts the ladder and fails loudly", () => {
    const r = run({
      snapshots: [
        snapshot([], { truncated: true }),
        snapshot([], { truncated: true }),
        snapshot([], { truncated: true }),
      ],
      args: ["증권", "--role", "link"],
    });
    expect(r.rc).toBe(1);
    expect(r.calls).toHaveLength(3);
    expect(r.stderr).toContain("5000/10000/20000");
    expect(r.stderr).toContain("role=link");
  });

  test("--root and a custom --budget reach the snapshot call", () => {
    const r = run({
      snapshots: [snapshot([node("link", "증권", "@s1:e7")])],
      args: ["증권", "--root", "@s1:e1", "--budget", "8000"],
    });
    expect(r.rc).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("--root @s1:e1");
    expect(r.calls[0]).toContain("--timeout-ms 8000");
  });

  test("writes no files", () => {
    const r = run({
      snapshots: [snapshot([node("link", "증권", "@s1:e7")])],
      args: ["증권"],
    });
    expect(r.rc).toBe(0);
    expect(r.files).toEqual([]);
  });
});
