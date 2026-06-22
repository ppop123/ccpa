#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function timestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    installExternalHealthcheck: false,
    repoDir: process.cwd(),
    npmBin: process.env.CCPA_NPM_BIN || "npm",
    launchctlBin: process.env.CCPA_LAUNCHCTL_BIN || "launchctl",
    url: process.env.CCPA_BASE_URL || "http://127.0.0.1:8317",
    launchdLabel: process.env.CCPA_LAUNCHD_LABEL || defaultLaunchdLabel(),
    externalHealthcheck: process.env.CCPA_EXTERNAL_HEALTHCHECK || defaultExternalHealthcheck(),
    requireBuildCommit: process.env.CCPA_CANARY_REQUIRE_BUILD_COMMIT || "",
    canaryRetries: Number(process.env.CCPA_LIVE_ROLLOUT_CANARY_RETRIES || 6),
    canaryRetryDelayMs: Number(process.env.CCPA_LIVE_ROLLOUT_CANARY_RETRY_DELAY_MS || 1000),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index++;
      return value;
    };

    if (arg === "--apply") args.apply = true;
    else if (arg === "--install-external-healthcheck") args.installExternalHealthcheck = true;
    else if (arg === "--repo-dir") args.repoDir = next();
    else if (arg === "--npm-bin") args.npmBin = next();
    else if (arg === "--launchctl-bin") args.launchctlBin = next();
    else if (arg === "--url") args.url = next();
    else if (arg === "--launchd-label") args.launchdLabel = next();
    else if (arg === "--external-healthcheck") args.externalHealthcheck = next();
    else if (arg === "--require-build-commit") args.requireBuildCommit = next();
    else if (arg === "--canary-retries") args.canaryRetries = Number(next());
    else if (arg === "--canary-retry-delay-ms") args.canaryRetryDelayMs = Number(next());
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.canaryRetries) || args.canaryRetries < 1) {
    throw new Error("--canary-retries must be a positive integer");
  }
  if (!Number.isFinite(args.canaryRetryDelayMs) || args.canaryRetryDelayMs < 0) {
    throw new Error("--canary-retry-delay-ms must be a non-negative number");
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/ccpa-live-rollout.mjs [--apply] [--install-external-healthcheck] [options]

Runs the local CCPA live rollout sequence. The default mode is dry-run: commands
are printed but not executed. Pass --apply to execute build, launchctl kickstart,
post-rollout canary, contract check, and no-restart healthcheck. Replacing the external
healthcheck is never implicit; it requires both --apply and
--install-external-healthcheck.

Options:
  --repo-dir DIR                    Repository directory, default cwd
  --npm-bin PATH                    npm binary or test double
  --launchctl-bin PATH              launchctl binary or test double
  --url URL                         CCPA base URL for post-rollout canary
  --launchd-label LABEL             launchctl kickstart label
  --external-healthcheck PATH       Existing external healthcheck path
  --require-build-commit COMMIT     Require post-rollout /health build.git_commit
  --canary-retries N                Post-kickstart canary attempts, default 6
  --canary-retry-delay-ms MS        Delay between canary attempts, default 1000

Dry-run prints commands such as:
  npm run build
  launchctl kickstart -k <label>
  npm run canary -- --url <url> [--require-build-commit <commit>]
  npm run contract:check -- --url <url>`);
}

function formatCommand(command, args) {
  return [path.basename(command), ...args].join(" ");
}

function run(command, args, options) {
  const rendered = formatCommand(command, args);
  if (!options.apply) {
    console.log(`DRY-RUN ${rendered}`);
    return Promise.resolve();
  }

  console.log(`RUN ${rendered}`);
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, env: options.env || process.env }, (error, stdout, stderr) => {
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
      if (error) reject(error);
      else resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetries(command, args, options, attempts, delayMs) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await run(command, args, options);
      return;
    } catch (err) {
      if (attempt >= attempts) {
        throw err;
      }
      console.error(`retrying ${formatCommand(command, args)} after failed attempt ${attempt}/${attempts}`);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}

function npmBinPathExport(npmBin) {
  const npmDir = path.dirname(npmBin);
  if (npmDir === "." || npmDir === "") {
    const resolvedDir = findExecutableDir(npmBin, process.env.PATH || "");
    return resolvedDir ? `export PATH=${JSON.stringify(`${resolvedDir}:\${PATH:-}`)}` : null;
  }
  return `export PATH=${JSON.stringify(`${npmDir}:\${PATH:-}`)}`;
}

function findExecutableDir(command, pathValue) {
  for (const dir of String(pathValue).split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return dir;
    } catch {
      // Keep scanning PATH.
    }
  }
  return "";
}

function writeExternalHealthcheckWrapper(args) {
  const backupPath = `${args.externalHealthcheck}.bak-pre-repo-healthcheck-${timestamp()}`;
  const defaultLogPaths = [
    "/tmp/ccpa.stdout.log",
    "/tmp/ccpa.stderr.log",
    "/tmp/ccpa-healthcheck.log",
    "${HOME:-}/ccpa/logs/launchd.stdout.log",
    "${HOME:-}/ccpa/logs/launchd.stderr.log",
  ].join(":");
  const wrapperLines = [
    "#!/usr/bin/env bash",
    "set -u",
    `cd ${JSON.stringify(args.repoDir)}`,
    'export CCPA_HEALTHCHECK_MAINTAIN_LOGS="${CCPA_HEALTHCHECK_MAINTAIN_LOGS:-true}"',
    `export CCPA_LOG_PATHS="\${CCPA_LOG_PATHS:-${defaultLogPaths}}"`,
  ];
  const pathExport = npmBinPathExport(args.npmBin);
  if (pathExport) {
    wrapperLines.push(pathExport);
  }
  wrapperLines.push(`exec ${JSON.stringify(args.npmBin)} run healthcheck -- "$@"`, "");
  const wrapper = wrapperLines.join("\n");

  if (!args.apply) {
    console.log(`DRY-RUN backup ${args.externalHealthcheck} -> ${backupPath}`);
    console.log(`DRY-RUN write repository healthcheck wrapper to ${args.externalHealthcheck}`);
    return;
  }

  if (fs.existsSync(args.externalHealthcheck)) {
    fs.copyFileSync(args.externalHealthcheck, backupPath);
  }
  fs.writeFileSync(args.externalHealthcheck, wrapper, { mode: 0o755 });
  fs.chmodSync(args.externalHealthcheck, 0o755);
  console.log(`installed external healthcheck wrapper: ${args.externalHealthcheck}`);
  if (fs.existsSync(backupPath)) {
    console.log(`backup: ${backupPath}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = { apply: args.apply, cwd: args.repoDir, env: process.env };

  console.log("ccpa live rollout");
  console.log(`mode: ${args.apply ? "apply" : "dry-run"}`);

  const canaryArgs = ["run", "canary", "--", "--url", args.url];
  if (args.requireBuildCommit) {
    canaryArgs.push("--require-build-commit", args.requireBuildCommit);
  }

  await run(args.npmBin, ["run", "build"], options);
  await run(args.launchctlBin, ["kickstart", "-k", args.launchdLabel], options);
  await runWithRetries(
    args.npmBin,
    canaryArgs,
    options,
    args.canaryRetries,
    args.canaryRetryDelayMs
  );
  await run(args.npmBin, ["run", "contract:check", "--", "--url", args.url], options);
  await run(
    args.npmBin,
    ["run", "healthcheck", "--", "--no-restart"],
    {
      ...options,
      env: { ...process.env, CCPA_HEALTHCHECK_MAINTAIN_LOGS: "true" },
    }
  );

  if (args.installExternalHealthcheck) {
    writeExternalHealthcheckWrapper(args);
  } else {
    console.log("external healthcheck install: skipped");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
