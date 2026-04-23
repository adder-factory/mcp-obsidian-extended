#!/usr/bin/env bash
# qwen-review.sh — step 15 of pipeline-spec.md. Local AI code reviewer.
#
# Feeds the branch diff + CodeGraph impact context to a Qwen model via Ollama,
# parses structured findings, and exits non-zero on blocker/major severity.
#
# SPEC DEVIATION (2026-04-23):
#   script-specs/qwen-review.md says QWEN_MODEL defaults to
#   qwen3.6:27b-coding-mxfp8. Phase 1 install on the Mac Studio found that
#   both Qwen 3.6 quants fail on this 36 GB hardware (mxfp8 OOMs; nvfp4 hits
#   an upstream Ollama 0.21.1 / MLX 0.31.2 panic). Per build-plan.md Phase 4's
#   contingency clause ("revert the default in qwen-review.sh to Qwen 2.5"),
#   the default is qwen2.5-coder:32b for now. Flip to
#   qwen3.6:27b-coding-nvfp4 via `QWEN_MODEL=... npm run qwen-review` when
#   Ollama ships a fix — see ~/.adder-pipeline/README.md retry procedure.

set -u
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

MODEL="${QWEN_MODEL:-qwen2.5-coder:32b}"
OLLAMA_HOST_URL="${OLLAMA_HOST:-http://127.0.0.1:11434}"
BASE_REF=""
OUTPUT_JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      if [ $# -lt 2 ] || [ -z "${2-}" ] || [ "${2#-}" != "$2" ]; then
        fail "--base requires a git ref (e.g. origin/main)"
        exit 1
      fi
      BASE_REF="$2"; shift 2 ;;
    --json) OUTPUT_JSON=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: scripts/qwen-review.sh [--base <ref>] [--json]

  --base <ref>     Compare against this ref. Default: \$PIPELINE_BASE_REF, or
                   origin/HEAD, or origin/main.
  --json           Emit the raw finding JSON to stdout (for scripting).

Model selection:   QWEN_MODEL env var (default: qwen2.5-coder:32b).
                   See header comment for the Phase 1 deviation from spec.

Exit codes:        0 clean, or only nitpicks / minor
                   1 blocker or major findings present
                   2 Ollama unreachable (skippable by pre-pr.sh)
                   3 model not pulled on the Ollama host
                   4 response was not valid JSON (prompt compliance failure)
                   5 other setup / validation error (missing tool, bad ref,
                     failed cwd, etc.) — NOT skippable
EOF
      exit 0 ;;
    *) fail "Unknown flag: $1"; exit 1 ;;
  esac
done

require_cmd curl    "macOS ships curl — check PATH"  || exit 5
require_cmd python3 "python3 is required for JSON I/O" || exit 5
require_cmd git     "install git" || exit 5

if ! is_inside_git_repo; then
  fail "Not a git repository — run from the target repo root."
  exit 5
fi
cd "$(repo_root)" || { fail "cd to repo root failed"; exit 5; }

if [ -z "$BASE_REF" ]; then
  BASE_REF="${PIPELINE_BASE_REF:-$(default_base_ref)}"
fi

# Fail loud on an invalid base ref instead of silently falling through to a
# clean review (empty diff = exit 0), which would look like a passing gate.
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  fail "Base ref not found in this repo: $BASE_REF"
  printf '    Fetch origin first, or pass a different --base / PIPELINE_BASE_REF.\n'
  exit 5
fi

# Per-model request options. num_ctx is a ceiling; Ollama honors the model's
# native window if smaller. Temperature 0.1 for deterministic review output.
case "$MODEL" in
  qwen3.6:*)        NUM_CTX=256000 ;;
  qwen2.5-coder:*)  NUM_CTX=128000 ;;
  *)                NUM_CTX=32000
                    warn "Unknown QWEN_MODEL=$MODEL — using conservative num_ctx=$NUM_CTX" ;;
esac

info "Model:    $MODEL"
info "Base ref: $BASE_REF"
info "Ollama:   $OLLAMA_HOST_URL (num_ctx=$NUM_CTX)"
printf '\n'

if ! curl -sS --max-time 3 "$OLLAMA_HOST_URL/api/version" >/dev/null 2>&1; then
  fail "Ollama at $OLLAMA_HOST_URL not reachable"
  printf '    Start it with: brew services start ollama\n'
  exit 2
