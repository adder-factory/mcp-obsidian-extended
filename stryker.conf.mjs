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
  mutate: ["src/**/*.ts", "!src/**/*.test.ts"],
  // Baseline score on v1.1.1 was 56.78 %. The `break` threshold ratchets up
  // `(new_score − 1pp)` after each test-improvement PR so it always sits
  // ~1pp below the current kill rate — tight enough to catch a regression,
  // loose enough to tolerate incremental-cache noise. History:
  //   56.78 → break 55       (PR #12 baseline)
  //   60.76 → break 59.76    (PR closing #14, switch exhaustiveness guards)
  //   64.66 → break 63.66    (PR closing #13, errorResult message content)
  //   64.66 → break 80       (chore/stryker-floor-80, hard floor — the
  //                           gate now blocks until backfill PRs lift the
  //                           score to ≥80. This PR will fail its own gate;
  //                           that is the bootstrap moment. After the floor
  //                           is hit, ratchet resumes at (score − 1pp) but
  //                           never drops below 80.)
  thresholds: { high: 80, low: 70, break: 80 },
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
