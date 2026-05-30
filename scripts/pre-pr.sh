#!/usr/bin/env bash
# pre-pr.sh — Adder code review pipeline, unified pre-PR gate.
#
# Implements the deterministic pre-PR gate (steps 5–14). Must exit 0 before
# `git push`. See script-specs/pre-pr-gate.md for the full spec.

set -u
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/sonar-qg.sh
. "$HERE/lib/sonar-qg.sh"

BASE_REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-qwen) warn "--skip-qwen is deprecated and ignored (the Qwen reviewer was removed)"; shift ;;
    --since)
      if [ $# -lt 2 ] || [ -z "${2-}" ] || [ "${2#-}" != "$2" ]; then
        fail "--since requires a git ref (e.g. origin/main)"
        exit 1
      fi
      BASE_REF="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: scripts/pre-pr.sh [--since <ref>]
  --since <ref>    Override base ref for diff-scoped gates. Default: picked
                   from \$PIPELINE_BASE_REF, then origin/HEAD, then origin/main.

  (--skip-qwen is accepted but ignored — the Qwen reviewer was removed.)
EOF
      exit 0 ;;
    *) fail "Unknown flag: $1"; exit 1 ;;
  esac
done

if ! is_inside_git_repo; then
  fail "Not a git repository — run from the target repo root."
  exit 1
fi
cd "$(repo_root)" || { fail "cd to repo root failed"; exit 1; }

# Auto-source ./.env if present. Gate steps (SonarQube especially) read
# credentials from the shell env; without this, a developer running
# `npm run pre-pr` has to remember to `source .env` every time. We
# export everything set in the file so gate subshells inherit it.
# Opt out with PIPELINE_SKIP_ENV=1 if a project needs a different env
# loading strategy (e.g. multi-environment .env.test / .env.prod
# layout). .env is gitignored in Adder Factory convention, so this
# doesn't leak secrets to the commit tree.
if [ -f .env ] && [ "${PIPELINE_SKIP_ENV:-0}" != "1" ]; then
  info "Loading .env into shell env (skip with PIPELINE_SKIP_ENV=1)"
  set -a
  # Check the source exit status explicitly — if .env has invalid shell
  # syntax the source can fail mid-way with a partially-loaded env, and
  # without this guard the script would continue silently with
  # hard-to-diagnose behavior in later gates.
  # shellcheck disable=SC1091
  if ! . ./.env; then
    set +a
    fail ".env sourcing failed — invalid shell syntax? Fix ./.env or re-run with PIPELINE_SKIP_ENV=1"
    exit 1
  fi
  set +a
fi

if [ -z "$BASE_REF" ]; then
  BASE_REF="${PIPELINE_BASE_REF:-$(default_base_ref)}"
fi
export PIPELINE_BASE_REF="$BASE_REF"

GATE_NAMES=()
GATE_DURS=()
GATE_RESULTS=()

# Each gate_* function runs one step; returns 0 on pass, non-zero on fail.
# Skipping is decided by the caller (below) based on project state / env.

# gate_biome — steps 5+6 merged. Formatter + linter + import organization in
# a single pass via Biome, replacing the former Prettier (step 5) and ESLint
# (step 6) gates. `biome ci` is always read-only and scans the full tree (it
# does NOT restrict to changed files even with VCS integration enabled).
# `--error-on-warnings` makes any warning fail the gate too — matching the old
# `eslint --max-warnings=0` strictness; without it, biome ci exits 0 on
# warning-level lint findings (e.g. noUnusedVariables) and the gate would
# silently pass weak code.
gate_biome() {
  banner "Biome (format + lint)"
  require_cmd npx "install Node.js" || return 1
  npx --no-install @biomejs/biome ci --error-on-warnings .
}

# gate_tsc — step 7. Strict type check (no emit).
gate_tsc() {
  banner "TypeScript (tsc --noEmit)"
  npx --no-install tsc --noEmit
}

# gate_knip — step 8. Dead-code / unused-exports scan.
gate_knip() {
  banner "knip (dead code, unused exports)"
  npx --no-install knip
}

