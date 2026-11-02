// tests/e2e/workspace.test.ts — the /workspace writability contract, real.
//
// Unit tests can decide guestCanWrite() from stat data, but only a real
// sandbox proves the mounted directory is actually writable by the guest uid
// and that the file appears on the host. This is the one workspace check that
// must stay in the E2E tier: guest uid vs host mode across gvx's mount.
//
// Run: MICKE_E2E=1 bun test tests/e2e/workspace.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E, callTool, callToolErr, ensureImage, spawnDaemon, type Daemon } from "../helpers.js";

describe.skipIf(!E2E)("e2e: workspace writability", () => {
  let daemon: Daemon;
  let client: Client;
  let stateDir: string;

  beforeAll(async () => {
    await ensureImage();
    stateDir = mkdtempSync(join(tmpdir(), "micke-e2e-ws-"));
    daemon = await spawnDaemon({ MICKE_STATE_DIR: stateDir });
    client = await daemon.connect("micke-e2e-ws");
  }, 600_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  test("the auto-created workspace is writable in the guest and visible on the host", async () => {
    const s = await callTool<any>(client, "session_create");
    try {
      expect(existsSync(s.workspace)).toBe(true);
      const r = await callTool<any>(client, "session_shell", {
        session_id: s.session_id,
        command: "echo default-workspace > /workspace/default.txt",
      });
      // A failed write must carry its reason; otherwise the host read below
      // fails as an unrelated ENOENT and hides the real cause.
      if (r.rc !== 0) expect(r.stderr.trim()).not.toBe("");
      expect(r.rc).toBe(0);
      expect(readFileSync(join(s.workspace, "default.txt"), "utf8")).toBe("default-workspace\n");
    } finally {
      await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
    }
  }, 180_000);

  test("an explicit 0777 workspace accepts a guest write that lands on the host", async () => {
    const ws = mkdtempSync(join(tmpdir(), "micke-e2e-ws-explicit-"));
    chmodSync(ws, 0o777); // mkdtemp's 0700 is invisible to the uid-1000 guest
    try {
      const s = await callTool<any>(client, "session_create", { workspace: ws });
      try {
        const r = await callTool<any>(client, "session_shell", {
          session_id: s.session_id,
          command: "echo hello-from-sandbox > /workspace/phase1.txt",
        });
        if (r.rc !== 0) expect(r.stderr.trim()).not.toBe("");
        expect(r.rc).toBe(0);
        expect(readFileSync(join(ws, "phase1.txt"), "utf8")).toBe("hello-from-sandbox\n");
      } finally {
        await callTool(client, "session_close", { session_id: s.session_id }).catch(() => {});
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  test("a workspace the guest cannot write is refused before a sandbox boots", async () => {
    const ro = mkdtempSync(join(tmpdir(), "micke-e2e-ws-ro-"));
    chmodSync(ro, 0o555); // no w for the owner either: portable across host uids
    try {
      const err = await callToolErr(client, "session_create", { workspace: ro });
      expect(err.code).toBe("WORKSPACE_NOT_WRITABLE");
      expect(err.hint).toContain("chmod -R a+w");
    } finally {
      chmodSync(ro, 0o755);
      rmSync(ro, { recursive: true, force: true });
    }
  }, 30_000);
});
