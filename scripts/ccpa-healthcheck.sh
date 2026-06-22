#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CCPA_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

NODE_BIN="${CCPA_NODE_BIN:-node}"
CANARY_SCRIPT="${CCPA_CANARY_SCRIPT:-$REPO_DIR/scripts/ccpa-canary.mjs}"
CONTRACT_SCRIPT="${CCPA_CONTRACT_SCRIPT:-$REPO_DIR/scripts/ccpa-contract-check.mjs}"
LOG_MAINTENANCE_SCRIPT="${CCPA_LOG_MAINTENANCE_SCRIPT:-$REPO_DIR/scripts/ccpa-log-maintenance.sh}"
BASE_URL="${CCPA_BASE_URL:-http://127.0.0.1:8317}"
CONFIG_PATH="${CCPA_CONFIG:-$REPO_DIR/config.yaml}"
LOG_PATH="${CCPA_HEALTHCHECK_LOG:-/tmp/ccpa-healthcheck.log}"
RESTART_ENABLED="${CCPA_HEALTHCHECK_RESTART:-true}"
MAINTAIN_LOGS="${CCPA_HEALTHCHECK_MAINTAIN_LOGS:-false}"
RUN_CONTRACT="${CCPA_HEALTHCHECK_RUN_CONTRACT:-true}"
LAUNCHD_LABEL="${CCPA_LAUNCHD_LABEL:-gui/$(id -u)/com.wy.ccpa}"
RESTART_SLEEP_SECONDS="${CCPA_HEALTHCHECK_RESTART_SLEEP_SECONDS:-20}"
REQUIRE_PROVIDER_STATUS="${CCPA_HEALTHCHECK_REQUIRE_PROVIDER_STATUS:-degraded}"
CHECK_DIST="${CCPA_HEALTHCHECK_CHECK_DIST:-true}"
TIMEOUT_MS="${CCPA_CANARY_TIMEOUT_MS:-5000}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/ccpa-healthcheck.sh [--restart|--no-restart] [--help]

Runs the low-cost CCPA canary plus the no-upstream OpenAI contract gate, and
optionally restarts the launchd service if either fails. The script does not
hardcode API keys and does not send model-generation requests; the checks read
api-keys[0] from config.yaml unless CCPA_API_KEY is set in the environment.

Environment:
  CCPA_BASE_URL=http://127.0.0.1:8317
  CCPA_CONFIG=/path/to/config.yaml
  CCPA_CANARY_SCRIPT=/path/to/scripts/ccpa-canary.mjs
  CCPA_CONTRACT_SCRIPT=/path/to/scripts/ccpa-contract-check.mjs
  CCPA_LOG_MAINTENANCE_SCRIPT=/path/to/scripts/ccpa-log-maintenance.sh
  CCPA_HEALTHCHECK_LOG=/tmp/ccpa-healthcheck.log
  CCPA_HEALTHCHECK_RESTART=true
  CCPA_HEALTHCHECK_MAINTAIN_LOGS=false
  CCPA_HEALTHCHECK_RUN_CONTRACT=true
  CCPA_LAUNCHD_LABEL=gui/$(id -u)/com.wy.ccpa
  CCPA_HEALTHCHECK_RESTART_SLEEP_SECONDS=20
  CCPA_HEALTHCHECK_REQUIRE_PROVIDER_STATUS=degraded
  CCPA_HEALTHCHECK_CHECK_DIST=true
  CCPA_CANARY_TIMEOUT_MS=5000

Provider readiness:
  degraded  At least one provider is available. This is the default.
  ok        All configured providers must be available.
  any       Only verify the server contract; do not require usable providers.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    --restart)
      RESTART_ENABLED=true
      ;;
    --no-restart)
      RESTART_ENABLED=false
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ts() {
  date '+%F %T'
}

log_line() {
  mkdir -p "$(dirname "$LOG_PATH")"
  printf '%s %s\n' "$(ts)" "$*" \
    | sed -E \
      -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[email:redacted]/g' \
      -e 's/sk-[A-Za-z0-9_-]{8,}/[api-key:redacted]/g' \
    >> "$LOG_PATH"
}