# gate_jsdoc_coverage — step 8b. Documentation coverage on exported
# declarations. Opt-in: only runs when scripts/jsdoc-coverage.ts is present
# in the target repo (installed by install.sh). Threshold defaults to 85 %
# and can be overridden per repo by setting JSDOC_COVERAGE_THRESHOLD. See
# script-specs/jsdoc-coverage.md for the metric definition.
gate_jsdoc_coverage() {
  banner "JSDoc coverage (ts-morph)"
  local threshold="${JSDOC_COVERAGE_THRESHOLD:-85}"
  npx --no-install tsx scripts/jsdoc-coverage.ts --threshold "$threshold"
}

# gate_eslint_typed — step 6b. Type-AWARE ESLint layer (the half Biome can't do
# yet): typescript-eslint type-checked rules — no-floating-promises,
# no-misused-promises, await-thenable, no-unsafe-*, etc. Opt-in: only runs when
# eslint.config.mjs is present in the target repo (installed by install.sh).
# Scoped to src/ (or repo root) so the type-checker's projectService doesn't
# trip on stray TS files outside the tsconfig project. --max-warnings=0 so any
# finding fails the gate.
gate_eslint_typed() {
  banner "Type-aware lint (typescript-eslint)"
  local src_dir="src"
  [ -d src ] || src_dir="."
  npx --no-install eslint "$src_dir" --max-warnings=0
}

# gate_tests — step 9. `npm test -- --coverage`; coverage threshold is
# enforced by the runner config (Vitest/Jest), not by this gate.
gate_tests() {
  banner "Tests + coverage threshold"
  # Coverage threshold is enforced by the test runner config
  # (Vitest/Jest's coverageThreshold). The gate doesn't hardcode it.
  #
  # Convention: the project's `test` script must be plain (e.g.
  # "test": "vitest run" or "test": "jest"), WITHOUT a hardcoded
  # `--coverage` flag. The gate adds `--coverage` via `npm test --
  # --coverage` below, which only forwards reliably to Vitest/Jest when
  # the script doesn't already specify it. The CLAUDE.md block installed
  # in each target repo documents this for human contributors.
  #
  # If a project wraps its runner in a script that doesn't forward `--`
  # (e.g. "test": "bash scripts/my-test-runner.sh"), coverage won't be
  # enabled here; the project is responsible for its own coverage config
  # in that case.
  npm test --silent -- --coverage
}

# gate_stryker — step 10. Mutation testing; incremental so CI cache hits.
gate_stryker() {
  banner "Stryker (mutation testing)"
  # --incremental: only mutate files changed since the last run. CI runs full
  # on origin/main merge.
  npx --no-install stryker run --incremental
}

# gate_sonar — two-stage SonarQube gate (pipeline step 11).
# Stage 1: run the npm scanner (sonarqube-scanner or @sonar/scan) to upload
# analysis; stage 2: call verify_sonar_qg() to poll the server for the
# compute-engine task and read the quality-gate verdict. The scanner alone
# only reports upload success — Issue #7 added the verdict poll.
gate_sonar() {
  banner "SonarQube"
  if [ ! -f sonar-project.properties ]; then
    fail "SONAR_* set but sonar-project.properties missing"
    return 1
  fi
  # Detect which scanner package is installed and invoke the matching binary.
  # sonarqube-scanner is the long-standing package; @sonar/scan is the newer
  # npm name. We check for either in devDeps, then run whichever exists.
  local scanner_cmd=""
  if npm ls sonarqube-scanner >/dev/null 2>&1; then
    scanner_cmd="sonarqube-scanner"
  elif npm ls @sonar/scan >/dev/null 2>&1; then
    scanner_cmd="@sonar/scan"
  else
    fail "sonarqube-scanner (or @sonar/scan) not found in project devDeps"
    printf '    Install: npm install -D sonarqube-scanner\n'
    return 1
  fi
  # Stage 1: upload analysis. The scanner exits 0 on successful upload —
  # NOT on quality-gate pass.
  if ! npx --no-install "$scanner_cmd"; then
    return 1
  fi
  # Stage 2: wait for the server-side CE task and read the QG verdict.
  # Before this was wired, every PR saw "SonarQube pass" the instant the
  # scanner uploaded, even when the gate was failing server-side (Issue #7).
  verify_sonar_qg
}

# gate_gitleaks — step 12. Secret scan over the full working tree.
gate_gitleaks() {
  banner "Gitleaks (secrets)"
  require_cmd gitleaks "brew install gitleaks" || return 1
  gitleaks detect --source . --verbose --redact --no-banner
}

