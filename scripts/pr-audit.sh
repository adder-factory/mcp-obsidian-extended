#!/usr/bin/env bash
# PR merge-readiness audit — checks all review sources, Sonar, and local verification.
# Usage: bash scripts/pr-audit.sh [PR_NUMBER] [--quick]
#   --quick  Skip local verification (build/lint/test/audit/circular)
# Exit 0 = ready to merge, Exit 1 = open items remain
set -euo pipefail

REPO="adder-factory/mcp-obsidian-extended"
OWNER="adder-factory"
NAME="mcp-obsidian-extended"
PR=1
QUICK=false
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=true ;;
    [0-9]*) PR="$arg" ;;
  esac
done

START_TIME=$(date +%s)

# Counters
unresolved_threads=0
greptile_fixes=0
sonar_issues=0
changes_requested=0
verify_failures=0
stale_warnings=0

# Current HEAD
HEAD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Dynamic 24h window
SINCE=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "24 hours ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-03-14T00:00:00Z")

echo "============================================================"
echo "PR #$PR MERGE-READINESS AUDIT  (HEAD: $HEAD_SHA)"
echo "============================================================"

# --- 1. Unresolved review threads (GraphQL — ground truth) ---
echo ""
echo "=== 1. UNRESOLVED REVIEW THREADS ==="

# Fetch all review threads via GraphQL (supports up to 100 per query)
THREADS_JSON=$(gh api graphql -f query="
{ repository(owner:\"$OWNER\", name:\"$NAME\") {
    pullRequest(number:$PR) {
      reviewThreads(first:100) {
        totalCount
        nodes {
          isResolved
          isOutdated
          comments(first:1) {
            nodes {
              author { login }
              body
              path
              line
            }
          }
        }
      }
    }
  }
}" 2>/dev/null || echo '{"data":null}')

# Parse thread counts
thread_stats=$(echo "$THREADS_JSON" | python3 -c "
import json, sys
raw = json.load(sys.stdin)
data = raw.get('data')
if not data or not data.get('repository'):
    print('total=0 resolved=0 unresolved=0 unresolved_current=0')
    sys.exit(0)
threads = data['repository']['pullRequest']['reviewThreads']['nodes']
total = data['repository']['pullRequest']['reviewThreads']['totalCount']
resolved = sum(1 for t in threads if t['isResolved'])
unresolved = sum(1 for t in threads if not t['isResolved'])
unresolved_current = sum(1 for t in threads if not t['isResolved'] and not t['isOutdated'])
print(f'total={total} resolved={resolved} unresolved={unresolved} unresolved_current={unresolved_current}')
" 2>/dev/null || echo "total=0 resolved=0 unresolved=0 unresolved_current=0")

eval "$thread_stats"
unresolved_threads=$unresolved

echo "Total threads: $total | Resolved: $resolved | Unresolved: $unresolved (current: $unresolved_current)"

# Show unresolved thread details
if [ "$unresolved" -gt 0 ]; then
  echo ""
  echo "$THREADS_JSON" | python3 -c "
import json, sys
raw = json.load(sys.stdin)
data = raw.get('data')
if not data or not data.get('repository'): sys.exit(0)
threads = data['repository']['pullRequest']['reviewThreads']['nodes']
for t in threads:
    if not t['isResolved']:
        c = t['comments']['nodes'][0] if t['comments']['nodes'] else {}
        author = c.get('author', {}).get('login', 'unknown')
        path = c.get('path', '?')
        line = c.get('line', '?')
        body = c.get('body', '')[:150].replace('\n', ' ')
        outdated = '(outdated) ' if t['isOutdated'] else ''
        print(f'  {outdated}[{author}] {path}:{line}')
        print(f'    {body}')
        print()
" 2>/dev/null || true
fi

# --- 2. CHANGES_REQUESTED reviews ---
echo ""
echo "=== 2. CHANGES_REQUESTED REVIEWS ==="
cr_raw=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo "")
changes_requested=0
if echo "$cr_raw" | grep -qE '^[0-9]+$'; then
  changes_requested=$cr_raw
fi
if [ "$changes_requested" -gt 0 ]; then
  echo "CHANGES_REQUESTED: $changes_requested"
  gh api "repos/$REPO/pulls/$PR/reviews" --jq '.[] | select(.state == "CHANGES_REQUESTED") | "  \(.user.login): \(.body[0:200])"' 2>/dev/null || true
else
  echo "None"
fi

# --- 3. CodeRabbitAI latest review summary ---
echo ""
echo "=== 3. CODERABBITAI LATEST REVIEW ==="
LATEST_CR=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.user.login == "coderabbitai[bot]")] | last | .body // ""' 2>/dev/null || echo "")

