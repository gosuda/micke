// tests/micke-help.test.ts — the in-guest manual page.
//
// The session_shell description is the agent's only manual, but an agent that
// orients from `agent-desktop --help` / `agent-desktop skills` in the guest
// sees a loop that mentions none of the micke helpers (and the skills are
// compiled into the agent-desktop binary, so they cannot carry a micke
// skill). `micke-help` is the in-guest entry point: it must print the same
// recipe the tool description leads with, one line per helper, and touch
// nothing. Pure text script — run it and assert on the contract.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = join(import.meta.dir, "..", "image", "micke-help");

const HELPERS = [
  "micke-chromium",
  "micke-find",
  "micke-type",
  "micke-key",
  "micke-state",
  "micke-page-text",
] as const;

let bin: string;

function run(args: string[] = []): { rc: number; stdout: string; stderr: string; files: string[] } {
  const proc = Bun.spawnSync(["sh", HELP, ...args], {
    cwd: bin,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  return {
    rc: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    files: readdirSync(bin),
  };
}

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "micke-help-"));
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("micke-help", () => {
  test("exit 0, empty stderr, writes no files", () => {
    const r = run();
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.files).toEqual([]);
  });

  test("lists every helper with a one-line description", () => {
    const r = run();
    expect(r.rc).toBe(0);
    for (const h of HELPERS) expect(r.stdout).toContain(h);
    expect(r.stdout).toContain("agent-desktop click");
  });

  test("the recipe enumerates the loop in order: launch → find → click → type → keys → verify", () => {
    const r = run();
    const order = [
      r.stdout.indexOf("micke-chromium"),
      r.stdout.indexOf("micke-find"),
      r.stdout.indexOf("agent-desktop click"),
      r.stdout.indexOf("micke-type"),
      r.stdout.indexOf("micke-key"),
      r.stdout.indexOf("micke-state"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the recipe block appears before the per-helper lines (recipe first, detail after)", () => {
    const r = run();
    expect(r.stdout.indexOf("Helpers:")).toBeGreaterThan(0);
    // The loop arrows sit in the recipe block, above the "Helpers:" section.
    expect(r.stdout.indexOf("->")).toBeGreaterThan(-1);
    expect(r.stdout.indexOf("->")).toBeLessThan(r.stdout.indexOf("Helpers:"));
  });

  test("warns about the two agent-desktop traps it replaces: press SIGSEGV and headless type refusal", () => {
    const r = run();
    expect(r.stdout).toContain("SIGSEGV");
    expect(r.stdout).toContain("POLICY_DENIED");
    expect(r.stdout).toContain("--headed type");
  });

  test("states the fresh-bash contract (cwd/env do not persist)", () => {
    const r = run();
    expect(r.stdout).toContain("fresh bash");
    expect(r.stdout).toContain("do NOT persist");
  });

  test("ignores arguments: same page, still exit 0 (an agent typing `micke-help type` wants the manual)", () => {
    const bare = run();
    const withArg = run(["type"]);
    expect(withArg.rc).toBe(0);
    expect(withArg.stderr).toBe("");
    expect(withArg.stdout).toBe(bare.stdout);
  });
});