fi

if ! curl -sS --max-time 10 "$OLLAMA_HOST_URL/api/tags" \
     | python3 -c "import json,sys; tags=json.load(sys.stdin).get('models', []); \
                   sys.exit(0 if any(m.get('name')==sys.argv[1] for m in tags) else 1)" \
     "$MODEL" 2>/dev/null; then
  fail "Model $MODEL not found on Ollama host (or /api/tags timed out)"
  printf '    Pull it with: ollama pull %s\n' "$MODEL"
  exit 3
fi

DIFF=$(git diff --merge-base "$BASE_REF" -- . \
       ':(exclude)*.lock' ':(exclude)*.snap' ':(exclude)package-lock.json' \
       ':(exclude)yarn.lock' ':(exclude)pnpm-lock.yaml' 2>/dev/null) || {
  fail "Could not diff against $BASE_REF (unrelated histories? shallow clone?)"
  exit 5
}

if [ -z "$DIFF" ]; then
  info "No changes vs $BASE_REF — nothing to review."
  [ "$OUTPUT_JSON" = "1" ] && printf '{"overall":"clean","findings":[]}\n'
  exit 0
fi

# Keep exclusions identical to the $DIFF query so the model isn't told about
# files whose content we didn't include (especially lockfiles).
FILES=$(git diff --merge-base --name-only "$BASE_REF" -- . \
        ':(exclude)*.lock' ':(exclude)*.snap' ':(exclude)package-lock.json' \
        ':(exclude)yarn.lock' ':(exclude)pnpm-lock.yaml' 2>/dev/null) || {
  fail "Could not enumerate changed files against $BASE_REF"
  exit 5
}

