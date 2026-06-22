#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

function printUsage() {
  console.log(`Usage: node scripts/ccpa-contract-check.mjs [--url URL] [--config config.yaml] [--api-key KEY]

Runs no-upstream OpenAI-compatible contract checks against a running CCPA instance:
  - GET /health runtime identity
  - GET /v1/models without auth expects JSON missing_api_key
  - GET /admin/usage with bad auth expects JSON invalid_api_key
  - GET /admin/accounts readiness summary
  - GET /v1/models model list
  - POST /v1/embeddings expects JSON endpoint_not_implemented
  - POST /v1/chat/completions malformed JSON expects invalid_json
  - POST /v1/chat/completions unsupported model expects unsupported_model
  - POST /v1/responses missing model expects missing_required_parameter
  - POST /v1/images/generations missing prompt expects missing_required_parameter
  - POST /v1/messages missing max_tokens expects missing_required_parameter
  - POST /v1/messages/count_tokens streaming expects invalid_parameter
  - GET /admin/not-real expects JSON endpoint_not_implemented

These checks intentionally use local validation/auth/error paths and do not send
model-generation requests to Claude or Codex upstream.

Environment:
  CCPA_BASE_URL
  CCPA_CONFIG
  CCPA_API_KEY
  CCPA_CONTRACT_TIMEOUT_MS`);
}

function parseArgs(argv) {
  const args = {
    config: process.env.CCPA_CONFIG || path.join(process.cwd(), "config.yaml"),
    url: process.env.CCPA_BASE_URL || "",
    apiKey: process.env.CCPA_API_KEY || "",
    timeoutMs: Number(process.env.CCPA_CONTRACT_TIMEOUT_MS || 5000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "--config") args.config = next();
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

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const parsed = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a YAML object: ${configPath}`);
  }
  return parsed;
}

function resolveBaseUrl(args, config) {
  if (args.url) {
    return args.url.replace(/\/+$/, "");
  }
  const host = typeof config.host === "string" && config.host.trim() ? config.host.trim() : "127.0.0.1";
  const safeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const port = Number.isFinite(Number(config.port)) ? Number(config.port) : 8317;
  return `http://${safeHost}:${port}`;
}

function resolveApiKey(args, config) {
  if (args.apiKey) {
    return args.apiKey;
  }
  const apiKeys = Array.isArray(config["api-keys"]) ? config["api-keys"] : [];
  const firstKey = apiKeys.find((key) => typeof key === "string" && key.trim().length > 0);
  if (!firstKey) {
    throw new Error(`No API key found. Set CCPA_API_KEY or add api-keys[0] to ${args.config}`);
  }
  return firstKey.trim();
}

function makeRedactor(apiKey) {
  return (value) => {
    let text = String(value);
    if (apiKey) {
      text = text.split(apiKey).join("[REDACTED_API_KEY]");
    }
    text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]");
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
    return text;
  };
}

async function fetchText(baseUrl, pathName, options, timeoutMs) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  return { response, contentType, text };
}

function parseJsonOrThrow(name, result, redact) {
  try {
    return result.text ? JSON.parse(result.text) : null;
  } catch {
    throw new Error(
      `${name} expected JSON; got HTTP ${result.response.status} ${result.contentType || "(missing content-type)"} body=${redact(
        result.text.slice(0, 200)
      )}`
    );
  }
}

function parseExpectedErrorJsonOrThrow(check, result, redact) {
  try {
    return result.text ? JSON.parse(result.text) : null;
  } catch {
    throw new Error(
      `${check.name} expected HTTP ${check.status} JSON ${check.code}; got HTTP ${result.response.status} ${
        result.contentType || "(missing content-type)"
      } body=${redact(result.text.slice(0, 200))}`
    );
  }
}

