// scripts/release — cut a release from any git hash, end to end.
//
// WHY a script instead of "remember the incantation": a micke release is a
// chain — hash on origin/main → tests green AT that hash → annotated tag →
// tag push → release.yml → release URL — and every link is easy to get
// subtly wrong: tagging a local-only hash CI can't see, testing a dirty
// HEAD instead of the hash being released, reusing a tag that already
// shipped. This script walks the chain with a guard at each link and the
// remedy inside every failure message, so "run it and it releases the given
// hash" is the whole manual.
//
// Two things it deliberately never does: it never pushes main (the hash
// must already be on origin/main — push it yourself, then run this), and
// it never moves an existing tag — a tag found locally or on the remote
// stops the run with both delete commands in the remedy, because
// overwriting a published tag is exactly how updaters end up downloading
// bytes that no longer match the published SHA256SUMS. The only remote
// write is the one tag push; the release itself is produced by the same
// release.yml a manual `git tag` + push uses — this script is the front
// door, not a second pipeline.
//
// The test gate runs in a `git worktree` detached AT the release SHA:
// HEAD in this checkout may be elsewhere (or dirty), and "what you saw
// green is what releases" only holds if the tier runs against the exact
// commit being tagged.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const die = (msg: string): never => {
  console.error(`micke: ${msg}`);
  process.exit(1);
};

// ---- pure surface (pinned in tests/release-script.test.ts) -------------------
//
// Pure on purpose: the bump policy and the tag grammar are the two things
// worth unit-testing, and testing them must not need git, the network, gh,
// or a worktree — the fast tier stays hermetic.

const BREAKING = /^(feat|fix|perf|refactor)(\([^)]*\))?!:/;
const FEATURE = /^feat(\([^)]*\))?:/;
// Deliberately WIDER than BREAKING: this is the display-time known-type
// list. A subject in conventional shape but of a non-bumping type
// (`docs:`, `ci(image):`) is an ordinary patch, not a suspect — only a
// subject with no recognizable type at all gets called out as
// unconventional.
const KNOWN_TYPE = /^(feat|fix|docs|test|chore|build|ci|perf|refactor|style)(\([^)]*\))?!?:/;

/**
 * Strict vX.Y.Z — no prerelease/build suffixes — and nothing else.
 *
 * Why so strict: `git describe --tags --abbrev=0` (the auto-derivation
 * base) has no ordering guarantee between v1.2.3 and v1.2.3-rc.1, and
 * release.yml triggers on a bare `v*` glob. Keeping every tag strict
 * semver keeps both simple: the nearest tag is always bumpable and every
 * tag ever pushed is a release.
 */
export const validTag = (t: string): boolean => /^v\d+\.\d+\.\d+$/.test(t);

/**
 * Conventional-commit bump from the last tag to the next.
 *
 * Honest limitation: this sees commit SUBJECTS only (`git log --format=%s`),
 * so a plain "BREAKING CHANGE:" footer in a commit body is invisible —
 * mark breaking commits with `!` in the subject (feat!: / fix(scope)!:).
 *
 * lastTag null = first release ever: package.json's version is the seed,
 * verbatim — subjects are irrelevant because there is nothing to bump from.
 */
export const nextTag = (subjects: string[], lastTag: string | null, seedVersion: string): string => {
  if (lastTag === null) return `v${seedVersion}`;
  const m = lastTag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`cannot parse last tag "${lastTag}" as vX.Y.Z`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const { breaking, feature } = classifySubjects(subjects);
  if (breaking) return `v${major + 1}.0.0`;
  if (feature) return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
};

/**
 * One classification pass over the subjects since the last tag — the
 * single source of truth for the bump policy (nextTag), the reason
 * sentence, and the step-[4] visibility line, so what is shown is what
 * fired; the display and the policy cannot drift apart.
 *
 * `unconventional` = subjects matching no known type at all. They count
 * as patch-level by design — and they are exactly where a `feat` mistyped
 * as something unrecognizable hides, which is why they get named.
 */
export const classifySubjects = (subjects: string[]): { breaking: boolean; feature: boolean; unconventional: string[] } => {
  const r = { breaking: false, feature: false, unconventional: [] as string[] };
  for (const s of subjects) {
    if (BREAKING.test(s)) r.breaking = true;
    if (FEATURE.test(s)) r.feature = true;
    if (!KNOWN_TYPE.test(s)) r.unconventional.push(s);
  }
  return r;
};

