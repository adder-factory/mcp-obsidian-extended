#!/usr/bin/env bash
# PR merge-readiness audit — checks all review sources, Sonar, and local verification.
#
# Usage: bash scripts/pr-audit.sh [PR_NUMBER] [FLAGS]
#
# Flags:
#   --quick        Skip local verification (build/lint/test/audit/circular)
#   --fix-stale    Re-run Sonar scan when stale instead of just warning
#   --resolve      Auto-resolve outdated review threads via GraphQL
#   --json         Output structured JSON summary (implies --quick)
#
# Exit 0 = ready to merge, Exit 1 = open items remain
set -euo pipefail

REPO="adder-factory/mcp-obsidian-extended"
OWNER="adder-factory"
NAME="mcp-obsidian-extended"
PR=1
QUICK=false
FIX_STALE=false
AUTO_RESOLVE=false
JSON_OUTPUT=false

for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=true ;;
    --fix-stale) FIX_STALE=true ;;
    --resolve) AUTO_RESOLVE=true ;;
    --json) JSON_OUTPUT=true; QUICK=true ;;
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
resolved_count=0

# Current HEAD
HEAD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
HEAD_FULL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Dynamic 24h window
SINCE=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "24 hours ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-03-14T00:00:00Z")

# --- Logging helpers (suppressed in JSON mode) ---
log() { if [ "$JSON_OUTPUT" = false ]; then echo "$@"; fi; }
logn() { if [ "$JSON_OUTPUT" = false ]; then echo -n "$@"; fi; }

log "============================================================"
log "PR #$PR MERGE-READINESS AUDIT  (HEAD: $HEAD_SHA)"
log "============================================================"

# ================================================================
# 1. Unresolved review threads (GraphQL — ground truth)
#    Paginated: fetches all threads even if >100
# ================================================================
log ""
log "=== 1. UNRESOLVED REVIEW THREADS ==="

# Paginated GraphQL fetch via a Python helper that handles cursor-based pagination
THREADS_FILE=$(mktemp)
trap "rm -f $THREADS_FILE" EXIT

python3 -c "
import subprocess, json, sys

owner, name, pr = '$OWNER', '$NAME', $PR
all_threads = []
cursor = None

