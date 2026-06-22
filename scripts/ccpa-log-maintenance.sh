#!/usr/bin/env bash
set -u

DEFAULT_LOG_PATHS="/tmp/ccpa.stdout.log:/tmp/ccpa.stderr.log:/tmp/ccpa-healthcheck.log"
LOG_PATHS="${CCPA_LOG_PATHS:-$DEFAULT_LOG_PATHS}"
MAX_BYTES="${CCPA_LOG_MAX_BYTES:-1048576}"
KEEP="${CCPA_LOG_KEEP:-5}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/ccpa-log-maintenance.sh [--help]

Redacts account identifiers/API-key-shaped strings from CCPA logs and rotates
oversized logs with copy-truncate semantics. This is safe for launchd stdout /
stderr files because the current log path is truncated in place instead of
being renamed away from the process' open file descriptor.

Defaults:
  /tmp/ccpa.stdout.log
  /tmp/ccpa.stderr.log
  /tmp/ccpa-healthcheck.log

Environment:
  CCPA_LOG_PATHS=/tmp/ccpa.stdout.log:/tmp/ccpa.stderr.log:/tmp/ccpa-healthcheck.log
  CCPA_LOG_MAX_BYTES=1048576
  CCPA_LOG_KEEP=5

Rotations are written as <log>.1, <log>.2, ... up to CCPA_LOG_KEEP. Rotated
snapshots are redacted before they are written.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$MAX_BYTES" in
  ""|*[!0-9]*)
    echo "CCPA_LOG_MAX_BYTES must be a non-negative integer" >&2
    exit 2
    ;;
esac

case "$KEEP" in
  ""|*[!0-9]*)
    echo "CCPA_LOG_KEEP must be a non-negative integer" >&2
    exit 2
    ;;
esac

redact_file_in_place() {
  local file="$1"
  local tmp

  [ -f "$file" ] || return 0
  tmp="${file}.redact.$$"

  if ! perl -pe 's/\bsk-[A-Za-z0-9_-]{8,}\b/[api-key:redacted]/g; s/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/[email:redacted]/gi' "$file" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi

  if ! cat "$tmp" > "$file"; then
    rm -f "$tmp"
    return 1
  fi

  rm -f "$tmp"
}

file_size_bytes() {
  wc -c < "$1" | tr -d ' '
}

redact_existing_rotations() {
  local log_path="$1"
  local i=1

  while [ "$i" -le "$KEEP" ]; do
    redact_file_in_place "${log_path}.${i}" || return 1
    i=$((i + 1))
  done
}

rotate_log_if_needed() {
  local log_path="$1"
  local size
  local i

  [ -e "$log_path" ] || {
    echo "SKIP missing $log_path"
    return 0
  }

  redact_file_in_place "$log_path" || {
    echo "ERROR failed to redact $log_path" >&2
    return 1
  }
  redact_existing_rotations "$log_path" || {
    echo "ERROR failed to redact rotations for $log_path" >&2
    return 1
  }

  size="$(file_size_bytes "$log_path")"
  if [ "$size" -le "$MAX_BYTES" ]; then
    echo "OK redacted $log_path bytes=$size"
    return 0
  fi

  if [ "$KEEP" -gt 0 ]; then
    if [ -e "${log_path}.${KEEP}" ]; then
      rm -f "${log_path}.${KEEP}"
    fi

    i=$((KEEP - 1))
    while [ "$i" -ge 1 ]; do
      if [ -e "${log_path}.${i}" ]; then
        mv "${log_path}.${i}" "${log_path}.$((i + 1))"
      fi
      i=$((i - 1))
    done

    cp "$log_path" "${log_path}.1"
  fi

  : > "$log_path"
  echo "ROTATED $log_path bytes=$size keep=$KEEP"
}

IFS=':' read -r -a paths <<< "$LOG_PATHS"
for log_path in "${paths[@]}"; do
  [ -n "$log_path" ] || continue
  rotate_log_if_needed "$log_path" || exit 1
done
