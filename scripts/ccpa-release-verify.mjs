#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const API_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const PROVIDER_STATUS_VALUES = new Set(["any", "degraded", "ok"]);

function redact(value) {
  return String(value).replace(API_KEY_RE, "[api-key:redacted]").replace(EMAIL_RE, "[email:redacted]");
}

function printUsage() {
  console.log(`Usage: node scripts/ccpa-release-verify.mjs [options]

Runs the read-only CCPA release verify gate. It aggregates the release checks
that are easy to forget during handoff:
  - npm run release:readiness
  - npm run secrets:scan
  - npm run security:posture
  - npm run security:audit
  - npm run upstream:matrix
  - npm run rollout:preflight
  - npm run typecheck
  - npm run test:unit
  - npm run test:smoke
  - npm run test:ops
  - git diff --check
  - node --check for scripts/ccpa-*.mjs
  - bash -n for scripts/ccpa-*.sh

It fails fast on the first failing gate and redacts email/API-key-shaped output.
It does not build, stage, commit, launchctl kickstart, edit plist files, replace
healthcheck files, or call model-generation upstreams.

Options:
  --repo-dir DIR       Repository directory, default cwd
  --npm-bin PATH       npm binary, default npm
  --git-bin PATH       git binary, default git
  --node-bin PATH      node binary, default current Node
  --bash-bin PATH      bash binary, default bash
  --require-provider-status any|degraded|ok
                       Optional provider readiness requirement passed to
                       rollout:preflight. Use ok for full Claude+Codex checks.
  --require-build-commit COMMIT
                       Optional runtime build.git_commit requirement passed to
                       rollout:preflight/canary.
  --require-external-healthcheck-dir DIR
                       Optional external healthcheck wrapper cd target required
                       by rollout:preflight.
  --timeout-ms MS      Timeout per command, default 120000
  --help, -h           Show this help`);
}

