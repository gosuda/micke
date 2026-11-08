# AGENTS.md

## Testing: two tiers

| Tier | Command | What runs | Target |
| :-- | :-- | :-- | :-- |
| **Fast** (default) | `bun test tests/` | No sandbox, no rungv, no image. The guest and gvx are replaced by `tests/fake/` (a real TCP guest + a real fake-rungv process). | **under 10 seconds** |
| **E2E** | `MICKE_E2E=1 bun test tests/` (or `bun run test:e2e`) | The real image, only for checks that genuinely need Xvfb/AT-SPI/chromium or a real gvx mount. | minutes |

**E2E is not part of the edit loop.** Run it once before pushing, or not at all
for docs/test-only changes.

The instance-lock check also lives in the gated tier: it needs no image, but
its 1.5 s retry would dominate the fast budget.

## Why the split exists

The default `bun test` used to boot real 2 GB gvx sandboxes: minutes per run.
`tests/mmin-phase1.test.ts` was one test wrapping ~15 steps, so a failure named
nothing and agents re-ran the whole suite to find it — that thrash happened
three times in one day. Meanwhile the suites were green while three real defects
shipped (workspace not writable on macOS, `agent-desktop press` SIGSEGV, and a
`PATH` wedge), because the tests asserted only what the author already believed.

The fix is demotion + distribution, not deletion: fast named tests cover the
wire protocol and supervisor lifecycle; E2E covers only the real-image residue.

## Rules

- If an assertion fails twice, **stop and report** instead of re-running the
  suite. Re-running does not add information.
- A failure must name its step. **Never add a multi-step mega-test**; split it
  into small named tests with one property each.
- Do not weaken an assertion to make a test pass. If the assertion is genuinely
  wrong, fix it and say why in the commit body.
- One sandbox session at a time. Close everything you create and leave no
  daemons or `rungv` processes behind.
- New fast coverage goes through `tests/fake/harness.ts`. Keep `ensureImage()`
  and session creation inside hooks/tests, never at module top level, so the
  fast tier can skip E2E files without booting anything.
- E2E tests live in `tests/e2e/`, are gated with `describe.skipIf(!E2E)`, and
  carry an explicit per-test timeout. `tests/stateless-shell.test.ts` stays at
  its original path (also gated) so one-file path selection keeps working.

## Commit convention

Subjects are `type(scope)!: subject` — scope and `!` optional, the subject a
lowercase imperative clause with no trailing period, exactly as the history
already reads: `feat(rungv): self-provision the pinned gvx release when none
is installed`, `fix(rfb): read SecurityResult after None in RFB 3.8 —
un-break password-less shots`, `docs: align with the stock surface`.

Not a style preference — the subject is load-bearing data: `bun run release`
derives the next version from the subjects since the nearest tag and reads
subjects ONLY (`git log --format=%s`; the policy is `nextTag` in
`scripts/release.ts`, the flow is README's Releasing section). So:

- `feat`, `fix`, `perf`, `refactor` are the bump types: with `!` → major;
  `feat` plain → minor; the other three plain → patch.
- Every other type — `docs`, `test`, `chore`, `build`, `ci`, or none at all —
  bumps patch. A `feat` mistyped as `chore` silently ships as a patch.
- A breaking change must carry `!` in the subject (`feat!:`, `fix(scope)!:`)
  — a "BREAKING CHANGE:" footer in the body is invisible to the script.

When unsure between types, pick the higher-visibility one (`fix` over
`chore`, `feat` over `fix`): an over-bumped version is recoverable, a
feature shipped as a patch is not.