while True:
    after = f', after: \"{cursor}\"' if cursor else ''
    query = '''
    { repository(owner:\"%s\", name:\"%s\") {
        pullRequest(number:%d) {
          reviewThreads(first:100%s) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              comments(first:1) {
                nodes {
                  author { login }
                  body
                  path
                  line
                  originalCommit { oid }
                }
              }
            }
          }
        }
      }
    }''' % (owner, name, pr, after)

    result = subprocess.run(
        ['gh', 'api', 'graphql', '-f', f'query={query}'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        break

    data = json.loads(result.stdout)
    repo = data.get('data', {}).get('repository')
    if not repo:
        break

    rt = repo['pullRequest']['reviewThreads']
    all_threads.extend(rt['nodes'])

    if not rt['pageInfo']['hasNextPage']:
        break
    cursor = rt['pageInfo']['endCursor']

json.dump(all_threads, open('$THREADS_FILE', 'w'))
" 2>/dev/null

ALL_THREADS=$(cat "$THREADS_FILE" 2>/dev/null || echo "[]")

# Parse thread counts and details
thread_analysis=$(echo "$ALL_THREADS" | python3 -c "
import json, sys
threads = json.load(sys.stdin)
total = len(threads)
resolved = sum(1 for t in threads if t['isResolved'])
unresolved = sum(1 for t in threads if not t['isResolved'])
unresolved_current = sum(1 for t in threads if not t['isResolved'] and not t['isOutdated'])
unresolved_outdated = sum(1 for t in threads if not t['isResolved'] and t['isOutdated'])
print(f'total={total} resolved={resolved} unresolved={unresolved} unresolved_current={unresolved_current} unresolved_outdated={unresolved_outdated}')
" 2>/dev/null || echo "total=0 resolved=0 unresolved=0 unresolved_current=0 unresolved_outdated=0")

eval "$thread_analysis"
unresolved_threads=$unresolved

log "Total threads: $total | Resolved: $resolved | Unresolved: $unresolved (current: $unresolved_current, outdated: $unresolved_outdated)"

# Show unresolved thread details with commit info
if [ "$unresolved" -gt 0 ] && [ "$JSON_OUTPUT" = false ]; then
  log ""
  echo "$ALL_THREADS" | python3 -c "
import json, sys
threads = json.load(sys.stdin)
for t in threads:
    if not t['isResolved']:
        c = t['comments']['nodes'][0] if t['comments']['nodes'] else {}
        author = c.get('author', {}).get('login', 'unknown')
        path = c.get('path', '?')
        line = c.get('line', '?')
        body = c.get('body', '')[:150].replace('\n', ' ')
        commit = c.get('originalCommit', {})
        commit_sha = (commit.get('oid', '?')[:7]) if commit else '?'
        outdated = '(outdated) ' if t['isOutdated'] else ''
        print(f'  {outdated}[{author}] {path}:{line}  (commit: {commit_sha})')
        print(f'    {body}')
        print()
" 2>/dev/null || true
fi

# --- Auto-resolve outdated threads ---
if [ "$AUTO_RESOLVE" = true ] && [ "$unresolved_outdated" -gt 0 ]; then
  log "  Resolving $unresolved_outdated outdated thread(s)..."
  resolved_ids=$(echo "$ALL_THREADS" | python3 -c "
import json, sys
threads = json.load(sys.stdin)
for t in threads:
    if not t['isResolved'] and t['isOutdated']:
        print(t['id'])
" 2>/dev/null || true)

  while IFS= read -r thread_id; do
    if [ -n "$thread_id" ]; then
      gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"$thread_id\"}) { thread { isResolved } } }" >/dev/null 2>&1 && resolved_count=$((resolved_count + 1)) || true
    fi
  done <<< "$resolved_ids"

  log "  Resolved $resolved_count outdated thread(s)"
  unresolved_threads=$((unresolved_threads - resolved_count))
  if [ "$unresolved_threads" -lt 0 ]; then unresolved_threads=0; fi
fi

# ================================================================
# 2. CHANGES_REQUESTED reviews
# ================================================================
log ""
log "=== 2. CHANGES_REQUESTED REVIEWS ==="
cr_raw=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo "")
changes_requested=0
if echo "$cr_raw" | grep -qE '^[0-9]+$'; then
  changes_requested=$cr_raw
fi
if [ "$changes_requested" -gt 0 ]; then
  log "CHANGES_REQUESTED: $changes_requested"
  if [ "$JSON_OUTPUT" = false ]; then
    gh api "repos/$REPO/pulls/$PR/reviews" --jq '.[] | select(.state == "CHANGES_REQUESTED") | "  \(.user.login): \(.body[0:200])"' 2>/dev/null || true
  fi
else
  log "None"
fi

# ================================================================
# 3. CodeRabbitAI latest review summary
# ================================================================
log ""
log "=== 3. CODERABBITAI LATEST REVIEW ==="
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
  log "STALE — reviewed ${cr_reviewed_sha:0:7}, HEAD is ${HEAD_SHA}"
  stale_warnings=$((stale_warnings + 1))
fi
log "  Actionable: $cr_actionable | Duplicates: $cr_duplicates | Nitpicks: $cr_nitpicks"

# ================================================================
# 4. Greptile summary
#    Tracks both Fix-All count AND inline thread overlap
# ================================================================
log ""
log "=== 4. GREPTILE SUMMARY ==="
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

# Count Greptile inline threads (subset of unresolved_threads)
greptile_inline_threads=$(echo "$ALL_THREADS" | python3 -c "
import json, sys
threads = json.load(sys.stdin)
count = sum(1 for t in threads if not t['isResolved']
            and t['comments']['nodes']
            and t['comments']['nodes'][0].get('author',{}).get('login','') == 'greptile-apps')
print(count)
" 2>/dev/null || echo "0")

if [ "$greptile_is_stale" = true ]; then
  log "STALE — reviewed ${greptile_reviewed_sha}, HEAD is ${HEAD_SHA}"
  log "  Fix-All count: $greptile_fixes (not counted — stale)"
  log "  Inline threads (in thread count above): $greptile_inline_threads"
  stale_warnings=$((stale_warnings + 1))
  greptile_fixes=0
else
  log "Fix-All count: $greptile_fixes"
  log "  Inline threads (in thread count above): $greptile_inline_threads"
  # Deduplicate: if Fix-All items have corresponding unresolved inline threads,
  # don't double-count. The thread count is ground truth; only add Fix-All items
  # that exceed the inline thread count (summary-only issues).
  greptile_summary_only=$((greptile_fixes - greptile_inline_threads))
  if [ "$greptile_summary_only" -lt 0 ]; then greptile_summary_only=0; fi
  greptile_fixes=$greptile_summary_only
  if [ "$greptile_summary_only" -gt 0 ]; then
    log "  Summary-only items (not in threads): $greptile_summary_only"
  fi
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
log "$(echo "$GREPTILE" | grep -o 'Last reviewed commit: [a-f0-9]*' | sed 's/^/  /' || true)"
log "$(echo "$GREPTILE" | sed -n 's/.*Confidence Score: \([0-5]\/5\).*/  Confidence: \1/p' || true)"

# ================================================================
# 5. Sonar status
# ================================================================
log ""
log "=== 5. SONAR STATUS ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../.env" 2>/dev/null || true
SONAR_LOGIN="${SONAR_LOGIN:-}"
SONAR_PASSWORD="${SONAR_PASSWORD:-}"
sonar_stale=false
sonar_coverage=""
if [ -z "$SONAR_LOGIN" ] || [ -z "$SONAR_PASSWORD" ]; then
  log "Sonar credentials not set — skipping"
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
    sonar_stale=true
    if [ "$FIX_STALE" = true ]; then
      log "STALE — triggering fresh scan..."
      npm run sonar --silent 2>/dev/null || log "  Sonar scan failed"
      # Re-check version after scan
      sonar_version=$(curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/project_analyses/search?project=mcp-obsidian-extended&ps=1" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
a=d.get('analyses',[])
if a: print(a[0].get('revision','unknown')[:7])
else: print('unknown')
" 2>/dev/null || echo "unknown")
      if echo "$HEAD_SHA" | grep -q "^${sonar_version}"; then
        sonar_stale=false
        log "  Scan complete — now current"
      else
        log "  Scan still stale after re-run"
      fi
    else
      log "STALE — last scan on ${sonar_version}, HEAD is ${HEAD_SHA} (use --fix-stale to re-scan)"
    fi
    if [ "$sonar_stale" = true ]; then
      stale_warnings=$((stale_warnings + 1))
    fi
  fi

  # Issues
  sonar_issues=$(curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/issues/search?componentKeys=mcp-obsidian-extended&statuses=OPEN&ps=1" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "0")
  log "Open issues: $sonar_issues"
  if [ "$sonar_issues" -gt 0 ] && [ "$JSON_OUTPUT" = false ]; then
    curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/issues/search?componentKeys=mcp-obsidian-extended&statuses=OPEN&ps=10" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for i in d['issues']:
    print(f\"  {i['severity']:8s} {i['component'].split(':')[-1]}:{i.get('line','')} — {i['message']}\")
" 2>/dev/null || true
  fi

  # Metrics
  if [ "$JSON_OUTPUT" = false ]; then
    curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/measures/component?component=mcp-obsidian-extended&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d['component']['measures']:
    print(f\"  {m['metric']:25s} = {m['value']}\")
" 2>/dev/null || log "  Could not fetch metrics"
  fi

  # Coverage
  log ""
  log "=== 6. CODE COVERAGE (Sonar) ==="
  sonar_coverage=$(curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/measures/component?component=mcp-obsidian-extended&metricKeys=coverage,line_coverage,branch_coverage,lines_to_cover,uncovered_lines" 2>/dev/null || echo "")
  if [ "$JSON_OUTPUT" = false ] && [ -n "$sonar_coverage" ]; then
    echo "$sonar_coverage" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d['component']['measures']:
    print(f\"  {m['metric']:25s} = {m['value']}\")
" 2>/dev/null || log "  Could not fetch coverage"
  fi
fi

# ================================================================
# 7. Local verification
# ================================================================
log ""
if [ "$QUICK" = true ]; then
  log "=== 7. LOCAL VERIFICATION (skipped — --quick) ==="
else
  log "=== 7. LOCAL VERIFICATION ==="

  # Build
  logn "  build:     "
  if npm run build --silent 2>/dev/null; then log "PASS"; else log "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Lint
  logn "  lint:      "
  if npm run lint --silent 2>/dev/null; then log "PASS"; else log "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Tests + coverage thresholds
  logn "  coverage:  "
  if npm run test:coverage --silent 2>&1 >/dev/null; then log "PASS"; else log "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Audit
  logn "  audit:     "
  if npm audit --omit=dev 2>/dev/null | grep -q "found 0 vulnerabilities"; then log "PASS"; else log "FAIL"; verify_failures=$((verify_failures + 1)); fi

  # Circular deps
  logn "  circular:  "
  madge_out=$(npx madge --circular --extensions ts src/ 2>&1 || true)
  if echo "$madge_out" | grep -q "No circular"; then log "PASS"; else log "FAIL"; verify_failures=$((verify_failures + 1)); fi
fi

# ================================================================
# Summary
# ================================================================
ELAPSED=$(( $(date +%s) - START_TIME ))

TOTAL_ISSUES=$((unresolved_threads + greptile_fixes + sonar_issues + changes_requested + verify_failures))

if [ "$TOTAL_ISSUES" -gt 0 ]; then
  RESULT="NOT ready to merge"
  EXIT_CODE=1
elif [ "$stale_warnings" -gt 0 ]; then
  RESULT="No open items, but $stale_warnings stale review(s) — wait for bots to re-review"
  EXIT_CODE=1
else
  RESULT="All clear — ready to merge"
  EXIT_CODE=0
fi

# --- JSON output ---
if [ "$JSON_OUTPUT" = true ]; then
  # Build JSON with python for robustness
  python3 -c "
import json
data = {
    'pr': $PR,
    'head': '$HEAD_SHA',
    'head_full': '$HEAD_FULL',
    'elapsed_seconds': $ELAPSED,
    'result': '$RESULT',
    'exit_code': $EXIT_CODE,
    'counts': {
        'unresolved_threads': $unresolved_threads,
        'greptile_fixes': $greptile_fixes,
        'sonar_issues': $sonar_issues,
        'changes_requested': $changes_requested,
        'verify_failures': $verify_failures,
        'stale_warnings': $stale_warnings,
        'total_issues': $TOTAL_ISSUES,
    },
    'staleness': {
        'coderabbitai': $( [ "$cr_is_stale" = true ] && echo 'True' || echo 'False'),
        'greptile': $( [ "$greptile_is_stale" = true ] && echo 'True' || echo 'False'),
        'sonar': $( [ "$sonar_stale" = true ] && echo 'True' || echo 'False'),
    },
    'auto_resolved': $resolved_count,
}
print(json.dumps(data, indent=2))
"
  exit "$EXIT_CODE"
fi

# --- Human-readable summary ---
log ""
log "============================================================"
log "SUMMARY  (${ELAPSED}s elapsed)"
log "============================================================"
log "  Unresolved review threads:             $unresolved_threads"
log "  Greptile Fix-All items (summary-only): $greptile_fixes"
log "  Sonar open issues:                     $sonar_issues"
log "  CHANGES_REQUESTED reviews:             $changes_requested"
log "  Local verification failures:           $verify_failures"
if [ "$stale_warnings" -gt 0 ]; then
  log "  Stale review warnings:                 $stale_warnings (bots haven't re-reviewed HEAD)"
fi
if [ "$resolved_count" -gt 0 ]; then
  log "  Auto-resolved outdated threads:        $resolved_count"
fi

log ""
log "RESULT: $RESULT"
exit "$EXIT_CODE"
