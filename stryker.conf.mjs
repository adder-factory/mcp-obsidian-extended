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
  mutate: [
    "src/**/*.ts",
    "src/**/*.tsx",
    "!src/**/*.test.ts",
    "!src/**/*.test.tsx",
    "!src/**/*.spec.ts",
    "!src/**/*.spec.tsx",
  ],
  // Baseline score on v1.1.1 was 56.78 %. Starting the `break` threshold at
  // 55 so the gate passes on current tests while still failing on regressions,
  // then ratcheting up (60 → 65 → 70) as tests improve. See
  // ~/projects/code-review-pipeline/baseline-findings.md for the bake-in run.
  // TODO: raise `break` to 70 once a sustained run keeps the score above it.
  thresholds: { high: 80, low: 70, break: 55 },
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
};