/** Human sentence for the dry-run plan: which bump rule fired, and why. */
const bumpReason = (subjects: string[]): string => {
  const { breaking, feature } = classifySubjects(subjects);
  if (breaking) return "a breaking `!:` subject since the last tag";
  if (feature) return "feat subject(s) since the last tag";
  return "only patch-level subjects since the last tag";
};

/**
 * The derivation's evidence on one line: how many subjects were
 * considered, and which fall outside the conventional grammar (those are
 * patch by design). Truncated to stay readable: ~60 chars per subject,
 * at most five named, then "and N more".
 */
const subjectLine = (subjects: string[], lastTag: string): string => {
  const { unconventional } = classifySubjects(subjects);
  const clip = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const shown = unconventional.slice(0, 5).map((s) => `"${clip(s)}"`);
  const more = unconventional.length > shown.length ? ` and ${unconventional.length - shown.length} more` : "";
  const tail =
    unconventional.length === 0
      ? "none unconventional"
      : `unconventional (patch by design): ${shown.join(", ")}${more}`;
  return `${subjects.length} subject(s) since ${lastTag}; ${tail}`;
};

// ---- small runners -----------------------------------------------------------

/** git, stdout captured and trimmed; the caller guards on the exit code. */
const gitOut = (args: string[]): { code: number; out: string } => {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};

/** Streamed run (output goes to the terminal); returns the exit code. */
const run = (cmd: string[], cwd: string = ROOT): number =>
  Bun.spawnSync(cmd, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exitCode;

/**
 * Streamed run with a hard timeout. `bun install` in the worktree hits the
 * local package cache and finishes in seconds — if it drags past the
 * timeout the network/proxy is wrong, and a clear death beats a hung
 * release.
 */
const runTimed = async (cmd: string[], cwd: string, timeoutMs: number, label: string): Promise<boolean> => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) {
    die(`${label} exceeded ${Math.round(timeoutMs / 1000)}s — a cached run does not take that long; check the network/proxy, or rerun with --skip-tests`);
  }
  return code === 0;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the flow ----------------------------------------------------------------

