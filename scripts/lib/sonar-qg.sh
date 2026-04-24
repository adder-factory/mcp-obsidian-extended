# sonar-qg.sh — SonarQube quality-gate verdict polling.
#
# Sourced by scripts/pre-pr.sh after common.sh. NOT executed directly.
# Depends on the banner/info/warn/fail/ok helpers from lib/common.sh.
#
# Rationale: the scanner (`npx sonarqube-scanner`) exits 0 whenever it
# successfully uploads analysis data to the server. The gate verdict is
# computed asynchronously server-side by a compute engine (CE) task and
# is only readable via `/api/qualitygates/project_status`. Without a
# server-side poll after the scanner exits, a failing QG is silently
# reported as "SonarQube pass" on every PR (Issue #7).

if [ -n "${_ADDER_SONAR_QG_SH_LOADED:-}" ]; then return 0; fi
_ADDER_SONAR_QG_SH_LOADED=1

# verify_sonar_qg [report-task.txt]
# Polls the CE task to completion, then reads the quality-gate verdict.
# Returns 0 when projectStatus.status = OK, non-zero otherwise.
#
# Requires:
#   SONAR_TOKEN               auth token (user token; password field left empty)
#   SONAR_HOST_URL            server URL (falls back from report-task.txt serverUrl)
#
# Env overrides (mainly for tests):
#   SONAR_QG_TIMEOUT_SEC      max wait for CE task to complete (default 300)
#   SONAR_QG_POLL_INTERVAL    sleep between CE task polls (default 5)
verify_sonar_qg() {
  local report_file="${1:-.scannerwork/report-task.txt}"
  local timeout="${SONAR_QG_TIMEOUT_SEC:-300}"
  local interval="${SONAR_QG_POLL_INTERVAL:-5}"
  # Per-request caps so a hung curl can't blow past the outer deadline.
  # --connect-timeout fails fast on DNS/TCP; --max-time caps total request
  # wall time. Outer deadline still enforces the overall timeout.
  local connect_to="${SONAR_QG_CONNECT_TIMEOUT:-10}"
  local request_to="${SONAR_QG_REQUEST_TIMEOUT:-30}"

  if [ ! -f "$report_file" ]; then
    fail "Sonar report-task.txt not found at $report_file — scanner did not produce one"
    return 1
  fi
  if [ -z "${SONAR_TOKEN:-}" ]; then
    fail "SONAR_TOKEN must be set to query quality-gate verdict"
    return 1
  fi
  require_cmd curl   "brew install curl (or ensure system curl is on PATH)"   || return 1
  require_cmd python3 "install python3 (macOS ships a recent version)"        || return 1

  # Strip the leading key with sub() rather than -F= — report-task.txt values
  # can legitimately contain '=' (e.g. server URLs with query params).
  local ce_task_id server_url
  ce_task_id=$(awk '/^ceTaskId=/{sub(/^ceTaskId=/, ""); print; exit}'  "$report_file")
  server_url=$(awk '/^serverUrl=/{sub(/^serverUrl=/, ""); print; exit}' "$report_file")

  if [ -z "$ce_task_id" ]; then
    fail "Could not parse ceTaskId from $report_file"
    return 1
  fi

  local host="${server_url:-${SONAR_HOST_URL:-}}"
  host="${host%/}"
  if [ -z "$host" ]; then
    fail "No serverUrl in $report_file and SONAR_HOST_URL unset"
    return 1
  fi

  info "Polling Sonar CE task $ce_task_id at $host (timeout ${timeout}s, interval ${interval}s)..."

  local deadline task_resp task_status analysis_id
  deadline=$(( $(date +%s) + timeout ))
  task_status=""
  task_resp=""
  while :; do
    # Feed `-u "$SONAR_TOKEN:"` via curl's --config on stdin so the token
    # never lands in argv / `ps aux` / /proc/<pid>/cmdline. Also avoids the
    # gitleaks curl-auth-user rule hit.
    if ! task_resp=$(printf -- '-u "%s:"\n' "$SONAR_TOKEN" | \
        curl -fsS --connect-timeout "$connect_to" --max-time "$request_to" \
        -K - "$host/api/ce/task?id=$ce_task_id"); then
      fail "Failed to fetch CE task status from $host/api/ce/task?id=$ce_task_id"
      return 1
    fi
    # `(d.get("k") or {})` handles both missing-key AND key=null (Gemini catch).
    if ! task_status=$(printf '%s' "$task_resp" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception as e:
    print(f"JSON parse failed: {e}", file=sys.stderr); sys.exit(1)
print((d.get("task") or {}).get("status", "") if isinstance(d, dict) else "")
'); then
      fail "Malformed JSON from $host/api/ce/task (see stderr)"
      return 1
    fi
    case "$task_status" in
      SUCCESS) break ;;
      FAILED|CANCELED)
        fail "Sonar CE task $ce_task_id ended with status $task_status"
        return 1 ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "Sonar CE task $ce_task_id did not reach SUCCESS within ${timeout}s (last status: ${task_status:-<none>})"
      return 1
    fi
    sleep "$interval"
  done

  if ! analysis_id=$(printf '%s' "$task_resp" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception as e:
    print(f"JSON parse failed: {e}", file=sys.stderr); sys.exit(1)
print((d.get("task") or {}).get("analysisId", "") if isinstance(d, dict) else "")
'); then
    fail "Malformed JSON from $host/api/ce/task (analysisId parse)"
    return 1
  fi
  if [ -z "$analysis_id" ]; then
    fail "CE task SUCCESS but response has no analysisId"
    return 1
  fi

  local qg_resp qg_status
  # Same -K stdin pattern for argv hygiene.
  if ! qg_resp=$(printf -- '-u "%s:"\n' "$SONAR_TOKEN" | \
      curl -fsS --connect-timeout "$connect_to" --max-time "$request_to" \
      -K - "$host/api/qualitygates/project_status?analysisId=$analysis_id"); then
    fail "Failed to fetch quality-gate status from $host/api/qualitygates/project_status"
    return 1
  fi
  if ! qg_status=$(printf '%s' "$qg_resp" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception as e:
    print(f"JSON parse failed: {e}", file=sys.stderr); sys.exit(1)
print((d.get("projectStatus") or {}).get("status", "") if isinstance(d, dict) else "")
'); then
    fail "Malformed JSON from $host/api/qualitygates/project_status"
    return 1
  fi

  case "$qg_status" in
    OK)
      ok "SonarQube quality gate: OK"
      return 0 ;;
    WARN)
      # Issue #7 contract is "fail on status != OK" — strict. WARN was
      # deprecated in Sonar 7.6+ and modern servers don't emit it, but if
      # a legacy server does, we fail rather than silently wave it through.
      fail "SonarQube quality gate: WARN (deprecated status; failing under strict != OK contract)"
      return 1 ;;
    ERROR)
      fail "SonarQube quality gate: ERROR"
      printf '%s' "$qg_resp" | python3 -c '
import json, sys
try:
    raw = json.load(sys.stdin)
except Exception as e:
    print(f"(diagnostic unavailable — malformed JSON: {e})", file=sys.stderr); sys.exit(0)
d = (raw.get("projectStatus") or {}) if isinstance(raw, dict) else {}
for c in (d.get("conditions") or []):
    if isinstance(c, dict) and c.get("status") == "ERROR":
        print("    • {mk}: actual={av} {op} threshold={th}".format(
            mk=c.get("metricKey", "?"),
            av=c.get("actualValue", "?"),
            op=c.get("comparator", "?"),
            th=c.get("errorThreshold", "?"),
        ))
' || true
      return 1 ;;
    *)
      fail "SonarQube QG returned unexpected status: ${qg_status:-<empty>}"
      return 1 ;;
  esac
}
