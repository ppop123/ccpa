#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE_URL="${CCPA_BASE_URL:-http://127.0.0.1:8317}"
CONFIG_PATH="${CCPA_CONFIG:-$REPO_DIR/config.yaml}"
MODEL="${1:-gpt-5.4}"
PROMPT="${2:-Reply with ok.}"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

API_KEY="$(
  node - "$CONFIG_PATH" "$REPO_DIR/node_modules/js-yaml" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const yaml = require(process.argv[3]);

const config = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
const apiKeys = Array.isArray(config["api-keys"]) ? config["api-keys"] : [];

if (!apiKeys.length || typeof apiKeys[0] !== "string" || !apiKeys[0]) {
  console.error(`No api-keys[0] found in ${configPath}`);
  process.exit(1);
}

process.stdout.write(apiKeys[0]);
NODE
)"

curl -sS "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"stream":false}' \
    "$MODEL" "$(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])')")"
