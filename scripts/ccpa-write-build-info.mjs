#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function printUsage() {
  console.log(`Usage: node scripts/ccpa-write-build-info.mjs [--out dist/build-info.json] [--repo-dir DIR]

Writes build metadata consumed by /health. The output contains git commit,
branch, dirty status, and build timestamp. It never reads config.yaml or auth
files.`);
}

function parseArgs(argv) {
  const args = {
    out: path.join(process.cwd(), "dist", "build-info.json"),
    repoDir: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--out") args.out = next();
    else if (arg === "--repo-dir") args.repoDir = next();
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.out = path.resolve(args.out);
  args.repoDir = path.resolve(args.repoDir);
  return args;
}

function git(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function readBuildInfo(repoDir) {
  const status = git(repoDir, ["status", "--short"]);
  return {
    service: "auth2api",
    git_commit: git(repoDir, ["rev-parse", "HEAD"]),
    git_branch: git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git_dirty: status.length > 0,
    built_at: new Date().toISOString(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildInfo = readBuildInfo(args.repoDir);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(buildInfo, null, 2)}\n`, { mode: 0o644 });
  console.log(`build_info: wrote ${args.out}`);
  console.log(`git_commit: ${buildInfo.git_commit}`);
  console.log(`git_dirty: ${buildInfo.git_dirty}`);
}

main();
