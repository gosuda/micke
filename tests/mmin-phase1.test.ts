// tests/mmin-phase1.test.ts — M-min phase 1 end-to-end verification.
//
// On this host (gvx + a cached micke image): starts the real daemon as a
// subprocess (kernel-picked port), talks MCP over Streamable HTTP, and walks
// the core loop: create -> noVNC URL (HTTP 200) -> shell (a11y granted,
// chromium, snapshot refs, statelessness/PATH regression, output cap,
// timeout-kill) -> workspace bind -> close -> rungv/pidfile gone -> list
// reflects everything. The full stateless contract (concurrency, nohup,
// cwd:) lives in tests/stateless-shell.test.ts. The final block kills the
// daemon, restarts it, and proves ADOPTION: the desktop survives and a fresh
// shell re-attaches to the still-booted chromium.
//
// Run: bun test tests/mmin-phase1.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { chmodSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureImage, sh, spawnDaemon, type Daemon } from "./helpers.js";

let client: Client;
let daemon: Daemon;
let stateDir: string;
const created: string[] = []; // session ids created by this run (cleanup safety)

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

function pidfile(id: string): string {
  return join(stateDir, "sessions", `${id}.json`);
}

/**
 * A /workspace write must succeed with rc=0; when it does not, stderr must
 * carry the reason ("Permission denied", ...). Otherwise the host read below
 * fails as an unrelated ENOENT and hides the real cause.
 */
function expectWriteOk(r: { rc: number; stderr: string }): void {
  if (r.rc !== 0) expect(r.stderr.trim()).not.toBe("");
  expect(r.rc).toBe(0);
}

beforeAll(async () => {
  await ensureImage();
  stateDir = mkdtempSync(join(tmpdir(), "micke-test-state-"));
  daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
  client = await daemon.connect("micke-test");
}, 600_000);