# gate_madge — step 13. Circular-dependency detection on src/ (or repo root).
gate_madge() {
  banner "Madge (circular deps)"
  local src_dir="src"
  [ -d src ] || src_dir="."
  npx --no-install madge --circular --extensions ts,tsx,js,jsx "$src_dir"
}

# gate_semgrep — step 14. SAST via Semgrep's default ruleset.
#
# Scoped to `p/default` only (was previously p/default + p/typescript +
# p/javascript). The 2026-04-26 audit Q1 found Semgrep produced 0
# findings across all visible PRs while CodeQL covers the dataflow
# surface and Sonar covers code-smell. Trimming the language-specific
# rulesets drops a few seconds off every CI + local run with no signal
# loss; if a real Semgrep gap surfaces post-trim, re-add p/typescript
# / p/javascript deliberately rather than carrying them as dead weight.
gate_semgrep() {
  banner "Semgrep"
  require_cmd semgrep "brew install semgrep" || return 1
  semgrep --config p/default --error --metrics=off --quiet .
}

info "Base ref for diff-scoped gates: $BASE_REF"
printf '\n'

# Gate ordering: fast static checks + security FIRST, expensive + network
# LAST. Every gate runs regardless (failures are recorded and the run still
# fails at the end via any_failed), so this is about time-to-signal — a type
# error, a leaked secret, or a SAST hit should surface in seconds, not after a
# multi-minute mutation run. A developer can Ctrl-C early once a fast gate
# fails. Coverage/completeness is unchanged; only the order differs.

# ── Fast static analysis ──────────────────────────────────────────────────
time_gate "Biome"            gate_biome     || true
time_gate "tsc"              gate_tsc       || true

# Type-aware ESLint: opt-in. Runs when ANY ESLint flat config is present — the
# installer scaffolds eslint.config.mjs, but a repo may already own a
# .js/.cjs/.ts flat config, and matching only .mjs would silently skip the gate
# for those. Legacy projects with no flat config get a SKIP, not a failure, and
# pick it up on re-install. Runs after tsc since it needs types.
if [ -f eslint.config.mjs ] || [ -f eslint.config.js ] \
   || [ -f eslint.config.cjs ] || [ -f eslint.config.ts ]; then
  time_gate "Type-aware lint" gate_eslint_typed || true
else
  skip_gate "Type-aware lint" "no eslint.config.* present — re-run install.sh to adopt"
fi

time_gate "knip"             gate_knip      || true
time_gate "Madge"            gate_madge     || true

# ── Security (cheap, fail-fast) ───────────────────────────────────────────
time_gate "Gitleaks"         gate_gitleaks  || true
time_gate "Semgrep"          gate_semgrep   || true

# ── Documentation coverage (opt-in) ───────────────────────────────────────
# Opt-in: runs when scripts/jsdoc-coverage.ts is present (installed by
# install.sh). Absent in legacy projects — they get a SKIP, not a failure,
# and pick the gate up on re-install.
if [ -f scripts/jsdoc-coverage.ts ]; then
  time_gate "JSDoc coverage" gate_jsdoc_coverage || true
else
  skip_gate "JSDoc coverage" "scripts/jsdoc-coverage.ts absent — re-run install.sh to adopt"
fi

# ── Expensive + network (run last) ────────────────────────────────────────
time_gate "Tests + coverage" gate_tests     || true

# Stryker: opt-in per project. Skip cleanly when no config present.
if [ -f stryker.conf.mjs ] || [ -f stryker.conf.js ] || [ -f stryker.config.json ]; then
  time_gate "Stryker" gate_stryker || true
else
  skip_gate "Stryker" "no stryker.conf — opt in by adding one"
fi

# SonarQube last: the only network-bound gate (uploads analysis + polls the
# server for the quality-gate verdict). Skip cleanly unless BOTH env vars are
# set. If vars set but config file missing, that's a real misconfiguration —
# run the gate and let it fail.
if [ -n "${SONAR_TOKEN:-}" ] && [ -n "${SONAR_HOST_URL:-}" ]; then
  time_gate "SonarQube" gate_sonar || true
else
  skip_gate "SonarQube" "SONAR_TOKEN / SONAR_HOST_URL not set"
fi

print_summary

if any_failed; then
  printf '\n%sPre-PR gate failed.%s Fix the issues above and re-run.\n' "$C_RED" "$C_RESET"
  exit 1
fi

printf '\n%sPre-PR gate passed.%s Ready to push.\n' "$C_GREEN" "$C_RESET"
exit 0
