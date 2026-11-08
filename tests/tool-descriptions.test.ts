// tests/tool-descriptions.test.ts — the CLI pointers in the MCP surface.
//
// d000d49 shrank the tool descriptions to what an agent cannot discover on
// its own. That minimum now includes the web/desktop split — agent-browser
// for web/Chromium work, agent-desktop for other desktop apps — because the
// description is the only pointer a zero-context agent gets before it opens
// a shell. Guard both names so a future description pass cannot silently
// drop a CLI from the surface. The VNC hint gets the same guard: the
// desktop being live and human-interactive over noVNC is equally
// undiscoverable, and it is why the CLIs' visible windows are a feature.
// Fast tier: the fake rungv, no sandbox.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type Daemon } from "./helpers.js";
import { fakeState, spawnFakeDaemon, type FakeState } from "./fake/harness.js";

describe("session_shell's description names both agent CLIs", () => {
  const state = fakeState("micke-desc-");
  let daemon: Daemon;
  let client: Client;

  beforeAll(async () => {
    daemon = await spawnFakeDaemon(state);
    client = await daemon.connect("micke-desc");
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await daemon?.terminate().catch(() => {});
    state.cleanup();
  }, 30_000);

  test("the description points at agent-browser and agent-desktop", async () => {
    const listed = await client.listTools();
    const shell = listed.tools.find((t) => t.name === "session_shell");
    expect(shell, "session_shell missing from tools/list").toBeDefined();
    expect(shell!.description).toContain("agent-browser");
    expect(shell!.description).toContain("agent-desktop");
    expect(shell!.description).toContain("VNC");
  }, 15_000);
});
