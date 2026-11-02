// tests/mmin-phase1.test.ts — M-min phase 1 end-to-end verification.
//
// On this host (Docker + local image only): starts the real daemon as a
// subprocess (kernel-picked port), talks MCP over Streamable HTTP, and walks
// the core loop: create -> noVNC URL (HTTP 200) -> shell (a11y granted,
// chromium, snapshot refs, persistence, output cap, timeout-kill) -> workspace
// bind -> close -> container/bash gone -> list reflects everything.
//
// Run: bun test tests/mmin-phase1.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDaemon, type Daemon } from "./helpers.js";

let client: Client;
let daemon: Daemon;
let stateDir: string;
const created: string[] = []; // session ids created by this run (cleanup safety)

async function sh(args: string[]): Promise<{ rc: number; stdout: string }> {
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { rc: await proc.exited, stdout };
}

async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return res.structuredContent ?? JSON.parse(text);
}

async function callErr(name: string, args: Record<string, unknown>): Promise<{ code: string }> {
  const res: any = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  return JSON.parse(res.content[0].text);
}

beforeAll(async () => {
  // Test image policy: micke:latest is the default; retag the verified local image.
  const tags = await sh(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (!tags.stdout.includes("micke:latest")) {
    expect(tags.stdout).toContain("micke:novnc");
    expect((await sh(["docker", "tag", "micke:novnc", "micke:latest"])).rc).toBe(0);
  }
  stateDir = mkdtempSync(join(tmpdir(), "micke-test-state-"));
  daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
  client = await daemon.connect("micke-test");
}, 60_000);

afterAll(async () => {
  for (const id of created) await client.callTool({ name: "session_close", arguments: { session_id: id } }).catch(() => {});
  await client.close().catch(() => {});
  await daemon.terminate().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

test(
  "M-min phase 1: supervisor + 4 tools + persistent shell, end to end",
  async () => {
    // --- 1. session_create: ready + novnc_url --------------------------------
    const tCreate = Date.now();
    const a = await call("session_create");
    created.push(a.session_id);
    const bootMs = Date.now() - tCreate;
    console.log(`create -> session=${a.session_id} boot=${bootMs}ms url=${a.novnc_url}`);
    expect(a.session_id).toMatch(/^[0-9a-f]{8}$/);
    expect(a.status).toBe("ready");
    expect(a.novnc_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html$/);

    // --- 2. noVNC URL reachable: HTTP 200 (port allocation end-to-end) ------
    const page = await fetch(a.novnc_url);
    const body = await page.text();
    console.log(`noVNC ${a.novnc_url} -> HTTP ${page.status}`);
    expect(page.status).toBe(200);
    expect(body.toLowerCase()).toContain("novnc");

    // --- 3. shell: env auto-sourced, accessibility granted -------------------
    const status = JSON.parse((await call("session_shell", {
      session_id: a.session_id,
      command: "agent-desktop status",
    })).stdout);
    console.log(`agent-desktop status -> accessibility=${status.data.permissions.accessibility.state}`);
    expect(status.ok).toBe(true);
    expect(status.data.permissions.accessibility.state).toBe("granted");

    // documented explicit form works too
    const status2 = JSON.parse((await call("session_shell", {
      session_id: a.session_id,
      command: ". /tmp/session.env && agent-desktop status",
    })).stdout);
    expect(status2.data.permissions.accessibility.state).toBe("granted");

    // --- 4. shell: launch chromium, wait, snapshot ---------------------------
    const launch = JSON.parse((await call("session_shell", {
      session_id: a.session_id,
      command: "micke-chromium https://example.com",
      timeout_ms: 60_000,
    })).stdout);
    expect(launch.ok).toBe(true);

    const wait = JSON.parse((await call("session_shell", {
      session_id: a.session_id,
      command: 'agent-desktop wait --window "Example Domain" --app chromium --timeout 20000',
      timeout_ms: 30_000,
    })).stdout);
    expect(wait.data.found).toBe(true);

    const snap = JSON.parse((await call("session_shell", {
      session_id: a.session_id,
      command: "agent-desktop snapshot --app chromium -i --compact",
      timeout_ms: 60_000,
      max_output_bytes: 1_048_576,
    })).stdout);
    console.log(`snapshot -> ref_count=${snap.data.ref_count}`);
    expect(snap.ok).toBe(true);
    expect(snap.data.ref_count).toBeGreaterThan(50);

    // --- 5. shell: cwd + exported env persist --------------------------------
    await call("session_shell", { session_id: a.session_id, command: "cd /tmp && export MICKE_FOO=bar" });
    const p1 = await call("session_shell", { session_id: a.session_id, command: "pwd" });
    const p2 = await call("session_shell", { session_id: a.session_id, command: "echo $MICKE_FOO" });
    console.log(`persistence -> pwd=${p1.stdout.trim()} FOO=${p2.stdout.trim()}`);
    expect(p1.stdout.trim()).toBe("/tmp");
    expect(p2.stdout.trim()).toBe("bar");

    // --- 6. shell: output cap with explicit marker ---------------------------
    const big = await call("session_shell", {
      session_id: a.session_id,
      command: "head -c 400000 /dev/zero | tr '\\0' x",
      timeout_ms: 30_000,
      max_output_bytes: 65_536,
    });
    const cut = big.stdout.match(/…\[truncated (\d+) bytes\]/);
    console.log(`cap -> stdout=${big.stdout.length}B dropped=${cut?.[1]}B truncated=${JSON.stringify(big.truncated)}`);
    expect(big.truncated.stdout).toBe(true);
    expect(parseInt(cut![1], 10)).toBe(400000 - 65_536); // 334464
    expect(big.stdout.length).toBeLessThanOrEqual(65_536 + 64);

    // --- 7. shell: timeout kills the command, never the shell ----------------
    const t0 = Date.now();
    const timed = await call("session_shell", {
      session_id: a.session_id,
      command: "sleep 30",
      timeout_ms: 2_000,
    });
    const timeoutMs = Date.now() - t0;
    console.log(`timeout -> rc=${timed.rc} timed_out=${timed.timed_out} wall=${timeoutMs}ms`);
    expect(timed.timed_out).toBe(true);
    expect(timed.rc).not.toBe(0);
    expect(timeoutMs).toBeGreaterThan(1_800);
    expect(timeoutMs).toBeLessThan(8_000);

    const alive = await call("session_shell", { session_id: a.session_id, command: "echo alive" });
    expect(alive.rc).toBe(0);
    expect(alive.stdout.trim()).toBe("alive");

    // --- 8. list reflects the live session ------------------------------------
    let rows = (await call("session_list")).sessions;
    const rowA = rows.find((r: any) => r.session_id === a.session_id);
    expect(rowA?.status).toBe("ready");
    expect(rowA?.novnc_url).toBe(a.novnc_url);

    // --- 9. workspace bind: write inside, appears on host --------------------
    const ws = mkdtempSync(join(tmpdir(), "micke-ws-"));
    const b = await call("session_create", { workspace: ws });
    created.push(b.session_id);
    expect(b.status).toBe("ready");
    expect(b.novnc_port ?? parseInt(b.novnc_url.match(/:(\d+)\//)![1], 10)).not.toBe(
      parseInt(a.novnc_url.match(/:(\d+)\//)![1], 10),
    );
    await call("session_shell", {
      session_id: b.session_id,
      command: "echo hello-from-container > /workspace/phase1.txt",
    });
    const hostFile = readFileSync(join(ws, "phase1.txt"), "utf8");
    console.log(`workspace bind -> host read "${hostFile.trim()}" from ${ws}/phase1.txt`);
    expect(hostFile).toBe("hello-from-container\n");
    rmSync(ws, { recursive: true, force: true });

    // --- 10. close: container gone, bash gone, list updated -------------------
    const tClose = Date.now();
    const closed = await call("session_close", { session_id: a.session_id });
    const teardownMs = Date.now() - tClose;
    console.log(`close -> container_removed=${closed.container_removed} teardown=${teardownMs}ms`);

    const left = await sh(["docker", "ps", "-a", "--filter", `label=micke.session=${a.session_id}`, "--format", "{{.ID}}"]);
    expect(left.stdout.trim()).toBe(""); // container gone
    const strays = await sh(["pgrep", "-f", `micke-${a.session_id}`]);
    expect(strays.rc).not.toBe(0); // no docker-exec/bash client left

    rows = (await call("session_list")).sessions;
    expect(rows.find((r: any) => r.session_id === a.session_id)).toBeUndefined();
    expect(rows.find((r: any) => r.session_id === b.session_id)?.status).toBe("ready");

    // --- 11. structured errors -------------------------------------------------
    expect((await callErr("session_close", { session_id: "deadbeef" })).code).toBe("SESSION_NOT_FOUND");
    expect((await callErr("session_shell", { session_id: "deadbeef", command: "x" })).code).toBe("SESSION_NOT_FOUND");
    expect((await callErr("session_create", { workspace: "/nonexistent/xyz" })).code).toBe("WORKSPACE_INVALID");
    expect((await callErr("session_create", { workspace: "relative/path" })).code).toBe("WORKSPACE_INVALID");

    // --- 12. teardown of remaining session ------------------------------------
    const tCloseB = Date.now();
    await call("session_close", { session_id: b.session_id });
    console.log(`close B -> teardown=${Date.now() - tCloseB}ms`);
    const finalRows = (await call("session_list")).sessions;
    expect(finalRows.length).toBe(0);

    // --- 13. orphan detection: container outliving the supervisor ------------
    // Start a session, kill the DAEMON (simulated supervisor death), restart,
    // and confirm the container is listed as orphaned, then reaped. Orphans
    // stay list/close-only for now — re-attach lands with the gvx runtime
    // swap (docs/research/gvx-only-analysis.md §10).
    const c = await call("session_create");
    created.push(c.session_id);
    await client.close();
    await daemon.kill(); // SIGKILL: the container stays, becoming an orphan
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir }); // new ephemeral port
    client = await daemon.connect("micke-test-restart");
    rows = (await call("session_list")).sessions;
    const orphan = rows.find((r: any) => r.session_id === c.session_id);
    console.log(`after supervisor restart -> session ${c.session_id} listed as ${orphan?.status}`);
    expect(orphan?.status).toBe("orphaned");
    expect((await callErr("session_shell", { session_id: c.session_id, command: "echo x" })).code).toBe("SESSION_ORPHANED");
    await call("session_close", { session_id: c.session_id });
    const gone = await sh(["docker", "ps", "-a", "--filter", `label=micke.session=${c.session_id}`, "--format", "{{.ID}}"]);
    expect(gone.stdout.trim()).toBe("");
    console.log(`orphan reaped via session_close`);
    expect((await call("session_list")).sessions.length).toBe(0);
  },
  300_000,
);