async function expectErrorCode(baseUrl, check, apiKey, timeoutMs, redact) {
  const headers = {
    ...(check.auth === "valid" ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(check.auth === "invalid" ? { Authorization: "Bearer invalid-contract-key" } : {}),
    ...(check.headers || {}),
  };
  const result = await fetchText(
    baseUrl,
    check.path,
    {
      method: check.method,
      headers,
      ...(check.rawBody !== undefined ? { body: check.rawBody } : {}),
      ...(check.body !== undefined ? { body: JSON.stringify(check.body) } : {}),
    },
    timeoutMs
  );
  const body = parseExpectedErrorJsonOrThrow(check, result, redact);
  const code = body?.error?.code;
  const type = body?.error?.type;
  if (result.response.status !== check.status || code !== check.code || type !== check.type) {
    throw new Error(
      `${check.name} expected HTTP ${check.status} JSON ${check.code}; got HTTP ${result.response.status} ${
        result.contentType || "(missing content-type)"
      } body=${redact(result.text.slice(0, 300))}`
    );
  }
  return `${check.name}: ${code}`;
}

async function expectOkJson(baseUrl, check, apiKey, timeoutMs, redact) {
  const result = await fetchText(
    baseUrl,
    check.path,
    {
      method: check.method,
      headers: {
        ...(check.auth === "valid" ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(check.headers || {}),
      },
    },
    timeoutMs
  );
  const body = parseJsonOrThrow(check.name, result, redact);
  if (result.response.status !== 200) {
    throw new Error(
      `${check.name} expected HTTP 200 JSON; got HTTP ${result.response.status} body=${redact(
        result.text.slice(0, 300)
      )}`
    );
  }
  return body;
}

function assertRuntimeIdentity(health) {
  const ok =
    health?.status === "ok" &&
    health?.service === "auth2api" &&
    typeof health?.version === "string" &&
    health.version.length > 0 &&
    typeof health?.started_at === "string" &&
    typeof health?.uptime_ms === "number";
  if (!ok) {
    throw new Error("GET /health expected runtime identity service/version/started_at/uptime_ms");
  }
}

async function runContractCheck(args) {
  const config = readConfig(args.config);
  const baseUrl = resolveBaseUrl(args, config);
  const apiKey = resolveApiKey(args, config);
  const redact = makeRedactor(apiKey);
  const results = [];

  const health = await expectOkJson(
    baseUrl,
    { name: "GET /health", method: "GET", path: "/health" },
    apiKey,
    args.timeoutMs,
    redact
  );
  assertRuntimeIdentity(health);
  results.push("health runtime identity: ok");

  results.push(
    await expectErrorCode(
      baseUrl,
      {
        name: "GET /v1/models without auth",
        method: "GET",
        path: "/v1/models",
        status: 401,
        type: "authentication_error",
        code: "missing_api_key",
      },
      apiKey,
      args.timeoutMs,
      redact
    )
  );

  results.push(
    await expectErrorCode(
      baseUrl,
      {
        name: "GET /admin/usage with bad auth",
        method: "GET",
        path: "/admin/usage",
        auth: "invalid",
        status: 403,
        type: "authentication_error",
        code: "invalid_api_key",
      },
      apiKey,
      args.timeoutMs,
      redact
    )
  );

  const admin = await expectOkJson(
    baseUrl,
    { name: "GET /admin/accounts", method: "GET", path: "/admin/accounts", auth: "valid" },
    apiKey,
    args.timeoutMs,
    redact
  );
  const providerStatus = admin?.server?.provider_status;
  if (typeof providerStatus !== "string" || !admin?.server?.providers) {
    throw new Error("GET /admin/accounts expected server provider readiness summary");
  }
  results.push(`GET /admin/accounts: ${providerStatus}`);

  await expectOkJson(
    baseUrl,
    { name: "GET /admin/usage", method: "GET", path: "/admin/usage", auth: "valid" },
    apiKey,
    args.timeoutMs,
    redact
  );
  results.push("GET /admin/usage: ok");

  const recent = await expectOkJson(
    baseUrl,
    { name: "GET /admin/usage/recent", method: "GET", path: "/admin/usage/recent?limit=1", auth: "valid" },
    apiKey,
    args.timeoutMs,
    redact
  );
  if (!Array.isArray(recent?.items) || typeof recent?.generatedAt !== "string") {
    throw new Error("GET /admin/usage/recent expected JSON snapshot with generatedAt and items array");
  }
  results.push("GET /admin/usage/recent: ok");

  const models = await expectOkJson(
    baseUrl,
    { name: "GET /v1/models", method: "GET", path: "/v1/models", auth: "valid" },
    apiKey,
    args.timeoutMs,
    redact
  );
  if (!Array.isArray(models?.data) || models.data.length === 0) {
    throw new Error("GET /v1/models expected non-empty data array");
  }
  results.push(`GET /v1/models: ${models.data.length} model(s)`);

  const jsonHeaders = { "content-type": "application/json" };
  const invalidChecks = [
    {
      name: "POST /v1/embeddings",
      method: "POST",
      path: "/v1/embeddings",
      auth: "valid",
      headers: jsonHeaders,
      body: { model: "text-embedding-3-small", input: "contract" },
      status: 404,
      type: "invalid_request_error",
      code: "endpoint_not_implemented",
    },
    {
      name: "POST /v1/chat/completions malformed JSON",
      method: "POST",
      path: "/v1/chat/completions",
      auth: "valid",
      headers: jsonHeaders,
      rawBody: '{"model":',
      status: 400,
      type: "invalid_request_error",
      code: "invalid_json",
    },
    {
      name: "POST /v1/chat/completions unsupported model",
      method: "POST",
      path: "/v1/chat/completions",
      auth: "valid",
      headers: jsonHeaders,
      body: { model: "not-a-real-model", messages: [{ role: "user", content: "hello" }] },
      status: 400,
      type: "invalid_request_error",
      code: "unsupported_model",
    },
    {
      name: "POST /v1/responses missing model",
      method: "POST",
      path: "/v1/responses",
      auth: "valid",
      headers: jsonHeaders,
      body: { input: "hello" },
      status: 400,
      type: "invalid_request_error",
      code: "missing_required_parameter",
    },
    {
      name: "POST /v1/images/generations missing prompt",
      method: "POST",
      path: "/v1/images/generations",
      auth: "valid",
      headers: jsonHeaders,
      body: { model: "gpt-image-2" },
      status: 400,
      type: "invalid_request_error",
      code: "missing_required_parameter",
    },
    {
      name: "POST /v1/messages missing max_tokens",
      method: "POST",
      path: "/v1/messages",
      auth: "valid",
      headers: jsonHeaders,
      body: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hello" }] },
      status: 400,
      type: "invalid_request_error",
      code: "missing_required_parameter",
    },
    {
      name: "POST /v1/messages/count_tokens streaming",
      method: "POST",
      path: "/v1/messages/count_tokens",
      auth: "valid",
      headers: jsonHeaders,
      body: { model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "hello" }] },
      status: 400,
      type: "invalid_request_error",
      code: "invalid_parameter",
    },
    {
      name: "GET /admin/not-real",
      method: "GET",
      path: "/admin/not-real",
      auth: "valid",
      status: 404,
      type: "invalid_request_error",
      code: "endpoint_not_implemented",
    },
  ];

  for (const check of invalidChecks) {
    results.push(await expectErrorCode(baseUrl, check, apiKey, args.timeoutMs, redact));
  }

  return results;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const results = await runContractCheck(args);
    for (const line of results) {
      console.log(line);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
