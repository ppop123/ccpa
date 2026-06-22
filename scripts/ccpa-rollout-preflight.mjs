#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const API_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function redact(value) {
  return String(value).replace(API_KEY_RE, "[api-key:redacted]").replace(EMAIL_RE, "[email:redacted]");
}

function defaultLaunchdLabel() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "$(id -u)";
  const username =
    process.env.USER ||
    process.env.LOGNAME ||
    os.userInfo?.().username ||
    "wy";
  const safeUsername = String(username).replace(/[^A-Za-z0-9_.-]/g, "") || "wy";
  return `gui/${uid}/com.${safeUsername}.ccpa`;
}

function defaultExternalHealthcheck() {
  return path.join(process.env.HOME || os.homedir(), "ccpa-healthcheck.sh");
}

function parseArgs(argv) {
  const args = {
    url: process.env.CCPA_BASE_URL || "http://127.0.0.1:8317",
    config: process.env.CCPA_CONFIG || path.join(process.cwd(), "config.yaml"),
    dist: process.env.CCPA_DIST_PATH || path.join(process.cwd(), "dist", "index.js"),
    canaryScript: process.env.CCPA_CANARY_SCRIPT || path.join(process.cwd(), "scripts", "ccpa-canary.mjs"),
    contractScript: process.env.CCPA_CONTRACT_SCRIPT || path.join(process.cwd(), "scripts", "ccpa-contract-check.mjs"),
    repoHealthcheck: process.env.CCPA_REPO_HEALTHCHECK || path.join(process.cwd(), "scripts", "ccpa-healthcheck.sh"),
    logMaintenance: process.env.CCPA_LOG_MAINTENANCE_SCRIPT || path.join(process.cwd(), "scripts", "ccpa-log-maintenance.sh"),
    externalHealthcheck: process.env.CCPA_EXTERNAL_HEALTHCHECK || defaultExternalHealthcheck(),
    launchdLabel: process.env.CCPA_LAUNCHD_LABEL || defaultLaunchdLabel(),
    requireProviderStatus: process.env.CCPA_CANARY_REQUIRE_PROVIDER_STATUS || "degraded",
    requireBuildCommit: process.env.CCPA_CANARY_REQUIRE_BUILD_COMMIT || "",
    requireExternalHealthcheckDir: process.env.CCPA_REQUIRE_EXTERNAL_HEALTHCHECK_DIR || "",
    timeoutMs: Number(process.env.CCPA_CANARY_TIMEOUT_MS || 5000),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index++;
      return value;
    };

    if (arg === "--url") args.url = next();
    else if (arg === "--config") args.config = next();
    else if (arg === "--dist") args.dist = next();
    else if (arg === "--canary-script") args.canaryScript = next();
    else if (arg === "--contract-script") args.contractScript = next();
    else if (arg === "--repo-healthcheck") args.repoHealthcheck = next();
    else if (arg === "--log-maintenance") args.logMaintenance = next();
    else if (arg === "--external-healthcheck") args.externalHealthcheck = next();
    else if (arg === "--launchd-label") args.launchdLabel = next();
    else if (arg === "--require-provider-status") args.requireProviderStatus = next();
    else if (arg === "--require-build-commit") args.requireBuildCommit = next();
    else if (arg === "--require-external-healthcheck-dir") args.requireExternalHealthcheckDir = next();
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

function printUsage() {
  console.log(`Usage: node scripts/ccpa-rollout-preflight.mjs [options]

Runs a read-only CCPA rollout preflight. It checks local rollout assets and runs
the low-cost ccpa-canary.mjs and ccpa-contract-check.mjs gates. It prints the
manual rollout commands that would be needed next. It does not run launchctl kickstart,
replace healthcheck files, edit plist files, or clean live logs.

Options:
  --url URL                         Live CCPA base URL
  --config config.yaml              Config used by ccpa-canary.mjs
  --dist dist/index.js              Local dist marker used by canary freshness
  --canary-script path              scripts/ccpa-canary.mjs path
  --contract-script path            scripts/ccpa-contract-check.mjs path
  --repo-healthcheck path           Repository ccpa-healthcheck.sh path
  --log-maintenance path            Repository ccpa-log-maintenance.sh path
  --external-healthcheck path       Existing external healthcheck path
  --launchd-label label             launchctl label to print in next steps
  --require-provider-status value   any|degraded|ok for the canary
  --require-build-commit commit     Require /health build.git_commit in canary
  --require-external-healthcheck-dir dir
                                    Require external healthcheck cd target
  --timeout-ms ms                   Canary timeout

Environment mirrors the script options with CCPA_* variables where possible.`);
}

function fileStatus(filePath, label) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, message: `${label}: missing ${filePath}` };
  }
  return { ok: true, message: `${label}: ok ${filePath}` };
}

