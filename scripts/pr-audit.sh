#!/usr/bin/env bash
# PR merge-readiness audit — checks all review sources, Sonar, and local verification.
# Usage: bash scripts/pr-audit.sh [PR_NUMBER]
# Exit 0 = ready to merge, Exit 1 = open items remain
set -euo pipefail

REPO="adder-factory/mcp-obsidian-extended"
PR="${1:-1}"

# Counters
open_comments=0
greptile_fixes=0
sonar_issues=0
changes_requested=0
verify_failures=0

# Dynamic 24h window
SINCE=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "24 hours ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-03-14T00:00:00Z")

echo "============================================================"
echo "PR #$PR MERGE-READINESS AUDIT"
echo "============================================================"

# --- 1. Unresolved review threads ---
echo ""
echo "=== 1. UNRESOLVED REVIEW THREADS ==="
changes_requested=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo "0")
if [ "$changes_requested" -gt 0 ]; then
  echo "CHANGES_REQUESTED reviews: $changes_requested"
  gh api "repos/$REPO/pulls/$PR/reviews" --jq '.[] | select(.state == "CHANGES_REQUESTED") | "\(.user.login): \(.body[0:200])"' 2>/dev/null || true
else
  echo "No CHANGES_REQUESTED reviews"
fi

# --- 2. CodeRabbitAI latest review ---
echo ""
echo "=== 2. CODERABBITAI LATEST REVIEW ==="
LATEST_CR=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.user.login == "coderabbitai[bot]")] | last | .body // ""' 2>/dev/null || echo "")

# Actionable count
cr_actionable=$(echo "$LATEST_CR" | sed -n 's/.*Actionable comments posted: \([0-9]*\).*/\1/p' | head -1)
cr_actionable="${cr_actionable:-0}"
echo "Actionable comments: $cr_actionable"
open_comments=$((open_comments + cr_actionable))

# Duplicate comments (still-unresolved from prior rounds)
cr_duplicates=$(echo "$LATEST_CR" | sed -n 's/.*Duplicate comments (\([0-9]*\)).*/\1/p' | head -1)
cr_duplicates="${cr_duplicates:-0}"
echo "Duplicate (unresolved) comments: $cr_duplicates"
open_comments=$((open_comments + cr_duplicates))

# Nitpick count
cr_nitpicks=$(echo "$LATEST_CR" | sed -n 's/.*Nitpick comments (\([0-9]*\)).*/\1/p' | head -1)
cr_nitpicks="${cr_nitpicks:-0}"
echo "Nitpick comments: $cr_nitpicks (informational, not counted)"

# --- 3. New inline comments (last 24h) ---
echo ""
echo "=== 3. NEW INLINE COMMENTS (since $SINCE) ==="
new_comments=$(gh api "repos/$REPO/pulls/$PR/comments" --jq "[.[] | select(.created_at > \"$SINCE\")] | length" 2>/dev/null || echo "0")
echo "New comments in last 24h: $new_comments"
if [ "$new_comments" -gt 0 ]; then
  gh api "repos/$REPO/pulls/$PR/comments" --jq ".[] | select(.created_at > \"$SINCE\") | \"\(.user.login) | \(.path):\(.line // .original_line) | \(.body[0:150])\"" 2>/dev/null | head -30 || true
fi

# --- 4. Greptile summary ---
echo ""
echo "=== 4. GREPTILE SUMMARY ==="
GREPTILE=$(gh api "repos/$REPO/issues/$PR/comments" --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .body // ""' 2>/dev/null || echo "")
greptile_fixes=$(echo "$GREPTILE" | python3 -c "
import sys,re
t=sys.stdin.read()
m=re.search(r'Fix%20the%20following%20(\d+)',t)
print(m.group(1) if m else '0')
" 2>/dev/null || echo "0")
echo "Greptile Fix-All count: $greptile_fixes"
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
            print(l[:200])
" 2>/dev/null || true
fi
echo "$GREPTILE" | grep -o 'Last reviewed commit: [a-f0-9]*' || true
echo "$GREPTILE" | sed -n 's/.*Confidence Score: \([0-5]\/5\).*/Confidence: \1/p' || true

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
  # Issues
  sonar_issues=$(curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/issues/search?componentKeys=mcp-obsidian-extended&statuses=OPEN&ps=1" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "0")
  echo "Open Sonar issues: $sonar_issues"
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
echo "=== 7. LOCAL VERIFICATION ==="

# Build
echo -n "  build:     "
if npm run build --silent 2>/dev/null; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

# Lint
echo -n "  lint:      "
if npm run lint --silent 2>/dev/null; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

# Tests
echo -n "  tests:     "
if npm run test --silent 2>&1 >/dev/null; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

# Audit
echo -n "  audit:     "
if npm audit --omit=dev 2>/dev/null | grep -q "found 0 vulnerabilities"; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

# Circular deps
echo -n "  circular:  "
madge_out=$(npx madge --circular --extensions ts src/ 2>&1 || true)
if echo "$madge_out" | grep -q "No circular"; then echo "PASS"; else echo "FAIL"; verify_failures=$((verify_failures + 1)); fi

# --- Summary ---
echo ""
echo "============================================================"
echo "SUMMARY"
echo "============================================================"
echo "  CodeRabbitAI actionable + duplicates:  $open_comments"
echo "  Greptile Fix-All items:                $greptile_fixes"
echo "  Sonar open issues:                     $sonar_issues"
echo "  CHANGES_REQUESTED reviews:             $changes_requested"
echo "  Local verification failures:           $verify_failures"

TOTAL_ISSUES=$((open_comments + greptile_fixes + sonar_issues + changes_requested + verify_failures))

echo ""
if [ "$TOTAL_ISSUES" -gt 0 ]; then
  echo "RESULT: $TOTAL_ISSUES open items — NOT ready to merge"
  exit 1
else
  echo "RESULT: All clear — ready to merge"
  exit 0
fi
