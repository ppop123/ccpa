#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const API_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function redact(value, apiKey = "") {
  let text = String(value);
  if (apiKey) text = text.split(apiKey).join("[api-key:redacted]");
  return text.replace(API_KEY_RE, "[api-key:redacted]").replace(EMAIL_RE, "[email:redacted]");
}

function printUsage() {
  console.log(`Usage: node scripts/ccpa-upstream-matrix.mjs [options]

Runs an optional CCPA upstream matrix through the local OpenAI-compatible API.
Default mode is dry-run and does not require config, network, or API keys.

This is different from canary/contract/release verify: --apply sends real
generation requests through the local CCPA service and spends upstream quota.
Image generation is excluded unless --include-image is also set.

Options:
  --apply              Execute the matrix; otherwise print the plan only
  --include-image      Include POST /v1/images/generations (extra quota)
  --url URL            Live CCPA base URL, default config host/port or localhost
  --config PATH        Config file, default config.yaml
  --api-key KEY        API key, default CCPA_API_KEY or config api-keys[0]
  --timeout-ms MS      Timeout per request, default 60000
  --help, -h           Show this help

Environment:
  CCPA_BASE_URL
  CCPA_CONFIG
  CCPA_API_KEY
  CCPA_UPSTREAM_MATRIX_TIMEOUT_MS`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    includeImage: false,
    config: process.env.CCPA_CONFIG || path.join(process.cwd(), "config.yaml"),
    url: process.env.CCPA_BASE_URL || "",
    apiKey: process.env.CCPA_API_KEY || "",
    timeoutMs: Number(process.env.CCPA_UPSTREAM_MATRIX_TIMEOUT_MS || 60000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--apply") args.apply = true;
    else if (arg === "--include-image") args.includeImage = true;
    else if (arg === "--config") args.config = next();
    else if (arg === "--url") args.url = next();
    else if (arg === "--api-key") args.apiKey = next();
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return args;
}

function readConfigIfPresent(configPath) {
  if (!fs.existsSync(configPath)) return {};
  const parsed = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a YAML object: ${configPath}`);
  }
  return parsed;
}

function resolveBaseUrl(args, config) {
  if (args.url) return args.url.replace(/\/+$/, "");
  const host = typeof config.host === "string" && config.host.trim() ? config.host.trim() : "127.0.0.1";
  const safeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const port = Number.isFinite(Number(config.port)) ? Number(config.port) : 8317;
  return `http://${safeHost}:${port}`;
}

function resolveApiKey(args, config) {
  if (args.apiKey) return args.apiKey;
  const apiKeys = Array.isArray(config["api-keys"]) ? config["api-keys"] : [];
  const firstKey = apiKeys.find((key) => typeof key === "string" && key.trim().length > 0);
  if (!firstKey) {
    throw new Error(`No API key found. Set CCPA_API_KEY, pass --api-key, or add api-keys[0] to ${args.config}`);
  }
  return firstKey.trim();
}

function buildChecks(includeImage) {
  const checks = [
    {
      name: "codex chat completions",
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 8,
        temperature: 0,
      },
      validate: (body) => Boolean(body?.choices?.[0]?.message?.content),
    },
    {
      name: "codex responses string input",
      method: "POST",
      path: "/v1/responses",
      body: {
        model: "gpt-5.4",
        input: "Reply with exactly: ok",
        max_output_tokens: 8,
        temperature: 0,
      },
      validate: (body) => Boolean(body?.output_text || body?.output || body?.status === "completed"),
    },
    {
      name: "claude chat completions",
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 8,
        temperature: 0,
      },
      validate: (body) => Boolean(body?.choices?.[0]?.message?.content),
    },
    {
      name: "claude responses string input",
      method: "POST",
      path: "/v1/responses",
      body: {
        model: "claude-sonnet-4-6",
        input: "Reply with exactly: ok",
        max_output_tokens: 8,
        temperature: 0,
      },
      validate: (body) => Boolean(body?.output_text || body?.output || body?.status === "completed"),
    },
  ];

  if (includeImage) {
    checks.push({
      name: "codex images generations",
      method: "POST",
      path: "/v1/images/generations",
      body: {
        model: "gpt-image-2",
        prompt: "A tiny blue square icon on a white background.",
        size: "1024x1024",
        response_format: "b64_json",
      },
      validate: (body) => Array.isArray(body?.data) && body.data.some((item) => item?.b64_json || item?.url),
    });
  }

  return checks;
}

function printPlannedChecks(checks) {
  console.log("planned checks:");
  for (const check of checks) {
    console.log(`  - ${check.name}: ${check.method} ${check.path} model=${check.body.model}`);
  }
}

async function fetchJson(baseUrl, check, apiKey, timeoutMs) {
  const response = await fetch(`${baseUrl}${check.path}`, {
    method: check.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(check.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HTTP ${response.status} non-JSON ${contentType || "(missing content-type)"} body=${text.slice(0, 300)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} body=${JSON.stringify(body).slice(0, 500)}`);
  }
  if (!check.validate(body)) {
    throw new Error(`HTTP ${response.status} unexpected body=${JSON.stringify(body).slice(0, 500)}`);
  }
}

async function runMatrix(args) {
  const config = readConfigIfPresent(args.config);
  const baseUrl = resolveBaseUrl(args, config);
  const checks = buildChecks(args.includeImage);

  console.log("ccpa upstream matrix");
  console.log(`mode: ${args.apply ? "apply" : "dry-run"}`);
  console.log(`quota_spending: ${args.apply ? "yes" : "no"}`);
  console.log(`url: ${baseUrl}`);
  printPlannedChecks(checks);

  if (!args.apply) {
    console.log("upstream_matrix: dry-run");
    return true;
  }

  const apiKey = resolveApiKey(args, config);
  for (const check of checks) {
    try {
      await fetchJson(baseUrl, check, apiKey, args.timeoutMs);
      console.log(`${check.name}: ok`);
    } catch (err) {
      console.log(`${check.name}: failed`);
      console.log(`  ${redact(err.message || err, apiKey)}`);
      console.log("upstream_matrix: no");
      return false;
    }
  }

  console.log("upstream_matrix: yes");
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ok = await runMatrix(args);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(redact(err.message || err));
  process.exit(2);
});
