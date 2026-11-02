// tests/audit.test.ts — the MCP dispatch appends one line per tool call to
// <stateDir>/audit.log: the maintainer's objective record of what an agent
// ran (shell calls, waits, screenshots, status checks) once the session and
// its transcripts are gone. This pins the line shape for success, failure,
// and unknown tools.
//
// Run: bun test tests/audit.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, callToolErr, type Daemon } from "./helpers.js";
import { fakeState, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

const auditLines = (state: FakeState): string[] => {
  try {
    return readFileSync(join(state.stateDir, "audit.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

describe("mcp audit log", () => {
  const state = fakeState("micke-audit-");
  let daemon: Daemon;
  let client: Client;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
    client = await daemon.connect("micke-audit");
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("one ok line per tool call, in call order", async () => {
    const s = await callTool<any>(client, "session_create");
    await callTool<any>(client, "session_shell", { session_id: s.session_id, command: "echo hi" });
    await callTool<any>(client, "session_close", { session_id: s.session_id });

    const lines = auditLines(state).slice(-3);
    expect(lines[0]).toMatch(new RegExp(`^\\S+ session_create sid=${s.session_id} took=\\d+ms ok$`));
    expect(lines[1]).toMatch(
      new RegExp(`^\\S+ session_shell sid=${s.session_id} rc=0 timed_out=false cmd=echo hi took=\\d+ms ok$`),
    );
    expect(lines[2]).toMatch(new RegExp(`^\\S+ session_close sid=${s.session_id} took=\\d+ms ok$`));
  }, 15_000);

  test("a failed call logs err=<CODE> and appends exactly one line", async () => {
    const before = auditLines(state).length;
    const err = await callToolErr(client, "session_shell", { session_id: "deadbeef", command: "echo nope" });
    expect(err.code).toBe("SESSION_NOT_FOUND");

    const lines = auditLines(state);
    expect(lines).toHaveLength(before + 1);
    expect(lines[lines.length - 1]).toMatch(
      /^\S+ session_shell sid=deadbeef cmd=echo nope took=\d+ms err=SESSION_NOT_FOUND$/,
    );
  }, 15_000);

  test("an unknown tool audits err=UNKNOWN_TOOL with no detail", async () => {
    const err = await callToolErr(client, "session_shellx", {});
    expect(err.code).toBe("UNKNOWN_TOOL");
    expect(auditLines(state).at(-1)).toMatch(/^\S+ session_shellx took=\d+ms err=UNKNOWN_TOOL$/);
  }, 15_000);
});
