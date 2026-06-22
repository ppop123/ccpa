#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

function parseArgs(argv) {
  const args = {
    config: process.env.CCPA_CONFIG || path.join(process.cwd(), "config.yaml"),
    url: process.env.CCPA_BASE_URL || "",
    apiKey: process.env.CCPA_API_KEY || "",
    dist: process.env.CCPA_DIST_PATH || path.join(process.cwd(), "dist", "index.js"),
    checkDist: process.env.CCPA_CANARY_CHECK_DIST !== "false",
    requireProviderStatus: process.env.CCPA_CANARY_REQUIRE_PROVIDER_STATUS || "degraded",
    timeoutMs: Number(process.env.CCPA_CANARY_TIMEOUT_MS || 5000),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index++;
      return value;
    };

    if (arg === "--config") args.config = next();
    else if (arg === "--url") args.url = next();
    else if (arg === "--api-key") args.apiKey = next();
    else if (arg === "--dist") args.dist = next();
    else if (arg === "--no-dist-check") args.checkDist = false;
    else if (arg === "--require-provider-status") args.requireProviderStatus = next();
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
  validateProviderStatusRequirement(args.requireProviderStatus);

  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/ccpa-canary.mjs [--url URL] [--config config.yaml] [--api-key KEY] [--dist dist/index.js] [--no-dist-check] [--require-provider-status any|degraded|ok]

Runs low-cost checks against a running CCPA instance:
  - GET /health
  - GET /admin/accounts
  - GET /v1/models
  - POST /v1/embeddings expecting JSON endpoint_not_implemented
  - local dist freshness when --dist exists and checking is enabled

Environment:
  CCPA_BASE_URL
  CCPA_CONFIG
  CCPA_API_KEY
  CCPA_DIST_PATH
  CCPA_CANARY_CHECK_DIST=false
  CCPA_CANARY_REQUIRE_PROVIDER_STATUS=degraded
  CCPA_CANARY_TIMEOUT_MS`);
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

async function fetchJson(baseUrl, pathName, options, timeoutMs) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${pathName} returned non-JSON response: ${text.slice(0, 160)}`);
  }
  return { response, contentType, body };
}

function assertRuntimeIdentity(health) {
  const missing =
    !health ||
    health.status !== "ok" ||
    health.service !== "auth2api" ||
    typeof health.version !== "string" ||
    health.version.length === 0 ||
    typeof health.started_at !== "string" ||
    typeof health.uptime_ms !== "number";
  if (missing) {
    throw new Error("health missing runtime identity: expected service/version/started_at/uptime_ms");
  }
}

function assertDistFreshness(health, distPath) {
  if (!distPath || !fs.existsSync(distPath)) {
    return null;
  }
  const startedMs = Date.parse(health.started_at);
  if (!Number.isFinite(startedMs)) {
    throw new Error("health started_at is not a parseable timestamp");
  }
  const distStat = fs.statSync(distPath);
  const distMs = distStat.mtimeMs;
  if (distMs > startedMs + 1000) {
    throw new Error(
      `live process started before local dist build: started_at=${health.started_at}, dist=${distPath}, dist_mtime=${distStat.mtime.toISOString()}`
    );
  }
  return distStat.mtime.toISOString();
}