function stripShellQuotes(value) {
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function extractCdTargets(body) {
  const targets = [];
  const cdRe = /(?:^|\n)\s*cd\s+(?:--\s+)?("[^"\n]*"|'[^'\n]*'|[^#;&\s]+)/g;
  let match;
  while ((match = cdRe.exec(body)) !== null) {
    targets.push(stripShellQuotes(match[1]));
  }
  return targets;
}

function inspectExternalHealthcheck(filePath, requiredDir = "") {
  const required = requiredDir ? path.resolve(requiredDir) : "";
  if (!fs.existsSync(filePath)) {
    const message = `external healthcheck missing: ${filePath}`;
    return required ? { warnings: [], failures: [message] } : { warnings: [message], failures: [] };
  }

  const warnings = [];
  const failures = [];
  const body = fs.readFileSync(filePath, "utf8");
  API_KEY_RE.lastIndex = 0;
  if (API_KEY_RE.test(body)) {
    warnings.push("external healthcheck has hardcoded API-key-shaped text");
  }
  const runsRepoHealthcheck =
    /ccpa-healthcheck\.sh|ccpa-canary\.mjs/.test(body) ||
    /(?:^|\s)(?:"[^"\n]*\/npm"|'[^'\n]*\/npm'|npm)\s+run\s+healthcheck/.test(body);
  if (!runsRepoHealthcheck) {
    warnings.push("external healthcheck does not appear to use repository canary/healthcheck");
  }
  if (required) {
    const cdTargets = extractCdTargets(body);
    const normalizedTargets = cdTargets.map((target) =>
      path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(filePath), target)
    );
    if (normalizedTargets.length === 0) {
      failures.push(`external healthcheck does not cd into required dir: ${required}`);
    } else if (normalizedTargets[normalizedTargets.length - 1] !== required) {
      failures.push(
        `external healthcheck cd target mismatch: expected ${required}, found ${normalizedTargets[normalizedTargets.length - 1]}`
      );
    }
  }
  return { warnings, failures };
}

function runCanary(args) {
  const canaryArgs = [
    args.canaryScript,
    "--url",
    args.url,
    "--config",
    args.config,
    "--dist",
    args.dist,
    "--require-provider-status",
    args.requireProviderStatus,
    "--timeout-ms",
    String(args.timeoutMs),
  ];
  if (args.requireBuildCommit) {
    canaryArgs.push("--require-build-commit", args.requireBuildCommit);
  }

  return new Promise((resolve) => {
    execFile(process.execPath, canaryArgs, { timeout: args.timeoutMs + 5000 }, (error, stdout, stderr) => {
      resolve({
        code:
          typeof error?.code === "number"
            ? Number(error.code)
            : error
              ? 1
              : 0,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}

function runContractCheck(args) {
  const contractArgs = [
    args.contractScript,
    "--url",
    args.url,
    "--config",
    args.config,
    "--timeout-ms",
    String(args.timeoutMs),
  ];

  return new Promise((resolve) => {
    execFile(process.execPath, contractArgs, { timeout: args.timeoutMs + 5000 }, (error, stdout, stderr) => {
      resolve({
        code:
          typeof error?.code === "number"
            ? Number(error.code)
            : error
              ? 1
              : 0,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}

function printNextSteps(args) {
  console.log("next_steps:");
  console.log("  - npm run build");
  console.log(`  - launchctl kickstart -k ${args.launchdLabel}`);
  const buildCommitArg = args.requireBuildCommit ? ` --require-build-commit ${args.requireBuildCommit}` : "";
  console.log(`  - npm run canary -- --url ${args.url}${buildCommitArg}`);
  console.log(`  - npm run contract:check -- --url ${args.url}`);
  console.log("  - CCPA_HEALTHCHECK_MAINTAIN_LOGS=true npm run healthcheck -- --no-restart");
  console.log(`  - review external healthcheck: ${args.externalHealthcheck}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const failures = [];

  console.log("ccpa rollout preflight");
  console.log("read_only: true");
  console.log(`url: ${args.url}`);

  for (const [filePath, label] of [
    [args.config, "config"],
    [args.dist, "dist"],
    [args.canaryScript, "canary script"],
    [args.contractScript, "contract script"],
    [args.repoHealthcheck, "repo healthcheck"],
    [args.logMaintenance, "log maintenance"],
  ]) {
    const status = fileStatus(filePath, label);
    console.log(status.message);
    if (!status.ok) failures.push(status.message);
  }

  const externalHealthcheck = inspectExternalHealthcheck(
    args.externalHealthcheck,
    args.requireExternalHealthcheckDir
  );
  if (externalHealthcheck.warnings.length === 0 && externalHealthcheck.failures.length === 0) {
    console.log(`external healthcheck: ok ${args.externalHealthcheck}`);
  } else {
    for (const warning of externalHealthcheck.warnings) {
      console.log(`warning: ${redact(warning)}`);
    }
    for (const failure of externalHealthcheck.failures) {
      console.log(`error: ${redact(failure)}`);
      failures.push(failure);
    }
  }

  const canary = await runCanary(args);
  if (canary.code === 0) {
    console.log("canary: ok");
    if (canary.stdout.trim()) console.log(redact(canary.stdout.trim()));
  } else {
    console.log("canary: failed");
    if (canary.stdout.trim()) console.log(redact(canary.stdout.trim()));
    if (canary.stderr.trim()) console.log(redact(canary.stderr.trim()));
    failures.push(`canary failed with exit ${canary.code}`);
  }

  const contract = await runContractCheck(args);
  if (contract.code === 0) {
    console.log("contract: ok");
    if (contract.stdout.trim()) console.log(redact(contract.stdout.trim()));
  } else {
    console.log("contract: failed");
    if (contract.stdout.trim()) console.log(redact(contract.stdout.trim()));
    if (contract.stderr.trim()) console.log(redact(contract.stderr.trim()));
    failures.push(`contract failed with exit ${contract.code}`);
  }

  printNextSteps(args);
  console.log(`ready: ${failures.length === 0 ? "yes" : "no"}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(redact(err.message || err));
  process.exit(2);
});
