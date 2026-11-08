// tests/release-script.test.ts — the release script's pure surface.
//
// scripts/release.ts drives git, the network, gh and worktrees — none of
// that belongs in the fast tier (it would mutate the repo and cut real
// releases). The script keeps its decision policy in pure exports
// (nextTag, validTag, classifySubjects) exactly so this suite can pin the
// bump rules and the tag grammar hermetically; the imperative flow is the
// maintainer's manual verification (--dry-run), not a test.
//
// Importing the module is side-effect free (the flow runs only under
// import.meta.main), so this file can import it directly.
// Fast tier: no network, no gh, no worktrees, no git.

import { describe, expect, test } from "bun:test";
import { classifySubjects, nextTag, validTag } from "../scripts/release.js";

describe("nextTag (release script)", () => {
  test("no last tag → seeds package.json's version verbatim, even over breaking subjects", () => {
    expect(nextTag(["feat!: rewrite everything"], null, "0.1.0")).toBe("v0.1.0");
    expect(nextTag([], null, "0.1.0")).toBe("v0.1.0");
  });

  test("feat subjects → minor bump", () => {
    expect(nextTag(["feat: sessions", "fix: audit"], "v0.2.0", "0.1.0")).toBe("v0.3.0");
  });

  test("only fix/docs/chore/test subjects → patch bump", () => {
    expect(nextTag(["fix: leak", "docs: readme", "chore: deps", "test: flake"], "v1.2.3", "0.1.0")).toBe("v1.2.4");
  });

  test("feat!/fix(scope)! → major bump; breaking beats feat in a mixed list", () => {
    expect(nextTag(["feat!: drop MCP"], "v1.2.3", "0.1.0")).toBe("v2.0.0");
    expect(nextTag(["fix(api)!: payload shape", "feat: unrelated"], "v1.2.3", "0.1.0")).toBe("v2.0.0");
  });

  test("scoped feat feat(api): … → minor (the scope parens must not break the match)", () => {
    expect(nextTag(["feat(api): new endpoint"], "v0.1.0", "0.1.0")).toBe("v0.2.0");
  });
});

describe("classifySubjects (release script)", () => {
  test("unconventional = no known type at all; conventional-but-patch types are not flagged", () => {
    const r = classifySubjects(["wip stuff", "revert last commit", "docs: readme", "chore(ci): bump deps"]);
    expect(r.unconventional).toEqual(["wip stuff", "revert last commit"]);
  });

  test("`!` is honored only on the four bump types — docs!: is conventional, non-breaking (patch)", () => {
    const r = classifySubjects(["docs!: rewrite everything", "chore!: restructure"]);
    expect(r.breaking).toBe(false);
    expect(r.unconventional).toEqual([]);
  });

  test("`!` on fix/perf/refactor is breaking; only feat (with or without `!`) sets feature", () => {
    const r = classifySubjects(["fix(a)!: payload", "perf!: faster", "refactor!: leaner", "feat: new"]);
    expect(r.breaking).toBe(true);
    expect(r.feature).toBe(true);
    expect(classifySubjects(["fix: plain"]).feature).toBe(false);
  });
});

describe("validTag (release script)", () => {
  test("accepts strict vMAJOR.MINOR.PATCH", () => {
    expect(validTag("v1.2.3")).toBe(true);
  });

  test("rejects 1.2.3, v1.2, v1.2.3-rc.1, v1.2.3+build", () => {
    expect(validTag("1.2.3")).toBe(false); // no v — release.yml triggers on v*
    expect(validTag("v1.2")).toBe(false); // not semver-triple
    expect(validTag("v1.2.3-rc.1")).toBe(false); // prerelease confuses git describe ordering
    expect(validTag("v1.2.3+build")).toBe(false); // build suffix: never a release
  });
});