afterAll(async () => {
  for (const id of created) await client.callTool({ name: "session_close", arguments: { session_id: id } }).catch(() => {});
  await client.close().catch(() => {});
  await daemon.terminate().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

test(
  "M-min phase 1: supervisor + 4 tools + stateless shell + adoption, end to end",
  async () => {
    // --- 1. session_create: ready + novnc_url --------------------------------
    const tCreate = Date.now();
    const a = await call("session_create");
    created.push(a.session_id);
    const bootMs = Date.now() - tCreate;
    console.log(`create -> session=${a.session_id} boot=${bootMs}ms url=${a.novnc_url} pid=${a.rungv_pid}`);
    expect(a.session_id).toMatch(/^[0-9a-f]{8}$/);
    expect(a.status).toBe("ready");
    expect(a.novnc_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html$/);
    expect(existsSync(pidfile(a.session_id))).toBe(true);

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

    // The a11y tree is still settling right after the window appears: the
    // first snapshot can carry only browser chrome (no page content) before the
    // page subtree is exposed. Retry up to 3x and require the page's own
    // content in the tree — a broken page/browser still fails every attempt.
    let snap: any;
    let pageContent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      snap = JSON.parse((await call("session_shell", {
        session_id: a.session_id,
        command: "agent-desktop snapshot --app chromium -i --compact",
        timeout_ms: 60_000,
        max_output_bytes: 1_048_576,
      })).stdout);
      pageContent = false;
      let linkName = "";
      const walk = (n: any) => {
        if (!n) return;
        // `-i` keeps interactive elements, so the page's own link is the page
        // signal; browser chrome carries no links.
        if (String(n.role ?? "") === "link" && String(n.name ?? "").trim() !== "") {
          pageContent = true;
          linkName = String(n.name);
        }
        for (const ch of n.children ?? []) walk(ch);
      };
      walk(snap.data.tree);
      console.log(`snapshot[${attempt}] -> ref_count=${snap.data.ref_count} page_link=${JSON.stringify(linkName)}`);
      if (pageContent) break;
      await Bun.sleep(1_000);
    }
    expect(snap.ok).toBe(true);
    expect(pageContent).toBe(true); // the page itself is in the a11y tree

    // --- 5. shell: stateless touch-points -----------------------------------
    // The full contract lives in tests/stateless-shell.test.ts (one session).
    // Here: the two properties that shape every agent call — no cwd/env
    // carry-over, and the old PATH-replay bug cannot poison the next call.
    await call("session_shell", { session_id: a.session_id, command: "cd /tmp && export MICKE_FOO=bar" });
    const p1 = await call("session_shell", { session_id: a.session_id, command: "pwd" });
    const p2 = await call("session_shell", {
      session_id: a.session_id,
      command: 'echo "${MICKE_FOO:-unset}"',
    });
    expect(p1.stdout.trim()).toBe("/home/agent");
    expect(p2.stdout.trim()).toBe("unset");

    // The removed wrapper replayed exported env into a long-lived bash and
    // unset changed vars before resolving comm/grep/sed through PATH, so this
    // left PATH=[] and every later call died at mktemp (empty frame, rc 1).
    const poison = await call("session_shell", {
      session_id: a.session_id,
      command: "export PATH=/nonexistent",
    });
    expect(poison.rc).toBe(0);
    const afterPath = await call("session_shell", { session_id: a.session_id, command: "echo ok" });
    console.log(`PATH regression -> rc=${afterPath.rc} stdout=${JSON.stringify(afterPath.stdout)}`);
    expect(afterPath.rc).toBe(0);
    expect(afterPath.stdout.trim()).toBe("ok");

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

    // --- 7. shell: timeout kills the command, leaves no stray process ---------
    const t0 = Date.now();
    const timed = await call("session_shell", {
      session_id: a.session_id,
      command: "sleep 300",
      timeout_ms: 1_000,
    });
    const timeoutMs = Date.now() - t0;
    console.log(`timeout -> rc=${timed.rc} timed_out=${timed.timed_out} wall=${timeoutMs}ms`);
    expect(timed.timed_out).toBe(true);
    expect(timed.rc).not.toBe(0);
    expect(timeoutMs).toBeGreaterThan(800);
    expect(timeoutMs).toBeLessThan(8_000);
    await Bun.sleep(300); // the watchdog's KILL escalation needs a beat
    const strays = await call("session_shell", {
      session_id: a.session_id,
      command: "pgrep -f 'sleep 300' | wc -l",
    });
    console.log(`timeout strays -> ${JSON.stringify(strays.stdout.trim())}`);
    expect(strays.stdout.trim()).toBe("0");

    const alive = await call("session_shell", { session_id: a.session_id, command: "echo alive" });
    expect(alive.rc).toBe(0);
    expect(alive.stdout.trim()).toBe("alive");

    // --- 8. list reflects the live session ------------------------------------
    let rows = (await call("session_list")).sessions;
    const rowA = rows.find((r: any) => r.session_id === a.session_id);
    expect(rowA?.status).toBe("ready");
    expect(rowA?.novnc_url).toBe(a.novnc_url);

    // --- 9. workspace bind: write inside, appears on host --------------------
    // Default (no `workspace` argument): the receipt still carries a host dir,
    // so artifacts are retrievable without a base64 round-trip.
    expect(a.workspace).toBeTruthy();
    expect(existsSync(a.workspace)).toBe(true);
    const defaultWrite = await call("session_shell", {
      session_id: a.session_id,
      command: "echo default-workspace > /workspace/default.txt",
    });
    // The write itself must succeed: a later ENOENT on the host read would
    // otherwise blame the mount for what is really a guest permission error.
    expectWriteOk(defaultWrite);
    expect(readFileSync(join(a.workspace, "default.txt"), "utf8")).toBe("default-workspace\n");
    console.log(`default workspace -> host read from ${a.workspace}/default.txt`);

    const ws = mkdtempSync(join(tmpdir(), "micke-ws-"));
    // Explicit workspaces are checked, not rewritten: the guest (uid 1000)
    // must be able to write, and mkdtemp's 0700 owner-only mode is invisible
    // to it across the uid-unmapped mount. This chmod is part of the contract.
    chmodSync(ws, 0o777);
    const b = await call("session_create", { workspace: ws });
    created.push(b.session_id);
    expect(b.status).toBe("ready");
    expect(b.novnc_url).not.toBe(a.novnc_url);
    const explicitWrite = await call("session_shell", {
      session_id: b.session_id,
      command: "echo hello-from-sandbox > /workspace/phase1.txt",
    });
    expectWriteOk(explicitWrite);
    const hostFile = readFileSync(join(ws, "phase1.txt"), "utf8");
    console.log(`workspace bind -> host read "${hostFile.trim()}" from ${ws}/phase1.txt`);
    expect(hostFile).toBe("hello-from-sandbox\n");
    rmSync(ws, { recursive: true, force: true });

    // --- 10. close: sandbox gone, pidfile gone, list updated ------------------
    const tClose = Date.now();
    const closed = await call("session_close", { session_id: a.session_id });
    const teardownMs = Date.now() - tClose;
    console.log(`close -> sandbox_removed=${closed.sandbox_removed} teardown=${teardownMs}ms`);

    expect(closed.sandbox_removed).toBe(true);
    expect(existsSync(pidfile(a.session_id))).toBe(false);
    const left = await sh(["pgrep", "-f", `rungv run .*micke-${a.session_id}`]);
    expect(left.rc).not.toBe(0); // no rungv process left

    rows = (await call("session_list")).sessions;
    expect(rows.find((r: any) => r.session_id === a.session_id)).toBeUndefined();
    expect(rows.find((r: any) => r.session_id === b.session_id)?.status).toBe("ready");

    // --- 11. structured errors -------------------------------------------------
    expect((await callErr("session_close", { session_id: "deadbeef" })).code).toBe("SESSION_NOT_FOUND");
    expect((await callErr("session_shell", { session_id: "deadbeef", command: "x" })).code).toBe("SESSION_NOT_FOUND");
    expect((await callErr("session_create", { workspace: "/nonexistent/xyz" })).code).toBe("WORKSPACE_INVALID");
    expect((await callErr("session_create", { workspace: "relative/path" })).code).toBe("WORKSPACE_INVALID");
    // A user-supplied workspace the guest cannot write is rejected up front,
    // with the chmod remedy — not left to fail on the first /workspace write.
    // 0555 fails for the owner too, so this holds regardless of host uid.
    const ro = mkdtempSync(join(tmpdir(), "micke-ro-ws-"));
    chmodSync(ro, 0o555);
    expect((await callErr("session_create", { workspace: ro })).code).toBe("WORKSPACE_NOT_WRITABLE");
    chmodSync(ro, 0o755);
    rmSync(ro, { recursive: true, force: true });

    // --- 12. teardown of remaining session ------------------------------------
    const tCloseB = Date.now();
    await call("session_close", { session_id: b.session_id });
    console.log(`close B -> teardown=${Date.now() - tCloseB}ms`);
    const finalRows = (await call("session_list")).sessions;
    expect(finalRows.length).toBe(0);

    // --- 13. daemon death + adoption: the desktop outlives the supervisor -----
    // Create + launch chromium, SIGKILL the daemon, restart on the same state
    // dir: the pidfile's pid+ports are enough to ADOPT the still-running
    // sandbox. A fresh bash re-attaches (stateless: default cwd/env), and the
    // chromium window from before the crash is still there.
    const c = await call("session_create");
    created.push(c.session_id);
    await call("session_shell", {
      session_id: c.session_id,
      command: "micke-chromium https://example.com",
      timeout_ms: 60_000,
    });
    const preWait = JSON.parse((await call("session_shell", {
      session_id: c.session_id,
      command: 'agent-desktop wait --window "Example Domain" --app chromium --timeout 20000',
      timeout_ms: 30_000,
    })).stdout);
    expect(preWait.data.found).toBe(true);

    await client.close();
    await daemon.kill(); // SIGKILL: the rungv child stays alive (no parent-death semantics)
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir }); // new ephemeral port
    client = await daemon.connect("micke-test-restart");

    rows = (await call("session_list")).sessions;
    const adopted = rows.find((r: any) => r.session_id === c.session_id);
    console.log(`after daemon restart -> session ${c.session_id} listed as ${adopted?.status} url=${adopted?.novnc_url}`);
    expect(adopted?.status).toBe("ready"); // adopted, not orphaned
    expect(adopted?.novnc_url).toBe(c.novnc_url); // ports survived in the pidfile

    const fresh = await call("session_shell", { session_id: c.session_id, command: "pwd" });
    expect(fresh.rc).toBe(0);
    expect(fresh.stdout.trim()).toBe("/home/agent"); // fresh bash, exec parity

    const postWait = JSON.parse((await call("session_shell", {
      session_id: c.session_id,
      command: 'agent-desktop wait --window "Example Domain" --app chromium --timeout 5000',
    })).stdout);
    expect(postWait.data.found).toBe(true); // the desktop survived the crash

    await call("session_close", { session_id: c.session_id });
    expect(existsSync(pidfile(c.session_id))).toBe(false);
    expect((await call("session_list")).sessions.length).toBe(0);
    console.log("adoption proof complete: desktop survived daemon death and was re-attached");
  },
  300_000,
);