# Check staleness
cr_reviewed_sha=$(echo "$LATEST_CR" | sed -n 's/.*between [a-f0-9]* and \([a-f0-9]*\)\..*/\1/p' | head -1)
cr_reviewed_sha="${cr_reviewed_sha:-unknown}"
cr_is_stale=false
if [ "$cr_reviewed_sha" != "unknown" ] && ! echo "$HEAD_SHA" | grep -q "^${cr_reviewed_sha:0:7}"; then
  cr_is_stale=true
fi

# Parse counts from review body
cr_actionable=$(echo "$LATEST_CR" | sed -n 's/.*Actionable comments posted: \([0-9]*\).*/\1/p' | head -1)
cr_actionable="${cr_actionable:-0}"
cr_duplicates=$(echo "$LATEST_CR" | sed -n 's/.*Duplicate comments (\([0-9]*\)).*/\1/p' | head -1)
cr_duplicates="${cr_duplicates:-0}"
cr_nitpicks=$(echo "$LATEST_CR" | sed -n 's/.*Nitpick comments (\([0-9]*\)).*/\1/p' | head -1)
cr_nitpicks="${cr_nitpicks:-0}"

if [ "$cr_is_stale" = true ]; then
  echo "STALE — reviewed ${cr_reviewed_sha:0:7}, HEAD is ${HEAD_SHA}"
  stale_warnings=$((stale_warnings + 1))
fi
echo "  Actionable: $cr_actionable | Duplicates: $cr_duplicates | Nitpicks: $cr_nitpicks"