# CodeGraph impact context is best-effort — never fails the gate.
CODEGRAPH_CONTEXT=""
if command -v codegraph >/dev/null 2>&1 && [ -d .codegraph ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    out=$(codegraph impact "$f" 2>/dev/null || true)
    [ -n "$out" ] && CODEGRAPH_CONTEXT+="### $f"$'\n'"$out"$'\n\n'
  done <<< "$FILES"
fi
[ -z "$CODEGRAPH_CONTEXT" ] && \
  CODEGRAPH_CONTEXT="(no CodeGraph context — .codegraph/ missing or codegraph CLI not on PATH)"

PROJECT_CTX="(no CLAUDE.md in repo)"
[ -f CLAUDE.md ] && PROJECT_CTX=$(head -c 4096 CLAUDE.md)

PROMPT=$(cat <<EOF
You are a senior code reviewer performing a pre-PR review of a TypeScript/JavaScript project.
You have access to the diff and structural context about affected symbols.

Your job: identify real issues that must be fixed before merge. You are NOT a linter —
deterministic tools (ESLint, tsc, Prettier, knip, Semgrep) already ran. Focus on:

- Logic bugs not caught by type checks
- Race conditions, error-handling gaps
- API misuse (calling functions with wrong contracts)
- Security issues not caught by Semgrep (auth/authz gaps, input validation at semantic level)
- Subtle breakage where a change affects callers you might not have considered

Do NOT flag:
- Formatting (Prettier ran)
- Unused imports (ESLint + knip ran)
- Type errors (tsc ran)
- Missing tests (Stryker + coverage ran)
- Style preferences unless they actually cause a bug

## Project Context

$PROJECT_CTX

## CodeGraph Impact Analysis

$CODEGRAPH_CONTEXT

## Diff (base: $BASE_REF)

\`\`\`diff
$DIFF
\`\`\`

## Output

Respond ONLY with valid JSON matching this schema — no preamble, no markdown fences, no reasoning:

{
  "overall": "clean" | "issues",
  "findings": [
    {
      "severity": "blocker" | "major" | "minor" | "nitpick",
      "file": "<path>",
      "line": <number or null if file-level>,
      "issue": "<one sentence>",
      "suggestion": "<one sentence actionable fix>"
    }
  ]
}

If no issues, return {"overall": "clean", "findings": []}.
EOF
)

# Build the Ollama request body. Python handles all JSON escaping safely;
# the prompt is fed via stdin so no heredoc/quoting gymnastics.
REQUEST_BODY=$(printf '%s' "$PROMPT" | python3 -c '
import json, sys
model, num_ctx = sys.argv[1], int(sys.argv[2])
prompt = sys.stdin.read()
options = {"num_ctx": num_ctx, "temperature": 0.1}
if model.startswith("qwen3.6:"):
    options["think"] = False
body = {
    "model":  model,
    "prompt": prompt,
    "stream": False,
    "format": "json",
    "options": options,
}
sys.stdout.write(json.dumps(body))
' "$MODEL" "$NUM_CTX")

info "Prompt assembled (diff $(printf '%s' "$DIFF" | wc -l | tr -d ' ') lines). Invoking Qwen…"
_start=$(date +%s)

# 10-minute ceiling: cold-start + 256K context can take a while on first call.
RESPONSE=$(curl -sS --max-time 600 -X POST "$OLLAMA_HOST_URL/api/generate" \
           -H 'Content-Type: application/json' --data-binary @<(printf '%s' "$REQUEST_BODY")) || {
  fail "Ollama request failed — is the service still running?"
  exit 2
}

_dur=$(( $(date +%s) - _start ))
info "Response received in ${_dur}s."

# Extract the model's output from the Ollama response envelope, handling
# upstream error surfaces (e.g. model pull required, runner crashed mid-way).
MODEL_OUTPUT=$(printf '%s' "$RESPONSE" | python3 -c '
import json, sys
try:
    body = json.loads(sys.stdin.read())
except json.JSONDecodeError as e:
    sys.stderr.write("Ollama response not JSON: %s\n" % e)
    sys.exit(4)
if "error" in body:
    msg = body["error"]
    sys.stderr.write("Ollama error: %s\n" % msg)
    sys.exit(3 if "not found" in msg.lower() else 2)
sys.stdout.write(body.get("response", ""))
') || exit $?

# Strip any thinking/reasoning preamble (format:json should prevent this, but
# belt and braces). Extract the first balanced top-level {...} block.
CLEAN_JSON=$(printf '%s' "$MODEL_OUTPUT" | python3 -c '
import sys
text = sys.stdin.read()
start = text.find("{")
if start == -1: sys.exit(4)
depth, end, in_str, esc = 0, -1, False, False
for i, ch in enumerate(text[start:], start):
    if esc: esc = False; continue
    if ch == "\\": esc = True; continue
    if ch == "\"": in_str = not in_str; continue
    if in_str: continue
    if ch == "{": depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0: end = i + 1; break
if end == -1: sys.exit(4)
sys.stdout.write(text[start:end])
') || {
  fail "Model response did not contain a valid JSON object."
  printf '    First 500 chars of response:\n'
  printf '%.500s\n' "$MODEL_OUTPUT"
  exit 4
}

# Classify findings, print in the requested format, pick an exit code.
if [ "$OUTPUT_JSON" = "1" ]; then
  printf '%s\n' "$CLEAN_JSON"
fi

printf '%s' "$CLEAN_JSON" | OUTPUT_JSON="$OUTPUT_JSON" python3 -c '
import json, os, sys
try:
    data = json.loads(sys.stdin.read())
except json.JSONDecodeError as e:
    sys.stderr.write("  (invalid JSON from model after extraction: %s)\n" % e)
    sys.exit(4)
findings = data.get("findings", []) or []
by_sev = {"blocker":0, "major":0, "minor":0, "nitpick":0}
for f in findings:
    s = f.get("severity", "nitpick")
    by_sev[s if s in by_sev else "nitpick"] += 1

if os.environ.get("OUTPUT_JSON") != "1":
    if not findings:
        print("  (no findings — overall: %s)" % data.get("overall", "clean"))
    else:
        for sev in ("blocker", "major", "minor", "nitpick"):
            bucket = [f for f in findings if f.get("severity") == sev]
            if not bucket: continue
            print("\n  %s (%d):" % (sev.upper(), len(bucket)))
            for f in bucket:
                loc = "%s:%s" % (f.get("file","?"), f.get("line") or "?")
                print("    - [%s] %s" % (loc, f.get("issue","")))
                sug = f.get("suggestion")
                if sug: print("      → %s" % sug)

if by_sev["blocker"] + by_sev["major"] > 0:
    sys.exit(1)
if by_sev["minor"] > 0:
    sys.stderr.write("  (note: %d minor finding(s) — not blocking, but worth addressing)\n"
                     % by_sev["minor"])
sys.exit(0)
'
