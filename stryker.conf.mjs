// stryker.conf.mjs — Stryker mutation testing config scaffold.
//
// Installed by adder-pipeline-tools/install.sh when the target project
// doesn't already have a Stryker config. Edit to taste; the defaults aim for
// a strict-enough starting point that Stryker actually catches weak tests.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  mutate: ['src/**/*.ts', 'src/**/*.tsx', '!src/**/*.test.ts', '!src/**/*.spec.ts'],
  thresholds: { high: 80, low: 70, break: 70 },
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
};
