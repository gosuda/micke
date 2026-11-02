// tests/shell-protocol.test.ts — the session_shell wire contract, fast.
//
// The shell client, frame parser, cwd validation and concurrency limiter are
// host code; only the guest is replaced. tests/fake/guest.ts speaks the guest
// half of the protocol byte-for-byte, so these tests cover framing, timeouts,
// truncation, non-zero rc, cwd, mid-frame death and the concurrency cap without
// booting a gvx sandbox or pulling an image.
//
// Why this file exists: the old mega-test wrapped all of this in one
// `test(...)`, so a failure named nothing and agents re-ran the whole
// real-image suite to find it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, callToolErr, type Daemon } from "./helpers.js";
import { fakeState, shellEvents, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

const state: FakeState = fakeState("micke-shell-proto-");
let daemon: Daemon;
let client: Client;
let client2: Client;
let sessionId: string;

const shell = (command: string, extra: Record<string, unknown> = {}, on: Client = client) =>
  callTool<any>(on, "session_shell", { session_id: sessionId, command, ...extra });

beforeAll(async () => {
  // Cap 2 makes the oversubscription test cheap and unambiguous.
  daemon = await spawnFakeDaemon(state, { MICKE_SHELL_CONCURRENCY: "2" });
  client = await daemon.connect("micke-shell-proto-a");
  client2 = await daemon.connect("micke-shell-proto-b");
  const s = await callTool<any>(client, "session_create");
  sessionId = s.session_id;
}, 30_000);

afterAll(async () => {
  await callTool(client, "session_close", { session_id: sessionId }).catch(() => {});
  await client?.close().catch(() => {});
  await client2?.close().catch(() => {});
  await daemon?.terminate().catch(() => {});
  state.cleanup();
}, 30_000);

describe("frame parsing", () => {
  test("stdout without a trailing newline is preserved exactly", async () => {
    const r = await shell("print aGVsbG8="); // "hello"
    expect(r.stdout).toBe("hello");
    expect(r.stderr).toBe("");
    expect(r.rc).toBe(0);
    expect(r.timed_out).toBe(false);
  });

  test("stdout's own trailing newline is preserved", async () => {
    const r = await shell("print aGVsbG8K"); // "hello\n"
    expect(r.stdout).toBe("hello\n");
  });

  test("stderr is separated from stdout", async () => {
    const r = await shell("stderr boom");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("boom\n");
    expect(r.rc).toBe(0);
  });

  test("a non-zero rc is reported with its stderr", async () => {
    const r = await shell("rc 7");
    expect(r.rc).toBe(7);
    expect(r.stderr).toBe("exit 7\n");
    expect(r.timed_out).toBe(false);
  });
});

describe("timeouts and truncation", () => {
  test("a command past its timeout reports timed_out and a non-zero rc", async () => {
    const t0 = Date.now();
    const r = await shell("sleep 5", { timeout_ms: 150 });
    const wall = Date.now() - t0;
    expect(r.timed_out).toBe(true);
    expect(r.rc).not.toBe(0);
    expect(wall).toBeGreaterThanOrEqual(100);
    expect(wall).toBeLessThan(3_000); // did not wait for the guest's 5 s
  });

  test("the next call still works after a timeout", async () => {
    const r = await shell("echo alive");
    expect(r.stdout).toBe("alive\n");
    expect(r.rc).toBe(0);
  });

  test("output over max_output_bytes is truncated with the dropped byte count", async () => {
    const r = await shell("big 1000", { max_output_bytes: 100 });
    expect(r.truncated.stdout).toBe(true);
    expect(r.stdout).toContain("…[truncated 900 bytes]");
    expect(r.stdout.length).toBeLessThanOrEqual(100 + 64);
  });
});

describe("cwd", () => {
  test("the default cwd is /home/agent", async () => {
    const r = await shell("pwd");
    expect(r.stdout).toBe("/home/agent\n");
  });

  test("cwd: is honored", async () => {
    const r = await shell("pwd", { cwd: "/tmp" });
    expect(r.stdout).toBe("/tmp\n");
  });

  test("a missing cwd fails with CWD_INVALID", async () => {
    const err = await callToolErr(client, "session_shell", {
      session_id: sessionId,
      command: "pwd",
      cwd: "/nonexistent/micke-cwd",
    });
    expect(err.code).toBe("CWD_INVALID");
    expect(err.message).toContain("/nonexistent/micke-cwd");
  });

  test("a relative cwd is rejected as BAD_ARGUMENT", async () => {
    const err = await callToolErr(client, "session_shell", {
      session_id: sessionId,
      command: "pwd",
      cwd: "relative/path",
    });
    expect(err.code).toBe("BAD_ARGUMENT");
  });

  test("an empty cwd is rejected as BAD_ARGUMENT", async () => {
    const err = await callToolErr(client, "session_shell", {
      session_id: sessionId,
      command: "pwd",
      cwd: "",
    });
    expect(err.code).toBe("BAD_ARGUMENT");
  });
});

describe("connection failures", () => {
  test("a guest closing mid-frame is SHELL_UNAVAILABLE", async () => {
    const err = await callToolErr(client, "session_shell", {
      session_id: sessionId,
      command: "die-mid-frame",
    });
    expect(err.code).toBe("SHELL_UNAVAILABLE");
  });

  test("the next call after a mid-frame close is a fresh connection", async () => {
    const r = await shell("echo ok");
    expect(r.stdout).toBe("ok\n");
    expect(r.rc).toBe(0);
  });

  test("a client disconnect does not disturb the session", async () => {
    const c = await daemon.connect("micke-shell-proto-gone");
    await callTool(c, "session_shell", { session_id: sessionId, command: "echo before" });
    await c.close();
    const r = await shell("echo after");
    expect(r.stdout).toBe("after\n");
  });
});

describe("concurrency", () => {
  test("calls run in parallel up to MICKE_SHELL_CONCURRENCY and queue beyond it", async () => {
    const before = shellEvents(state).length;
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        shell("sleep 0.15", {}, i % 2 === 0 ? client : client2),
      ),
    );
    const wall = Date.now() - t0;

    expect(results.map((r: any) => r.rc)).toEqual([0, 0, 0, 0, 0, 0]);
    // 6 x 150 ms over 2 slots: ~450 ms. Serialized would be ~900 ms; fully
    // unbounded would be ~150 ms. The window separates all three.
    expect(wall).toBeGreaterThanOrEqual(350);
    expect(wall).toBeLessThan(1_500);

    const burst = shellEvents(state).slice(before);
    expect(burst.filter((e) => e.ev === "open")).toHaveLength(6);
    expect(Math.max(...burst.map((e) => e.max_active ?? 0))).toBe(2);
  });

  test("two clients on one session get their own frames", async () => {
    const [a, b] = await Promise.all([
      shell("print YQ==", {}, client), // "a"
      shell("print Yg==", {}, client2), // "b"
    ]);
    expect(a.stdout).toBe("a");
    expect(b.stdout).toBe("b");
  });
});
