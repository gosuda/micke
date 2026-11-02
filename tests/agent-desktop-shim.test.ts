// tests/agent-desktop-shim.test.ts — `ok:false` must reach the caller as exit 1.
//
// agent-desktop returns rc 0 for application-level failures such as
// {"ok":false,"error":{"code":"TIMEOUT"}}, so `set -e` and `&&` chains used to
// continue after a failed action. The shim rewrites only the exit code; stdout
// stays byte-identical so `agent-desktop ... | jq` keeps working.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = join(import.meta.dir, "..", "image", "agent-desktop-shim.sh");

let bin: string;

function run(stdout: string, rc = 0, args: string[] = []): { rc: number; stdout: string; stderr: string } {
  const payload = join(bin, "payload.txt");
  writeFileSync(payload, stdout);
  const stub = join(bin, "agent-desktop-real");
  writeFileSync(stub, `#!/bin/sh\ncat "$MICKE_STUB_PAYLOAD"\nexit ${rc}\n`);
  chmodSync(stub, 0o755);
  const proc = Bun.spawnSync(["sh", SHIM, ...args], {
    env: { ...process.env, AGENT_DESKTOP_REAL: stub, MICKE_STUB_PAYLOAD: payload },
  });
  return {
    rc: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "micke-adshim-"));
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("agent-desktop exit-code contract", () => {
  test("ok:true stays 0 and stdout is unchanged", () => {
    const out = `{"version":"2.5","ok":true,"command":"launch","data":{"pid":133}}`;
    const r = run(out);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe(out + "\n");
  });

  test("ok:false becomes exit 1, envelope still printed verbatim", () => {
    const out = `{"version":"2.5","ok":false,"command":"find","error":{"code":"TIMEOUT","message":"Locator traversal returned incomplete evidence"}}`;
    const r = run(out);
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe(out + "\n");
    expect(r.stdout).toContain("TIMEOUT");
  });

  test("a pre-existing non-zero code passes through untouched", () => {
    const out = `{"version":"2.5","ok":false,"error":{"code":"INVALID_ARGS"}}`;
    const r = run(out, 2);
    expect(r.rc).toBe(2);
  });

  test("non-JSON output (version/help) keeps its exit code", () => {
    const r = run("agent-desktop 1.0.2", 0);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("agent-desktop 1.0.2\n");
  });

  test("an envelope without ok is not treated as failure", () => {
    const r = run(`{"version":"2.5","command":"status","data":{}}`);
    expect(r.rc).toBe(0);
  });

  test("malformed JSON is not treated as failure", () => {
    const r = run("{not json");
    expect(r.rc).toBe(0);
  });
});

describe("agent-desktop point-of-use hints (stderr only)", () => {
  test("press gets one pre-warning line on stderr and still executes", () => {
    const out = `{"version":"2.5","ok":true,"command":"press","data":{"combo":"Return"}}`;
    const r = run(out, 0, ["press", "Return"]);
    expect(r.stderr).toContain("SIGSEGV");
    expect(r.stderr).toContain("micke-key");
    expect(r.stderr.trim().split("\n")).toHaveLength(1); // one line, and only that
    expect(r.stderr.startsWith("micke:")).toBe(true);
    expect(r.rc).toBe(0);           // warned, never blocked
    expect(r.stdout).toBe(out + "\n"); // envelope untouched
  });

  test("type POLICY_DENIED appends the micke-type remedy on stderr", () => {
    const out = `{"version":"2.5","ok":false,"command":"type","error":{"code":"POLICY_DENIED","message":"Typing is only allowed with --headed"}}`;
    const r = run(out, 0, ["type", "hello"]);
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe(out + "\n");   // stdout stays byte-identical
    expect(r.stderr).toContain("micke-type");
    expect(r.stderr).toContain("--headed type");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  test("set-value ACTION_NOT_SUPPORTED gets the same remedy", () => {
    const out = `{"version":"2.5","ok":false,"command":"set-value","error":{"code":"ACTION_NOT_SUPPORTED","message":"set-value is not supported"}}`;
    const r = run(out, 0, ["set-value", "@snap:1", "hello"]);
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe(out + "\n");
    expect(r.stderr).toContain("micke-type");
    expect(r.stderr).toContain("--headed type");
  });

  test("type POLICY_DENIED still gets the remedy when the CLI itself exits non-zero", () => {
    // The real CLI reports this refusal with rc 1 (measured on the image);
    // the remedy must ride along on both shapes of a failed call.
    const out = `{"version":"2.5","ok":false,"command":"type","error":{"code":"POLICY_DENIED","message":"Target is not actionable"}}`;
    const r = run(out, 1, ["type", "@s:e65", "hello"]);
    expect(r.rc).toBe(1); // pass-through rc, not rewritten
    expect(r.stdout).toBe(out + "\n");
    expect(r.stderr).toContain("micke-type");
  });

  test("find failure (TIMEOUT) gets the micke-find hint on stderr", () => {
    const out = `{"version":"2.5","ok":false,"command":"find","error":{"code":"TIMEOUT","message":"tree never stabilized"}}`;
    const r = run(out, 0, ["find", "login"]);
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe(out + "\n");
    expect(r.stderr).toContain("micke-find");
    expect(r.stderr).toContain("--role");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  test("successful envelopes stay hint-free on stderr", () => {
    const out = `{"version":"2.5","ok":true,"command":"type","data":{}}`;
    const r = run(out, 0, ["type", "hi"]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(out + "\n");
  });

  test("ok:false with an unrelated command/code adds no hint", () => {
    const out = `{"version":"2.5","ok":false,"command":"click","error":{"code":"REF_NOT_FOUND"}}`;
    const r = run(out, 0, ["click", "@snap:1"]);
    expect(r.rc).toBe(1);
    expect(r.stderr).toBe("");
  });

  test("type refused with another code (TIMEOUT) adds no remedy", () => {
    const out = `{"version":"2.5","ok":false,"command":"type","error":{"code":"TIMEOUT"}}`;
    const r = run(out, 0, ["type", "x"]);
    expect(r.rc).toBe(1);
    expect(r.stderr).toBe(""); // POLICY_DENIED / ACTION_NOT_SUPPORTED only
  });
});
