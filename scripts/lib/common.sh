# common.sh — shared bash helpers for Adder pipeline scripts.
#
# Sourced by pre-pr.sh, qwen-review.sh, install.sh. NOT executed directly.
# Assumes `set -u` at source time; callers decide their own `set -e` policy
# because the gate deliberately keeps running after individual gate failures.

if [ -n "${_ADDER_COMMON_SH_LOADED:-}" ]; then return 0; fi
_ADDER_COMMON_SH_LOADED=1

# Color output — only when stdout is a tty.
if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''
  C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

readonly PASS_MARK="${C_GREEN}✓${C_RESET}"
readonly FAIL_MARK="${C_RED}✗${C_RESET}"
readonly SKIP_MARK="${C_YELLOW}SKIP${C_RESET}"

banner() {
  local title="$1"
  printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C_BOLD" "$C_RESET"
  printf '%s%s%s\n' "$C_BOLD" "$title" "$C_RESET"
  printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C_BOLD" "$C_RESET"
}

info()  { printf '%s→%s %s\n' "$C_BLUE"  "$C_RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf '%s✗%s %s\n' "$C_RED"    "$C_RESET" "$*"; }
ok()    { printf '%s✓%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }

# require_cmd <name> <install-hint>
# Exit 1 if the command isn't on PATH. Prints the install hint to help the user.
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 not found on PATH"
    printf '    Install: %s\n' "$2"
    return 1
  fi
}

# time_gate <name> <cmd...>
# Runs the command, records duration and pass/fail into the GATE_* arrays.
# Relies on Bash 4+ associative arrays — declared by the caller.
time_gate() {
  local name="$1"; shift
  local start end dur rc
  start=$(date +%s)
  "$@"
  rc=$?
  end=$(date +%s)
  dur=$((end - start))
  GATE_NAMES+=("$name")
  GATE_DURS+=("$dur")
  if [ $rc -eq 0 ]; then
    GATE_RESULTS+=("pass")
  else
    GATE_RESULTS+=("fail")
  fi
  return $rc
}

# skip_gate <name> <reason>
# Record a gate as skipped — not run, not failed.
skip_gate() {
  GATE_NAMES+=("$1")
  GATE_DURS+=("0")
  GATE_RESULTS+=("skip")
  warn "SKIP — $2"
}

# print_summary
# Renders the per-gate summary table + totals. Reads GATE_NAMES/DURS/RESULTS.
print_summary() {
  local name_w=16 i result_str total=0
  printf '\n'
  banner "Summary"
  printf '%-*s %8s %s\n' $name_w "Gate" "Time" "Result"
  printf '%-*s %8s %s\n' $name_w "────" "────" "──────"
  for i in "${!GATE_NAMES[@]}"; do
    local n="${GATE_NAMES[$i]}" d="${GATE_DURS[$i]}" r="${GATE_RESULTS[$i]}"
    case "$r" in
      pass) result_str="$PASS_MARK" ;;
      fail) result_str="$FAIL_MARK" ;;
      skip) result_str="$SKIP_MARK" ;;
      *)    result_str="?" ;;
    esac
    printf '%-*s %7ss %s\n' $name_w "$n" "$d" "$result_str"
    total=$((total + d))
  done
  printf '%-*s %7ss\n' $name_w "Total" "$total"
}

# any_failed — returns 0 if any recorded gate failed, 1 otherwise.
# Uses the `${arr[@]+"${arr[@]}"}` pattern so an unset GATE_RESULTS array
# doesn't trip `set -u` on callers that have it enabled.
any_failed() {
  local r
  for r in ${GATE_RESULTS[@]+"${GATE_RESULTS[@]}"}; do
    if [ "$r" = "fail" ]; then return 0; fi
  done
  return 1
}

# is_inside_git_repo — returns 0 if cwd is a git working tree.
is_inside_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1
}

# repo_root — prints the top-level of the current git repo.
repo_root() {
  git rev-parse --show-toplevel
}

# default_base_ref — picks the right base ref for diffs. Prefers
# origin/<default-branch>; falls back to origin/main; final fallback is HEAD~1.
default_base_ref() {
  local def
  def=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's#^refs/remotes/##')
  if [ -n "$def" ] && git rev-parse --verify --quiet "$def" >/dev/null; then
    printf '%s\n' "$def"
  elif git rev-parse --verify --quiet origin/main >/dev/null; then
    printf 'origin/main\n'
  else
    printf 'HEAD~1\n'
  fi
}
