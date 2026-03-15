#!/usr/bin/env bash
# Comprehensive PR review checker — extracts EVERY issue from all sources
set -euo pipefail

REPO="adder-factory/mcp-obsidian-extended"
PR=1

# Dynamic 24h window
SINCE=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "24 hours ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-03-14T00:00:00Z")

echo "============================================================"
echo "COMPREHENSIVE PR REVIEW AUDIT"
echo "============================================================"

echo ""
echo "=== 1. NEW INLINE COMMENTS (since $SINCE) ==="
gh api "repos/$REPO/pulls/$PR/comments" --jq ".[] | select(.created_at > \"$SINCE\") | \"\(.user.login) | \(.path):\(.line // .original_line) | \(.body[0:200])\"" | head -50 || true

echo ""
echo "=== 2. CODERABBITAI LATEST REVIEW BODY ==="
LATEST_CR=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.user.login == "coderabbitai[bot]")] | last | .body')
echo "$LATEST_CR" | head -5

# Check for duplicate comments
echo ""
echo "=== 3. CODERABBITAI DUPLICATE COMMENTS ==="
echo "$LATEST_CR" | grep -A50 "Duplicate comments" | grep -B1 "Potential issue\|MAJOR\|MINOR\|BLOCKER" | head -20 || echo "None found"

# Check for nitpick comments
echo ""
echo "=== 4. CODERABBITAI NITPICK COMMENTS ==="
echo "$LATEST_CR" | grep -A50 "Nitpick comments" | grep -B1 "unused\|remove\|simplif\|consider\|prefer\|rename\|dead\|redundant" | head -20 || echo "None found"

# Check for actionable comments
echo ""
echo "=== 5. CODERABBITAI ACTIONABLE COUNT ==="
echo "$LATEST_CR" | grep "Actionable comments posted" || echo "No actionable"

# Check for all review bodies with duplicates/nitpicks
echo ""
echo "=== 6. ALL CODERABBITAI REVIEWS WITH ISSUES ==="
gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.user.login == "coderabbitai[bot]" and (.body | length) > 100)] | .[] | "\(.submitted_at): \(.body[0:100])"'

# Greptile summary Fix All items
echo ""
echo "=== 7. GREPTILE SUMMARY FIX-ALL ITEMS ==="
GREPTILE=$(gh api "repos/$REPO/issues/$PR/comments" --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .body // ""')
echo "$GREPTILE" | python3 -c "
import sys,re,urllib.parse
t=sys.stdin.read()
m=re.search(r'Fix%20the%20following%20(\d+)',t)
count = m.group(1) if m else '0'
print(f'Fix All count: {count}')
if int(count) > 0:
    decoded=urllib.parse.unquote(t[t.find('prompt=Fix'):t.find('&repo=')])
    for l in decoded.split('\n'):
        if l.startswith('### Issue') or (l.startswith('**') and l.endswith('**')):
            print(l[:200])
" 2>/dev/null || echo "Could not parse"

echo "$GREPTILE" | grep "Last reviewed" || true

# Sonar
echo ""
echo "=== 8. SONAR STATUS ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    value="${value%$'\r'}"; value="${value#\"}"; value="${value%\"}"; value="${value#\'}"; value="${value%\'}"
    case "$key" in
      SONAR_LOGIN) SONAR_LOGIN="$value" ;;
      SONAR_PASSWORD) SONAR_PASSWORD="$value" ;;
    esac
  done < <(grep -E '^(SONAR_LOGIN|SONAR_PASSWORD)=' "$ENV_FILE" 2>/dev/null || true)
else
  echo "Warning: .env not found — Sonar checks will be skipped"
fi
SONAR_LOGIN="${SONAR_LOGIN:-}"
SONAR_PASSWORD="${SONAR_PASSWORD:-}"
if [ -z "$SONAR_LOGIN" ] || [ -z "$SONAR_PASSWORD" ]; then
  echo "Sonar credentials not set — skipping"
else
  curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/measures/component?component=mcp-obsidian-extended&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d['component']['measures']:
    print(f\"  {m['metric']:25s} = {m['value']}\")
" 2>/dev/null || echo "Could not reach Sonar"

  echo ""
  echo "=== 9. OPEN SONAR ISSUES ==="
  curl -s -u "$SONAR_LOGIN:$SONAR_PASSWORD" "http://localhost:9000/api/issues/search?componentKeys=mcp-obsidian-extended&statuses=OPEN&ps=10" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'Open issues: {d[\"total\"]}')
for i in d['issues']:
    print(f\"  {i['severity']:8s} {i['component'].split(':')[-1]}:{i.get('line','')} — {i['message']}\")
" 2>/dev/null || echo "Could not reach Sonar"
fi

echo ""
echo "============================================================"
echo "AUDIT COMPLETE"
echo "============================================================"