# --- 4. Greptile summary ---
echo ""
echo "=== 4. GREPTILE SUMMARY ==="
GREPTILE=$(gh api --paginate "repos/$REPO/issues/$PR/comments" --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .body // ""' 2>/dev/null || echo "")

# Check staleness
greptile_reviewed_sha=$(echo "$GREPTILE" | sed -n 's/.*Last reviewed commit: \([a-f0-9]*\).*/\1/p' | head -1)
greptile_reviewed_sha="${greptile_reviewed_sha:-unknown}"
greptile_is_stale=false
if [ "$greptile_reviewed_sha" != "unknown" ] && ! echo "$HEAD_SHA" | grep -q "^${greptile_reviewed_sha:0:7}"; then
  greptile_is_stale=true
fi

greptile_fixes=$(echo "$GREPTILE" | python3 -c "
import sys,re
t=sys.stdin.read()
m=re.search(r'Fix%20the%20following%20(\d+)',t)
print(m.group(1) if m else '0')
" 2>/dev/null || echo "0")

if [ "$greptile_is_stale" = true ]; then
  echo "STALE — reviewed ${greptile_reviewed_sha}, HEAD is ${HEAD_SHA}"
  echo "  Fix-All count: $greptile_fixes (not counted — stale)"
  stale_warnings=$((stale_warnings + 1))
  greptile_fixes=0
else
  echo "Fix-All count: $greptile_fixes"
fi

if [ "$greptile_fixes" -gt 0 ]; then
  echo "$GREPTILE" | python3 -c "
import sys,re,urllib.parse
t=sys.stdin.read()
idx=t.find('prompt=Fix')
end=t.find('&repo=')
if idx>=0 and end>=0:
    decoded=urllib.parse.unquote(t[idx:end])
    for l in decoded.split('\n'):
        if l.startswith('### Issue') or (l.startswith('**') and l.endswith('**')):
            print(f'  {l[:200]}')
" 2>/dev/null || true
fi
echo "$GREPTILE" | grep -o 'Last reviewed commit: [a-f0-9]*' | sed 's/^/  /' || true
echo "$GREPTILE" | sed -n 's/.*Confidence Score: \([0-5]\/5\).*/  Confidence: \1/p' || true

# --- 5. Sonar status ---
echo ""
echo "=== 5. SONAR STATUS ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../.env" 2>/dev/null || true
SONAR_LOGIN="${SONAR_LOGIN:-}"
SONAR_PASSWORD="${SONAR_PASSWORD:-}"
if [ -z "$SONAR_LOGIN" ] || [ -z "$SONAR_PASSWORD" ]; then
  echo "Sonar credentials not set — skipping"
else
  # Check scan freshness
  sonar_version=$(curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/project_analyses/search?project=mcp-obsidian-extended&ps=1" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
a=d.get('analyses',[])
if a: print(a[0].get('revision','unknown')[:7])
else: print('unknown')
" 2>/dev/null || echo "unknown")
  if [ "$sonar_version" != "unknown" ] && ! echo "$HEAD_SHA" | grep -q "^${sonar_version}"; then
    echo "STALE — last scan on ${sonar_version}, HEAD is ${HEAD_SHA}"
    stale_warnings=$((stale_warnings + 1))
  fi

  # Issues
  sonar_issues=$(curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/issues/search?componentKeys=mcp-obsidian-extended&statuses=OPEN&ps=1" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "0")
  echo "Open issues: $sonar_issues"
  if [ "$sonar_issues" -gt 0 ]; then
    curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/issues/search?componentKeys=mcp-obsidian-extended&statuses=OPEN&ps=10" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for i in d['issues']:
    print(f\"  {i['severity']:8s} {i['component'].split(':')[-1]}:{i.get('line','')} — {i['message']}\")
" 2>/dev/null || true
  fi

  # Metrics
  curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/measures/component?component=mcp-obsidian-extended&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d['component']['measures']:
    print(f\"  {m['metric']:25s} = {m['value']}\")
" 2>/dev/null || echo "  Could not fetch metrics"

  # Coverage
  echo ""
  echo "=== 6. CODE COVERAGE (Sonar) ==="
  curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/measures/component?component=mcp-obsidian-extended&metricKeys=coverage,line_coverage,branch_coverage,lines_to_cover,uncovered_lines" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d['component']['measures']:
    print(f\"  {m['metric']:25s} = {m['value']}\")
" 2>/dev/null || echo "  Could not fetch coverage"
fi

# --- 7. Local verification ---
echo ""
if [ "$QUICK" = true ]; then
  echo "=== 7. LOCAL VERIFICATION (skipped — --quick) ==="
else
  echo "=== 7. LOCAL VERIFICATION ==="

  # Build
  echo -n "  build:     "
  if npm run build --silent 2>/dev/null; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Lint
  echo -n "  lint:      "
  if npm run lint --silent 2>/dev/null; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Tests + coverage thresholds
  echo -n "  coverage:  "
  if npm run test:coverage --silent 2>&1 >/dev/null; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Audit
  echo -n "  audit:     "
  if npm audit --omit=dev 2>/dev/null | grep -q "found 0 vulnerabilities"; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Circular deps
  echo -n "  circular:  "
  madge_out=$(npx madge --circular --extensions ts src/ 2>&1 || true)
  if echo "$madge_out" | grep -q "No circular"; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi
fi

# --- Summary ---
ELAPSED=$(( $(date +%s) - START_TIME ))
echo ""
echo "============================================================"
echo "SUMMARY  (${ELAPSED}s elapsed)"
echo "============================================================"
echo "  Unresolved review threads:             $unresolved_threads"
echo "  Greptile Fix-All items:                $greptile_fixes"
echo "  Sonar open issues:                     $sonar_issues"
echo "  CHANGES_REQUESTED reviews:             $changes_requested"
echo "  Local verification failures:           $verify_failures"
if [ "$stale_warnings" -gt 0 ]; then
  echo "  Stale review warnings:                 $stale_warnings (bots haven't re-reviewed HEAD)"
fi

TOTAL_ISSUES=$((unresolved_threads + greptile_fixes + sonar_issues + changes_requested + verify_failures))

echo ""
if [ "$TOTAL_ISSUES" -gt 0 ]; then
  echo "RESULT: $TOTAL_ISSUES open items — NOT ready to merge"
  exit 1
elif [ "$stale_warnings" -gt 0 ]; then
  echo "RESULT: No open items, but $stale_warnings stale review(s) — wait for bots to re-review"
  exit 1
else
  echo "RESULT: All clear — ready to merge"
  exit 0
fi
