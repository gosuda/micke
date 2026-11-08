// tests/cli.test.ts — the `micke` command-line surface.
//
// Spawns the real CLI per case with the absolute bun path (bun is not on the
// default PATH here). One property per test. The service ACTIONS are
// deliberately not driven from here: they need the OS service manager and a
// compiled micke binary — the fast tier has neither (the pure generators are
// covered by tests/service-files.test.ts).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

function micke(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: ROOT, stdin: "ignore" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("micke cli", () => {
  test("`version` prints exactly one non-empty line", () => {
    const r = micke(["version"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeGreaterThan(0);
  });

  test("`help` exits 0 and lists every subcommand", () => {
    const r = micke(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("daemon");
    expect(r.stdout).toContain("service install");
    expect(r.stdout).toContain("upgrade");
  });

  test("no args is help on stdout, exit 0", () => {
    const r = micke([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("an unknown command exits 1 with usage on stderr", () => {
    const r = micke(["definitely-not-a-command"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Usage:");
    expect(r.stdout).toBe("");
  });

  test("an unknown service subcommand exits 1 with usage on stderr", () => {
    const r = micke(["service", "explode"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Usage:");
  });
});
