// stryker.conf.mjs — Stryker mutation testing config scaffold.
//
// Installed by adder-pipeline-tools/install.sh when the target project
// doesn't already have a Stryker config. Edit to taste; the defaults aim for
// a strict-enough starting point that Stryker actually catches weak tests.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  reporters: ["html", "clear-text", "progress"],
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  // Glob patterns keyed to this repo's actual file types: only .ts (no
  // .tsx in src/) and .test.ts convention (no .spec.* suffix anywhere).
  // Stryker emits a zero-match warning for every unused glob otherwise.
  // See pipeline-spec.md → Stryker section → "key glob patterns to
  // actual project file types".
  //
  // Per-file carve-outs — see CLAUDE.md "Mutation Testing — Hard 80%
  // Floor (active)" → "Per-file carve-outs allowed but justified".
  // Budget: 5. Active count below; >5 ⇒ escalate for human policy review.
  // Each line below is `// Carve-out N/5: <path>` so future authors can
  // grep `Carve-out` to count what's already in flight.
  //
  // Carve-out 1/5: src/index.ts — entry-point wiring. Boots the MCP
  //   server + StdioServerTransport, reads package.json for version,
  //   runs the CLI flag dispatcher (--show-config / --setup /
  //   --validate / --version), and starts the cache-build background
  //   task. None of this can be exercised without spinning up the full
  //   stdio transport in a child process; doing so in unit tests would
  //   duplicate the smoke-test suite.
  //
  //   The file does contain two pure helpers (validatePort,
  //   validateEnum) that are technically extract-and-test candidates,
  //   but each is ~10 LOC and called only from the --setup CLI flow.
  //   Extracting them to a setup-utils module would add a file +
  //   import for ~10-15 reclaimed mutants out of 270 (~5 %). Decision:
  //   subsumed in the carve-out by choice — extract later only if the
  //   helpers grow non-trivial.
  //
  //   Removed 270 NoCoverage mutants (the file was at 0.00 %) from the
  //   aggregate denominator, lifting the score from 66.38 % → 70.30 %
  //   at carve-out time.
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/index.ts"],
  // Baseline score on v1.1.1 was 56.78 %. The `break` threshold ratchets up
  // `(new_score − 1pp)` after each test-improvement PR so it always sits
  // ~1pp below the current kill rate — tight enough to catch a regression,
  // loose enough to tolerate incremental-cache noise. History:
  //   56.78 → break 55       (PR #12 baseline)
  //   60.76 → break 59.76    (PR closing #14, switch exhaustiveness guards)
  //   64.66 → break 63.66    (PR closing #13, errorResult message content)
  //   64.66 → break 80       (PR #49, chore/stryker-floor-80, hard floor —
  //                           the gate now blocks until backfill PRs lift
  //                           the score to ≥80. This PR will fail its own
  //                           gate; that is the bootstrap moment. After
  //                           the floor is hit, ratchet resumes at
  //                           (score - 1pp) but never drops below 80.)
  //   65.45 → break 80       (post-PR #49 cold baseline)
  //   66.38 → break 80       (PR #50, +0.93 pp from skill.ts coverage —
  //                           45 of 108 surviving mutants killed; the 63
  //                           Map-line mutants survived for reasons
  //                           unclear, possibly coverageAnalysis: perTest
  //                           not attributing module-load Map init to
  //                           test cases. Investigate in a follow-up.)
  //   70.30 → break 80       (PR #N, chore/stryker-carveout-index, +3.92
  //                           pp from removing src/index.ts from mutate
  //                           glob — entry-point wiring, justified above
  //                           in the per-file carve-outs comment.)
  // See ~/projects/code-review-pipeline/baseline-findings.md for the bake-in
  // run and build-log.md for the ratchet history (including this floor entry).
  // `low` is collapsed to 80 alongside `break` and `high` — the 70-79 band
  // would never be reported because `break` fires first. Three thresholds
  // are kept (rather than a single value) for forward-compatibility with
  // the post-floor ratchet, where `break` will sit below `high`/`low` again.
  thresholds: { high: 80, low: 80, break: 80 },
  // ignoreStatic must stay `false` — static mutants catch wrong defaults
  // / bad constants / bad regex literals, which is exactly what type checks
  // and linters miss. Explicit value (not relying on Stryker's current
  // default) locks the behavior against an upstream default flip in a
  // future Stryker release.
  ignoreStatic: false,
  // Silencing `warnings.slow` keeps CI output clean without changing what
  // gets tested. Explicit for the same reason as above.
  warnings: { slow: false },
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
};