function parseArgs(argv) {
  const args = {
    repoDir: process.cwd(),
    npmBin: "npm",
    gitBin: "git",
    nodeBin: process.execPath,
    bashBin: "bash",
    requireProviderStatus: process.env.CCPA_RELEASE_VERIFY_REQUIRE_PROVIDER_STATUS || "",
    requireBuildCommit:
      process.env.CCPA_RELEASE_VERIFY_REQUIRE_BUILD_COMMIT ||
      process.env.CCPA_CANARY_REQUIRE_BUILD_COMMIT ||
      "",
    requireExternalHealthcheckDir:
      process.env.CCPA_RELEASE_VERIFY_REQUIRE_EXTERNAL_HEALTHCHECK_DIR ||
      process.env.CCPA_REQUIRE_EXTERNAL_HEALTHCHECK_DIR ||
      "",
    timeoutMs: Number(process.env.CCPA_RELEASE_VERIFY_TIMEOUT_MS || 120000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--repo-dir") args.repoDir = next();
    else if (arg === "--npm-bin") args.npmBin = next();
    else if (arg === "--git-bin") args.gitBin = next();
    else if (arg === "--node-bin") args.nodeBin = next();
    else if (arg === "--bash-bin") args.bashBin = next();
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
  if (args.requireProviderStatus && !PROVIDER_STATUS_VALUES.has(args.requireProviderStatus)) {
    throw new Error("--require-provider-status must be one of: any, degraded, ok");
  }

  args.repoDir = path.resolve(args.repoDir);
  return args;
}

function runCommand(command, commandArgs, options, commandOptions = {}) {
  const env = commandOptions.sanitizeCcpaEnv ? sanitizeCcpaEnv(process.env) : process.env;
  return new Promise((resolve) => {
    execFile(
      command,
      commandArgs,
      {
        cwd: options.repoDir,
        timeout: options.timeoutMs,
        env,
      },
      (error, stdout, stderr) => {
        resolve({
          code:
            typeof error?.code === "number"
              ? Number(error.code)
              : error
                ? 1
                : 0,
          stdout: redact(stdout),
          stderr: redact(stderr),
          timedOut: Boolean(error?.killed),
        });
      }
    );
  });
}

function sanitizeCcpaEnv(env) {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith("CCPA_")) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function printCommandOutput(result) {
  const output = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  if (!output) return;
  for (const line of output.split(/\r?\n/)) {
    console.log(`  ${line}`);
  }
}

function discoverScripts(repoDir, extension) {
  const scriptsDir = path.join(repoDir, "scripts");
  if (!fs.existsSync(scriptsDir)) {
    return [];
  }
  return fs
    .readdirSync(scriptsDir)
    .filter((name) => name.startsWith("ccpa-") && name.endsWith(extension))
    .sort()
    .map((name) => `scripts/${name}`);
}

async function runStep(step, args) {
  for (const command of step.commands) {
    const result = await runCommand(command.bin, command.args, args, command);
    if (result.code !== 0) {
      console.log(`step ${step.name}: failed (exit ${result.code})`);
      printCommandOutput(result);
      if (result.timedOut) console.log(`  timed out after ${args.timeoutMs}ms`);
      return false;
    }
    if (command.showOutput) {
      printCommandOutput(result);
    }
  }

  console.log(`step ${step.name}: ok`);
  return true;
}

function buildSteps(args) {
  const nodeCheckScripts = discoverScripts(args.repoDir, ".mjs");
  const bashCheckScripts = discoverScripts(args.repoDir, ".sh");
  const preflightArgs = ["run", "rollout:preflight"];
  const preflightOptions = [];
  if (args.requireProviderStatus) {
    preflightOptions.push("--require-provider-status", args.requireProviderStatus);
  }
  if (args.requireBuildCommit) {
    preflightOptions.push("--require-build-commit", args.requireBuildCommit);
  }
  if (args.requireExternalHealthcheckDir) {
    preflightOptions.push("--require-external-healthcheck-dir", args.requireExternalHealthcheckDir);
  }
  if (preflightOptions.length > 0) {
    preflightArgs.push("--", ...preflightOptions);
  }
  const scriptSyntaxCommands = [
    ...nodeCheckScripts.map((scriptPath) => ({
      bin: args.nodeBin,
      args: ["--check", scriptPath],
      sanitizeCcpaEnv: true,
    })),
  ];
  if (bashCheckScripts.length > 0) {
    scriptSyntaxCommands.push({
      bin: args.bashBin,
      args: ["-n", ...bashCheckScripts],
      sanitizeCcpaEnv: true,
    });
  }

  return [
    {
      name: "release:readiness",
      commands: [{ bin: args.npmBin, args: ["run", "release:readiness"] }],
    },
    {
      name: "secrets:scan",
      commands: [{ bin: args.npmBin, args: ["run", "secrets:scan"] }],
    },
    {
      name: "security:posture",
      commands: [{ bin: args.npmBin, args: ["run", "security:posture"] }],
    },
    {
      name: "security:audit",
      commands: [{ bin: args.npmBin, args: ["run", "security:audit"] }],
    },
    {
      name: "upstream:matrix",
      commands: [{ bin: args.npmBin, args: ["run", "upstream:matrix"] }],
    },
    {
      name: "rollout:preflight",
      commands: [{ bin: args.npmBin, args: preflightArgs }],
    },
    {
      name: "typecheck",
      commands: [{ bin: args.npmBin, args: ["run", "typecheck"], sanitizeCcpaEnv: true }],
    },
    {
      name: "test:unit",
      commands: [{ bin: args.npmBin, args: ["run", "test:unit"], sanitizeCcpaEnv: true }],
    },
    {
      name: "test:smoke",
      commands: [{ bin: args.npmBin, args: ["run", "test:smoke"], sanitizeCcpaEnv: true }],
    },
    {
      name: "test:ops",
      commands: [{ bin: args.npmBin, args: ["run", "test:ops"], sanitizeCcpaEnv: true }],
    },
    {
      name: "diff-check",
      commands: [{ bin: args.gitBin, args: ["diff", "--check"], sanitizeCcpaEnv: true }],
    },
    {
      name: "script-syntax",
      commands: scriptSyntaxCommands,
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("ccpa release verify");
  console.log("read_only: true");
  console.log(`repo: ${args.repoDir}`);
  if (args.requireProviderStatus) {
    console.log(`provider_status_required: ${args.requireProviderStatus}`);
  }
  if (args.requireBuildCommit) {
    console.log(`build_commit_required: ${args.requireBuildCommit}`);
  }
  if (args.requireExternalHealthcheckDir) {
    console.log(`external_healthcheck_dir_required: ${args.requireExternalHealthcheckDir}`);
  }

  for (const step of buildSteps(args)) {
    const ok = await runStep(step, args);
    if (!ok) {
      console.log("release_verify: no");
      process.exit(1);
    }
  }

  console.log("release_verify: yes");
}

main().catch((err) => {
  console.error(redact(err.message || err));
  process.exit(2);
});
