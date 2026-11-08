// tests/winhide.test.ts — the daemon's Windows console self-hide.
//
// The win32 window dance itself cannot run here (no kernel32.dll off
// Windows — the same deal as the flock FFI in supervisor.ts). What the fast
// tier CAN prove is the null-guard contract: off Windows the loader finds
// no kernel32, and hideConsoleWindow() must return false WITHOUT throwing —
// a cosmetic helper that crashes the daemon on the wrong platform would be
// far worse than a visible window.

import { describe, expect, test } from "bun:test";
import { hideConsoleWindow } from "../src/winhide.js";

describe("hideConsoleWindow", () => {
  test("returns a boolean and never throws, whatever the platform", () => {
    expect(typeof hideConsoleWindow()).toBe("boolean");
    expect(() => hideConsoleWindow()).not.toThrow();
  });

  test("off Windows there is nothing to hide", () => {
    if (process.platform === "win32") return; // the real dance: untestable here
    expect(hideConsoleWindow()).toBe(false);
  });
});