compact() {
  tr '\n' ' ' | cut -c 1-600
}

run_canary() {
  local args=(
    "$CANARY_SCRIPT"
    --url "$BASE_URL"
    --config "$CONFIG_PATH"
    --timeout-ms "$TIMEOUT_MS"
    --require-provider-status "$REQUIRE_PROVIDER_STATUS"
  )

  if [ "$CHECK_DIST" = "false" ]; then
    args+=(--no-dist-check)
  fi

  "$NODE_BIN" "${args[@]}"
}

run_contract() {
  "$NODE_BIN" "$CONTRACT_SCRIPT" \
    --url "$BASE_URL" \
    --config "$CONFIG_PATH" \
    --timeout-ms "$TIMEOUT_MS"
}

contract_enabled() {
  case "$RUN_CONTRACT" in
    true|1|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

run_log_maintenance_if_enabled() {
  case "$MAINTAIN_LOGS" in
    true|1|yes|YES)
      ;;
    *)
      return 0
      ;;
  esac

  if [ ! -f "$LOG_MAINTENANCE_SCRIPT" ]; then
    log_line "log maintenance skipped: script not found $LOG_MAINTENANCE_SCRIPT"
    return 0
  fi

  local maintenance_output
  local maintenance_status
  maintenance_output="$(bash "$LOG_MAINTENANCE_SCRIPT" 2>&1)"
  maintenance_status=$?
  if [ "$maintenance_status" -eq 0 ]; then
    log_line "log maintenance ok: $(printf '%s' "$maintenance_output" | compact)"
    return 0
  fi

  log_line "log maintenance failed: exit=$maintenance_status $(printf '%s' "$maintenance_output" | compact)"
  return 0
}

CHECK_OUTPUT=""

run_checks_once() {
  local output
  local status
  output="$(run_canary 2>&1)"
  status=$?
  if [ "$status" -ne 0 ]; then
    CHECK_OUTPUT="canary exit=$status $(printf '%s' "$output" | compact)"
    return "$status"
  fi

  CHECK_OUTPUT="$(printf '%s' "$output" | compact)"
  if ! contract_enabled; then
    return 0
  fi

  local contract_output
  local contract_status
  contract_output="$(run_contract 2>&1)"
  contract_status=$?
  if [ "$contract_status" -ne 0 ]; then
    CHECK_OUTPUT="contract exit=$contract_status $(printf '%s' "$contract_output" | compact)"
    return "$contract_status"
  fi

  CHECK_OUTPUT="$CHECK_OUTPUT; contract: $(printf '%s' "$contract_output" | compact)"
  return 0
}

run_log_maintenance_if_enabled

run_checks_once
status=$?
if [ "$status" -eq 0 ]; then
  log_line "OK: $CHECK_OUTPUT"
  exit 0
fi

log_line "FAIL: $CHECK_OUTPUT"

case "$RESTART_ENABLED" in
  true|1|yes|YES)
    ;;
  *)
    log_line "restart disabled"
    exit "$status"
    ;;
esac

if ! command -v launchctl >/dev/null 2>&1; then
  log_line "restart unavailable: launchctl not found"
  exit "$status"
fi

log_line "restart: launchctl kickstart -k $LAUNCHD_LABEL"
restart_output="$(launchctl kickstart -k "$LAUNCHD_LABEL" 2>&1)"
restart_status=$?
if [ "$restart_status" -ne 0 ]; then
  log_line "restart failed: exit=$restart_status $(printf '%s' "$restart_output" | compact)"
  exit "$restart_status"
fi

sleep "$RESTART_SLEEP_SECONDS"

run_checks_once
status_after_restart=$?
if [ "$status_after_restart" -eq 0 ]; then
  log_line "RECOVERED: $CHECK_OUTPUT"
  exit 0
fi

log_line "STILL_FAILING: $CHECK_OUTPUT"
exit "$status_after_restart"
