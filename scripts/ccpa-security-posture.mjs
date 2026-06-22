#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const API_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function redact(value) {
  return String(value).replace(API_KEY_RE, "[api-key:redacted]");
}

function printUsage() {
  console.log(`Usage: node scripts/ccpa-security-posture.mjs [options]

Runs a read-only CCPA configuration security posture check.

It fails for weak or placeholder client API keys. It warns, but does not fail,
when the service binds all interfaces while local rate limiting is disabled,
because intranet + API-key deployments are an intentional supported mode.

Options:
  --config PATH        config.yaml path, default ./config.yaml
  --help, -h           Show this help`);
}

function parseArgs(argv) {
  const args = {
    config: process.env.CCPA_CONFIG || path.join(process.cwd(), "config.yaml"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--config") args.config = next();
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.config = path.resolve(args.config);
  return args;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function normalizeApiKeys(value) {
  if (!Array.isArray(value)) return [];
  return value.map((key) => (typeof key === "string" ? key.trim() : "")).filter(Boolean);
}

function isPlaceholderKey(key) {
  return (
    /replace/i.test(key) ||
    /redacted/i.test(key) ||
    /placeholder/i.test(key) ||
    /^sk-(?:x+|example|test|dummy|local-redacted|remote-xxx|xxx)(?:[-_].*)?$/i.test(key)
  );
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function checkConfig(config) {
  const findings = [];
  const warnings = [];
  const apiKeys = normalizeApiKeys(config["api-keys"]);
  const host = typeof config.host === "string" ? config.host.trim() : "";
  const rateLimit =
    config["rate-limit"] && typeof config["rate-limit"] === "object" && !Array.isArray(config["rate-limit"])
      ? config["rate-limit"]
      : {};

  if (apiKeys.length === 0) {
    findings.push({
      code: "api_key_missing",
      message: "api-keys must contain at least one strong client key",
    });
  }

  apiKeys.forEach((key, index) => {
    if (isPlaceholderKey(key)) {
      findings.push({
        code: "api_key_placeholder",
        message: `api-keys[${index}] is a placeholder and must be replaced`,
      });
    }
    if (key.length < 40) {
      findings.push({
        code: "api_key_too_short",
        message: `api-keys[${index}] is too short for release use`,
      });
    }
  });

  const allInterfaceBind = host === "0.0.0.0" || host === "::" || host === "*";
  const rateLimitEnabled = normalizeBoolean(rateLimit.enabled, false);
  if (allInterfaceBind && !rateLimitEnabled) {
    warnings.push({
      code: "all_interface_bind_without_rate_limit",
      message: "host binds all interfaces while rate-limit.enabled is false",
    });
  }

  return { findings, warnings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig(args.config);
  const { findings, warnings } = checkConfig(config);

  console.log("ccpa security posture");
  console.log("read_only: true");
  console.log(`config: ${args.config}`);
  console.log(`findings: ${findings.length}`);
  console.log(`warnings: ${warnings.length}`);

  for (const finding of findings) {
    console.log(`finding: ${finding.code} ${redact(finding.message)}`);
  }
  for (const warning of warnings) {
    console.log(`warning: ${warning.code} ${redact(warning.message)}`);
  }

  console.log(`security_posture: ${findings.length === 0 ? "yes" : "no"}`);
  process.exit(findings.length === 0 ? 0 : 1);
}

main();