const main = async (): Promise<void> => {
  const usage = "usage: bun run release [hash] [tag] [--dry-run] [--skip-tests]";
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  for (const f of flags) {
    if (f !== "--dry-run" && f !== "--skip-tests") die(`unknown flag ${f} — ${usage}`);
  }
  if (positional.length > 2) die(`too many arguments: ${positional.join(" ")} — ${usage}`);
  const DRY_RUN = flags.includes("--dry-run");
  const SKIP_TESTS = flags.includes("--skip-tests");
  const hashArg = positional[0] ?? "HEAD";
  const tagArg = positional[1] ?? null;

  const repo = process.env.MICKE_REPO ?? "gosuda/micke";
  const actionsUrl = `https://github.com/${repo}/actions`;
  const releaseUrl = (t: string) => `https://github.com/${repo}/releases/tag/${t}`;

  // [1] Resolve the hash to one immutable commit — everything after this
  // (ancestor check, worktree tests, the tag itself) pins to the full SHA.
  const resolved = gitOut(["rev-parse", "--verify", `${hashArg}^{commit}`]);
  if (resolved.code !== 0) die(`[1] "${hashArg}" does not resolve to a commit — check: git rev-parse --verify ${hashArg}^{commit}`);
  const sha = resolved.out;
  console.log(`micke: [1] ${hashArg} resolves to ${sha}`);

  // [2] Refresh origin/main. Non-fatal on purpose: an offline dev can still
  // --dry-run the tag derivation against the last fetched refs (the next
  // guard then says so when its view is stale).
  if (gitOut(["fetch", "origin", "--quiet"]).code !== 0) {
    console.error("micke: [2] git fetch origin failed (offline?) — continuing on the last fetched refs; the ancestor guard below may be stale");
  } else {
    console.log("micke: [2] fetched origin");
  }

  // [3] The hash must be on origin/main — a tag on a local-only commit
  // makes release.yml check out something it cannot see. This script never
  // pushes main; that push is the maintainer's.
  if (gitOut(["merge-base", "--is-ancestor", sha, "origin/main"]).code !== 0) {
    die(`[3] ${sha} is not on origin/main — push first: git push origin main (this script never pushes main)`);
  }
  console.log(`micke: [3] ${sha} is on origin/main`);

  // [4] The tag: explicit (validated) or derived. Derivation = nearest
  // reachable tag + conventional-commit subjects since then; no reachable
  // tag at all is the normal pre-first-release state, not an error.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version === "") die("[4] package.json has no version to seed the first tag from");
  const described = gitOut(["describe", "--tags", "--abbrev=0", sha]);
  const lastTag = described.code === 0 && described.out !== "" ? described.out : null;
  if (lastTag !== null && !validTag(lastTag)) {
    die(`[4] nearest tag "${lastTag}" is not strict vX.Y.Z — this script walks only vN.N.N tags; fix: git tag -d ${lastTag}`);
  }

  let tag: string;
  let why: string;
  let subjectNote: string | null = null; // set only on the derived-from-subjects path
  if (tagArg !== null) {
    if (!validTag(tagArg)) die(`[4] tag "${tagArg}" is not strict vX.Y.Z (no prerelease/build suffixes) — pass e.g. v0.2.0, or omit the tag to derive it`);
    tag = tagArg;
    why = "explicit — you passed it";
  } else if (lastTag === null) {
    tag = nextTag([], null, pkg.version);
    why = `no tags reachable from ${sha} — first release seeds package.json's version (${pkg.version})`;
  } else {
    const subjects = gitOut(["log", "--format=%s", `${lastTag}..${sha}`]).out.split("\n").filter((s) => s !== "");
    tag = nextTag(subjects, lastTag, pkg.version);
    why = `${lastTag} → ${tag} — ${bumpReason(subjects)}`;
    subjectNote = subjectLine(subjects, lastTag);
  }
  console.log(`micke: [4] tag ${tag} (${why})`);
  // The derivation's inputs, shown on every path from here (dry-run and
  // real run alike): a mis-typed `feat` reads as "only patch-level"
  // otherwise, with nothing pointing at the subject that hid it.
  if (subjectNote !== null) console.log(`micke: [4]   ${subjectNote}`);

  // [5] The tag must be new everywhere. A re-release over an existing tag
  // desyncs published assets from SHA256SUMS, so the remedy is the explicit
  // delete-both-sides incantation, never a force.
  if (gitOut(["tag", "-l", tag]).out !== "") {
    die(`[5] tag ${tag} already exists locally — if a re-release is intended: git tag -d ${tag} && git push origin :refs/tags/${tag}, then rerun`);
  }
  const remoteTag = Bun.spawnSync(["git", "ls-remote", "--tags", "origin", tag], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (remoteTag.exitCode !== 0) {
    console.error(`micke: [5] git ls-remote failed (offline?) — remote tag check skipped; the tag push in step 7 still fails on a collision`);
  } else if (remoteTag.stdout.toString().trim() !== "") {
    die(`[5] tag ${tag} already exists on the remote — if a re-release is intended: git tag -d ${tag} && git push origin :refs/tags/${tag}, then rerun`);
  }
  console.log(`micke: [5] tag ${tag} is free (local and remote)`);

  // --dry-run: the plan, not the deed. Guards 1–5 have run for real (they
  // are read-only); everything from here on mutates, so it only prints.
  if (DRY_RUN) {
    console.log("micke: dry run — the plan only; no tests, no tag, no push, no CI");
    if (SKIP_TESTS) {
      console.log("  tests: SKIPPED (--skip-tests) — the gate below would not run");
    } else {
      console.log("  tests (detached worktree at the exact sha):");
      console.log(`    git worktree add --detach <tmpdir> ${sha}`);
      console.log("    bun install --frozen-lockfile   # via the absolute bun running this script");
      console.log("    bun test tests/");
      console.log("    git worktree remove --force <tmpdir> && git worktree prune");
    }
    console.log("  then:");
    console.log(`    git tag -a ${tag} -m "micke ${tag}" ${sha}`);
    console.log(`    git push origin refs/tags/${tag}`);
    console.log(`    gh run list --workflow=release.yml --limit 5 --json databaseId,headSha,status  # find headSha ${sha}`);
    console.log("    gh run watch <id> --exit-status");
    console.log(`    gh release view ${tag} --json url -q .url  # ${releaseUrl(tag)}`);
    process.exit(0);
  }

  // [6] Test gate at the EXACT hash, in a detached worktree. bun is invoked
  // through absolute process.execPath — same pattern as scripts/build.ts —
  // because bun is not on PATH in every environment.
  if (SKIP_TESTS) {
    console.error(`micke: [6] test gate skipped (--skip-tests) — be sure the fast tier is already green at ${sha}`);
  } else {
    const wt = mkdtempSync(join(tmpdir(), "micke-release-"));
    try {
      console.log(`micke: [6] testing ${sha} in a detached worktree`);
      if (run(["git", "worktree", "add", "--detach", wt, sha]) !== 0) {
        die(`[6] git worktree add failed for ${sha} — run: git worktree prune, then rerun`);
      }
      if (!(await runTimed([process.execPath, "install", "--frozen-lockfile"], wt, 60_000, "[6] bun install --frozen-lockfile"))) {
        die(`[6] bun install failed in the release worktree (${wt}) — see the output above; fix dependencies and rerun`);
      }
      if (!(await runTimed([process.execPath, "test", "tests/"], wt, 120_000, "[6] bun test tests/"))) {
        die(`[6] fast tier failed at ${sha} — what you saw green is what releases; fix it, push, rerun`);
      }
      console.log(`micke: [6] fast tier green at ${sha}`);
    } finally {
      run(["git", "worktree", "remove", "--force", wt], ROOT);
      run(["git", "worktree", "prune"], ROOT);
    }
  }

  // [7] The annotated tag and the one remote write this script ever makes.
  if (run(["git", "tag", "-a", tag, "-m", `micke ${tag}`, sha]) !== 0) {
    die(`[7] git tag -a ${tag} failed — check: git tag -l ${tag}`);
  }
  console.log(`micke: [7] annotated ${tag} on ${sha}`);
  if (run(["git", "push", "origin", `refs/tags/${tag}`]) !== 0) {
    die(`[7] tag push failed — the tag exists locally; retry: git push origin refs/tags/${tag}`);
  }
  console.log(`micke: [7] pushed refs/tags/${tag} — release CI is starting`);

  // [8] Track the release.yml run this push triggered. gh unusable → the
  // run is still in flight, so say where to look and exit 0; a FAILED run
  // exits 1 with the rollback (delete the tag both sides, fix, rerun).
  if (Bun.which("gh") === null) {
    console.error(`micke: [8] gh not found on PATH — watch the run yourself: ${actionsUrl}`);
    process.exit(0);
  }
  let runId: number | null = null;
  let ghFailed = false;
  for (let i = 0; i < 10 && runId === null; i++) {
    if (i > 0) await sleep(2_000); // the run registers a few seconds after the push
    const r = Bun.spawnSync(
      ["gh", "run", "list", "--workflow=release.yml", "--limit", "5", "--json", "databaseId,headSha,status"],
      { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) {
      ghFailed = true; // not authed, or the repo is undetectable
      break;
    }
    const runs = JSON.parse(r.stdout.toString()) as { databaseId: number; headSha: string }[];
    runId = runs.find((x) => x.headSha === sha)?.databaseId ?? null;
  }
  if (runId === null) {
    console.error(`micke: [8] ${ghFailed ? "gh failed (auth/repo?)" : `no release.yml run for ${sha} appeared after ~20s`} — the release is in flight; watch it: ${actionsUrl}`);
    process.exit(0);
  }
  console.log(`micke: [8] watching release run ${runId} (${actionsUrl}/runs/${runId})`);
  if (run(["gh", "run", "watch", String(runId), "--exit-status"]) !== 0) {
    die(`[8] release run ${runId} failed — rollback the tag: git tag -d ${tag} && git push origin :refs/tags/${tag}, fix the failure, rerun`);
  }

  // [9] Done. Prefer gh's canonical URL; fall back to the predictable one.
  const v = Bun.spawnSync(["gh", "release", "view", tag, "--json", "url", "-q", ".url"], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  console.log(`micke: [9] released — ${v.exitCode === 0 ? v.stdout.toString().trim() : releaseUrl(tag)}`);
};

if (import.meta.main) await main();
