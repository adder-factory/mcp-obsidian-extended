#!/usr/bin/env bash
# pre-pr.sh — Adder code review pipeline, unified pre-PR gate.
#
# Implements steps 5–16 of pipeline-spec.md. Runs every deterministic check
# plus the Qwen local AI reviewer before a PR is opened. Must exit 0 before
# `git push`. See script-specs/pre-pr-gate.md for the full spec.

set -u
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/sonar-qg.sh
. "$HERE/lib/sonar-qg.sh"

SKIP_QWEN=0
BASE_REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-qwen) SKIP_QWEN=1; shift ;;
    --since)
      if [ $# -lt 2 ] || [ -z "${2-}" ] || [ "${2#-}" != "$2" ]; then
        fail "--since requires a git ref (e.g. origin/main)"
        exit 1
      fi
      BASE_REF="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: scripts/pre-pr.sh [--skip-qwen] [--since <ref>]
  --skip-qwen      Skip the Qwen review step (step 15). Use during fast
                   iteration; the final run before opening a PR must include
                   Qwen unless PIPELINE_SKIP_QWEN is set in the environment.
  --since <ref>    Override base ref for diff-scoped gates. Default: picked
                   from \$PIPELINE_BASE_REF, then origin/HEAD, then origin/main.
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

if [ "${PIPELINE_SKIP_QWEN:-0}" = "1" ]; then
  SKIP_QWEN=1
fi

GATE_NAMES=()
GATE_DURS=()
GATE_RESULTS=()

# Each gate_* function runs one step; returns 0 on pass, non-zero on fail.
# Skipping is decided by the caller (below) based on project state / env.

# gate_prettier — step 5. Format check via `prettier --check .`.
gate_prettier() {
  banner "STEP 5 / Prettier"
  require_cmd npx "install Node.js" || return 1
  npx --no-install prettier --check .
}

# gate_eslint — step 6. Flat-config lint; any warning fails the gate.
gate_eslint() {
  banner "STEP 6 / ESLint"
  npx --no-install eslint . --max-warnings=0
}

# gate_tsc — step 7. Strict type check (no emit).
gate_tsc() {
  banner "STEP 7 / TypeScript (tsc --noEmit)"
  npx --no-install tsc --noEmit
}

# gate_knip — step 8. Dead-code / unused-exports scan.
gate_knip() {
  banner "STEP 8 / knip (dead code, unused exports)"
  npx --no-install knip
}

# gate_jsdoc_coverage — step 8b. Documentation coverage on exported
# declarations. Opt-in: only runs when scripts/jsdoc-coverage.ts is present
# in the target repo (installed by install.sh). Threshold defaults to 85 %
# and can be overridden per repo by setting JSDOC_COVERAGE_THRESHOLD. See
# script-specs/jsdoc-coverage.md for the metric definition.
gate_jsdoc_coverage() {
  banner "STEP 8b / JSDoc coverage (ts-morph)"
  local threshold="${JSDOC_COVERAGE_THRESHOLD:-85}"
  npx --no-install tsx scripts/jsdoc-coverage.ts --threshold "$threshold"
}

# gate_tests — step 9. `npm test -- --coverage`; coverage threshold is
# enforced by the runner config (Vitest/Jest), not by this gate.
gate_tests() {
  banner "STEP 9 / Tests + coverage threshold"
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
  banner "STEP 10 / Stryker (mutation testing)"
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
  banner "STEP 11 / SonarQube"
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
  banner "STEP 12 / Gitleaks (secrets)"
  require_cmd gitleaks "brew install gitleaks" || return 1
  gitleaks detect --source . --verbose --redact --no-banner
}

# gate_madge — step 13. Circular-dependency detection on src/ (or repo root).
gate_madge() {
  banner "STEP 13 / Madge (circular deps)"
  local src_dir="src"
  [ -d src ] || src_dir="."
  npx --no-install madge --circular --extensions ts,tsx,js,jsx "$src_dir"
}

# gate_semgrep — step 14. SAST via Semgrep's default + TS/JS rulesets.
gate_semgrep() {
  banner "STEP 14 / Semgrep"
  require_cmd semgrep "brew install semgrep" || return 1
  semgrep --config p/default --config p/typescript --config p/javascript \
          --error --metrics=off --quiet .
}

# gate_qwen — step 15. Delegates to qwen-review.sh for the local AI review.
gate_qwen() {
  banner "STEP 15 / Qwen local review"
  bash "$HERE/qwen-review.sh" --base "$BASE_REF"
}

info "Base ref for diff-scoped gates: $BASE_REF"
printf '\n'

time_gate "Prettier"         gate_prettier  || true
time_gate "ESLint"           gate_eslint    || true
time_gate "tsc"              gate_tsc       || true
time_gate "knip"             gate_knip      || true

# JSDoc coverage: opt-in. Runs when scripts/jsdoc-coverage.ts is present
# (installed by install.sh). Absent in legacy projects that pre-date the
# gate — they get a SKIP, not a failure, and pick the gate up on re-install.
if [ -f scripts/jsdoc-coverage.ts ]; then
  time_gate "JSDoc coverage" gate_jsdoc_coverage || true
else
  skip_gate "JSDoc coverage" "scripts/jsdoc-coverage.ts absent — re-run install.sh to adopt"
fi

time_gate "Tests + coverage" gate_tests     || true

# Stryker: opt-in per project. Skip cleanly when no config present.
if [ -f stryker.conf.mjs ] || [ -f stryker.conf.js ] || [ -f stryker.config.json ]; then
  time_gate "Stryker" gate_stryker || true
else
  skip_gate "Stryker" "no stryker.conf — opt in by adding one"
fi

# SonarQube: skip cleanly unless BOTH env vars are set. If vars set but config
# file missing, that's a real misconfiguration — run the gate and let it fail.
if [ -n "${SONAR_TOKEN:-}" ] && [ -n "${SONAR_HOST_URL:-}" ]; then
  time_gate "SonarQube" gate_sonar || true
else
  skip_gate "SonarQube" "SONAR_TOKEN / SONAR_HOST_URL not set"
fi

time_gate "Gitleaks"         gate_gitleaks  || true
time_gate "Madge"            gate_madge     || true
time_gate "Semgrep"          gate_semgrep   || true

# Qwen: skipped via flag/env, OR cleanly skipped if Ollama is unreachable
# (qwen-review.sh reports exit 2 for unreachable and we honor it here so a
# dev without Ollama running doesn't get a hard fail — CI never runs this
# step at all).
if [ "$SKIP_QWEN" = "1" ]; then
  skip_gate "Qwen review" "--skip-qwen flag / PIPELINE_SKIP_QWEN set"
else
  _qwen_start=$(date +%s)
  gate_qwen; _qwen_rc=$?
  _qwen_dur=$(( $(date +%s) - _qwen_start ))
  case "$_qwen_rc" in
    0) _qwen_res="pass" ;;
    # Exit 2 specifically = Ollama unreachable. Degrade to SKIP so a dev
    # without the daemon running doesn't see a hard fail — they'll notice
    # the SKIP on the pre-push run and start Ollama then. CI never reaches
    # this branch (CI calls pre-pr.sh with --skip-qwen).
    #
    # Every other non-zero exit (1 = findings, 3 = model not pulled,
    # 4 = invalid JSON, 5 = setup error — missing tool, bad base ref,
    # failed cwd) fails the gate — a setup problem masquerading as a
    # skip would let bad code reach the PR.
    2) _qwen_res="skip"
       warn "Ollama not reachable — Qwen review degraded to SKIP (start with: brew services start ollama)" ;;
    *) _qwen_res="fail" ;;
  esac
  GATE_NAMES+=("Qwen review")
  GATE_DURS+=("$_qwen_dur")
  GATE_RESULTS+=("$_qwen_res")
fi

print_summary

if any_failed; then
  printf '\n%sPre-PR gate failed.%s Fix the issues above and re-run.\n' "$C_RED" "$C_RESET"
  exit 1
fi

printf '\n%sPre-PR gate passed.%s Ready to push.\n' "$C_GREEN" "$C_RESET"
exit 0
