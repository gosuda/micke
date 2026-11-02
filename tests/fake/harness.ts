// tests/fake/harness.ts — fast-tier session harness.
//
// Spawns the real daemon (src/main.ts) on a kernel-picked port with
// MICKE_RUNGV pointed at tests/fake/rungv. The daemon, HTTP/MCP transport,
// supervisor, pidfiles and shell client are the production code; only the
// guest and the gvx process are replaced. Each harness gets its own state dir,
// so suites can run beside a real micke daemon without touching it.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDaemon, type Daemon } from "../helpers.js";

export const FAKE_RUNGV = join(import.meta.dir, "rungv");

export interface FakeState {
  stateDir: string;
  shellLog: string;
  rungvLog: string;
  cleanup(): void;
}

export function fakeState(prefix = "micke-fake-"): FakeState {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  return {
    stateDir,
    shellLog: join(stateDir, "fake-shell.jsonl"),
    rungvLog: join(stateDir, "fake-rungv.jsonl"),
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

/** Spawn the real daemon against the fake rungv; extra env wins. */
export function spawnFakeDaemon(
  state: FakeState,
  extra: Record<string, string> = {},
): Promise<Daemon> {
  return spawnDaemon({
    MICKE_STATE_DIR: state.stateDir,
    MICKE_RUNGV: FAKE_RUNGV,
    MICKE_IMAGE: "micke-fake:test",
    MICKE_GVX_CACHE: join(state.stateDir, "gvx-cache"),
    MICKE_FAKE_SHELL_LOG: state.shellLog,
    MICKE_FAKE_RUNGV_LOG: state.rungvLog,
    MICKE_MIN_FREE_MB: "0", // the floor has its own test; never refuse here
    MICKE_BOOT_TIMEOUT_MS: "5000",
    ...extra,
  });
}

export interface JsonLine {
  [key: string]: any;
}

/** Read a JSONL event log (missing file = no events yet). */
export function readEvents(path: string): JsonLine[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function shellEvents(state: FakeState): JsonLine[] {
  return readEvents(state.shellLog);
}

export function rungvEvents(state: FakeState): JsonLine[] {
  return readEvents(state.rungvLog);
}