function assertJsonResponse(contentType, pathName) {
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${pathName} returned non-JSON content-type: ${contentType || "(missing)"}`);
  }
}

const PROVIDER_STATUS_RANK = {
  unavailable: 0,
  degraded: 1,
  ok: 2,
};

function validateProviderStatusRequirement(required) {
  if (!Object.hasOwn(PROVIDER_STATUS_RANK, required) && required !== "any") {
    throw new Error("--require-provider-status must be one of: any, degraded, ok");
  }
}

function normalizeProviderStatus(server) {
  const status = typeof server?.provider_status === "string" ? server.provider_status : "";
  if (Object.hasOwn(PROVIDER_STATUS_RANK, status)) {
    return status;
  }
  const available = Number(server?.providers?.available);
  if (Number.isFinite(available)) {
    return available > 0 ? "degraded" : "unavailable";
  }
  return "";
}

function assertProviderReadiness(server, required) {
  if (required === "any") {
    return;
  }
  const status = normalizeProviderStatus(server);
  if (!Object.hasOwn(PROVIDER_STATUS_RANK, status)) {
    throw new Error("admin/accounts returned unknown provider_status");
  }
  if (PROVIDER_STATUS_RANK[status] < PROVIDER_STATUS_RANK[required]) {
    throw new Error(`provider readiness ${status} does not satisfy required ${required}`);
  }
}

function shellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function firstClaudeAccount(adminBody) {
  const accounts = adminBody?.claude?.details?.accounts;
  return Array.isArray(accounts) ? accounts[0] : null;
}

function claudeUnavailableReason(adminBody) {
  const account = firstClaudeAccount(adminBody);
  if (!account) {
    return ["reason=no_account"];
  }

  const parts = [];
  const expiresMs = Date.parse(account.expiresAt || "");
  if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
    parts.push("reason=token_expired");
  } else if (account.available === false) {
    parts.push("reason=account_unavailable");
  }

  const refreshFailures = Number(account.refreshFailureCount);
  if (Number.isFinite(refreshFailures) && refreshFailures > 0) {
    parts.push(`refresh_failures=${refreshFailures}`);
  }

  const nextRefreshMs = Number(account.nextRefreshAttemptAt);
  if (Number.isFinite(nextRefreshMs) && nextRefreshMs > 0) {
    parts.push(`next_refresh_attempt=${new Date(nextRefreshMs).toISOString()}`);
  }

  return parts.length > 0 ? parts : ["reason=unknown"];
}

function providerRecoveryHints(adminBody, args) {
  const unavailable = Array.isArray(adminBody?.server?.providers?.unavailable)
    ? adminBody.server.providers.unavailable.map((name) => String(name).toLowerCase())
    : [];
  const hints = [];
  const configArg = `--config=${shellArg(args.config)}`;

  if (unavailable.includes("claude")) {
    hints.push(
      `provider_hint: claude unavailable ${claudeUnavailableReason(adminBody).join(" ")}; run from repo root: node dist/index.js ${configArg} --login --manual (set HTTPS_PROXY in this shell if needed)`
    );
  }

  if (unavailable.includes("codex")) {
    const authPath = adminBody?.codex?.details?.path;
    const authSuffix = typeof authPath === "string" && authPath ? ` auth_file=${authPath}` : "";
    hints.push(`provider_hint: codex unavailable${authSuffix}; run from repo root: node dist/index.js ${configArg} --login-codex`);
  }

  return hints;
}

async function runCanary(args) {
  const config = readConfig(args.config);
  const baseUrl = resolveBaseUrl(args, config);
  const apiKey = resolveApiKey(args, config);
  const headers = { Authorization: `Bearer ${apiKey}` };
  const results = [];

  const health = await fetchJson(baseUrl, "/health", { method: "GET" }, args.timeoutMs);
  assertJsonResponse(health.contentType, "/health");
  assertRuntimeIdentity(health.body);
  results.push(`health: ok ${health.body.service}@${health.body.version} started_at=${health.body.started_at}`);
  if (args.checkDist) {
    const distMtime = assertDistFreshness(health.body, args.dist);
    if (distMtime) {
      results.push(`dist: fresh ${args.dist} mtime=${distMtime}`);
    }
  }

  const admin = await fetchJson(baseUrl, "/admin/accounts", { method: "GET", headers }, args.timeoutMs);
  assertJsonResponse(admin.contentType, "/admin/accounts");
  if (admin.response.status !== 200) {
    throw new Error(`/admin/accounts returned HTTP ${admin.response.status}`);
  }
  const server = admin.body?.server;
  if (!server || typeof server.provider_status !== "string" || !server.providers) {
    throw new Error("admin/accounts missing server readiness summary");
  }
  const providerStatus = server.provider_status;
  const available = Number(server.providers.available);
  const total = Number(server.providers.total);
  const unavailable = Array.isArray(server.providers.unavailable) ? server.providers.unavailable.join(",") : "";
  const providerSummary = `admin/accounts: ${providerStatus} (${available}/${total} providers available${unavailable ? `; unavailable: ${unavailable}` : ""})`;
  const recoveryHints = providerRecoveryHints(admin.body, args);
  try {
    assertProviderReadiness(server, args.requireProviderStatus);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error([message, providerSummary, ...recoveryHints].join("\n"));
  }
  results.push(providerSummary);
  results.push(...recoveryHints);

  const models = await fetchJson(baseUrl, "/v1/models", { method: "GET", headers }, args.timeoutMs);
  assertJsonResponse(models.contentType, "/v1/models");
  if (models.response.status !== 200 || !Array.isArray(models.body?.data) || models.body.data.length === 0) {
    throw new Error("/v1/models did not return a non-empty model list");
  }
  results.push(`v1/models: ${models.body.data.length} model(s)`);

  const embeddings = await fetchJson(
    baseUrl,
    "/v1/embeddings",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "canary" }),
    },
    args.timeoutMs
  );
  assertJsonResponse(embeddings.contentType, "/v1/embeddings");
  if (embeddings.response.status !== 404 || embeddings.body?.error?.code !== "endpoint_not_implemented") {
    throw new Error("/v1/embeddings did not return JSON endpoint_not_implemented");
  }
  results.push("v1/embeddings: endpoint_not_implemented");

  return results;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const results = await runCanary(args);
    for (const line of results) {
      console.log(line);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
