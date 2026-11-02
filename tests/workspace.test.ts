// tests/workspace.test.ts — the /workspace permission rule, without a sandbox.
//
// On macOS the host uid (501) differs from the guest uid (1000) and chown to
// 1000 is impossible, so the decision is a pure function over stat data. These
// tests cover the three ways a directory can grant (or deny) write access.

import { describe, expect, test } from "bun:test";
import { guestCanWrite, guestIds } from "../src/workspace.js";

const OTHER = { uid: 501, gid: 20 }; // host-owned directory (macOS)
const GUEST_UID = 1000;
const GUEST_GID = 1000;

describe("guestCanWrite", () => {
  test("foreign uid + 0755 is NOT writable (the original bug)", () => {
    expect(guestCanWrite({ ...OTHER, mode: 0o40755 }, GUEST_UID, GUEST_GID)).toBe(false);
  });

  test("foreign uid + 0777 is writable", () => {
    expect(guestCanWrite({ ...OTHER, mode: 0o40777 }, GUEST_UID, GUEST_GID)).toBe(true);
  });

  test("own uid + 0700 is writable", () => {
    expect(guestCanWrite({ uid: GUEST_UID, gid: 4242, mode: 0o40700 }, GUEST_UID, GUEST_GID)).toBe(true);
  });

  test("matching group uses the group bits", () => {
    expect(guestCanWrite({ uid: 501, gid: GUEST_GID, mode: 0o40770 }, GUEST_UID, GUEST_GID)).toBe(true);
    expect(guestCanWrite({ uid: 501, gid: GUEST_GID, mode: 0o40750 }, GUEST_UID, GUEST_GID)).toBe(false);
  });

  test("write without search (x) is not enough to create entries", () => {
    expect(guestCanWrite({ uid: GUEST_UID, gid: GUEST_GID, mode: 0o40644 }, GUEST_UID, GUEST_GID)).toBe(false);
  });

  test("the file-type bits in st_mode are ignored", () => {
    expect(guestCanWrite({ ...OTHER, mode: 0o120777 }, GUEST_UID, GUEST_GID)).toBe(true);
  });
});

describe("guestIds", () => {
  test("defaults to 1000:1000", () => {
    expect(guestIds({})).toEqual({ uid: 1000, gid: 1000 });
  });

  test("MICKE_GUEST_UID/GID override the defaults", () => {
    expect(guestIds({ MICKE_GUEST_UID: "1500", MICKE_GUEST_GID: "1600" })).toEqual({ uid: 1500, gid: 1600 });
  });

  test("a malformed override fails loudly instead of silently using 1000", () => {
    expect(() => guestIds({ MICKE_GUEST_UID: "agent" })).toThrow(/MICKE_GUEST_UID/);
  });
});
