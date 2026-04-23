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

gate_prettier() {
  banner "STEP 5 / Prettier"
  require_cmd npx "install Node.js" || return 1
  npx --no-install prettier --check .
}

gate_eslint() {
  banner "STEP 6 / ESLint"
  npx --no-install eslint . --max-warnings=0
}

gate_tsc() {
  banner "STEP 7 / TypeScript (tsc --noEmit)"
  npx --no-install tsc --noEmit
}

gate_knip() {
  banner "STEP 8 / knip (dead code, unused exports)"
  npx --no-install knip
}

gate_tests() {
  banner "STEP 9 / Tests + coverage threshold"
  # Coverage threshold is enforced by the test runner config
  # (Vitest/Jest's coverageThreshold). The gate doesn't hardcode it.
  npm test --silent -- --coverage
}

gate_stryker() {
  banner "STEP 10 / Stryker (mutation testing)"
  # --incremental: only mutate files changed since the last run. CI runs full
  # on origin/main merge.
  npx --no-install stryker run --incremental
}

gate_sonar() {
  banner "STEP 11 / SonarQube"
  if [ ! -f sonar-project.properties ]; then
    fail "SONAR_* set but sonar-project.properties missing"
    return 1
  fi
  # `npx --no-install` errors out clearly if the package isn't a devDep,
  # but pre-empting it lets the user see *which* package to add.
  if ! npm ls sonarqube-scanner >/dev/null 2>&1 \
     && ! npm ls @sonar/scan >/dev/null 2>&1; then
    fail "sonarqube-scanner (or @sonar/scan) not found in project devDeps"
    printf '    Install: npm install -D sonarqube-scanner\n'
    return 1
  fi
  npx --no-install sonarqube-scanner
}

gate_gitleaks() {
  banner "STEP 12 / Gitleaks (secrets)"
  require_cmd gitleaks "brew install gitleaks" || return 1
  gitleaks detect --source . --verbose --redact --no-banner
}

gate_madge() {
  banner "STEP 13 / Madge (circular deps)"
  local src_dir="src"
  [ -d src ] || src_dir="."
  npx --no-install madge --circular --extensions ts,tsx,js,jsx "$src_dir"
}

gate_semgrep() {
  banner "STEP 14 / Semgrep"
  require_cmd semgrep "brew install semgrep" || return 1
  semgrep --config p/default --config p/typescript --config p/javascript \
          --error --metrics=off --quiet .
}

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
