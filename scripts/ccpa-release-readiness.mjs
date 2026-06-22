#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function printUsage() {
  console.log(`Usage: node scripts/ccpa-release-readiness.mjs [options]

Runs a local CCPA release readiness hygiene check. It is read-only by default:
it does not stage, delete, move, or modify candidate files. The check allows
dirty candidate changes, but fails when transient artifacts are still visible in
git status. With --write-json it writes only the requested manifest file.

Checks:
  - counts modified and untracked candidate files
  - groups candidate files by review bucket for release handoff
  - rejects visible transient artifacts such as .DS_Store, .claude worktrees,
    and *.bak-pre-* backup files

Options:
  --repo-dir DIR       Repository directory, default cwd
  --status-file PATH   Read a saved git status --short fixture instead of git
  --json              Print a machine-readable candidate manifest
  --write-json PATH    Write the machine-readable manifest to PATH
  --list              Include candidate paths in the text summary
  --help, -h           Show this help`);
}

function parseArgs(argv) {
  const args = {
    repoDir: process.cwd(),
    statusFile: "",
    json: false,
    writeJson: "",
    list: false,
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
    else if (arg === "--status-file") args.statusFile = next();
    else if (arg === "--json") args.json = true;
    else if (arg === "--write-json") args.writeJson = next();
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function runGitStatus(repoDir) {
  return new Promise((resolve, reject) => {
    execFile("git", ["status", "--short", "--untracked-files=all"], { cwd: repoDir }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function readStatus(args) {
  if (args.statusFile) {
    return fs.readFileSync(args.statusFile, "utf8");
  }
  return runGitStatus(args.repoDir);
}

function parseStatusLine(line) {
  if (!line.trim()) return null;
  const status = line.slice(0, 2);
  const filePath = line.slice(3).trim();
  if (!filePath) return null;
  return { status, filePath };
}

function isTransientArtifact(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return (
    normalized === ".DS_Store" ||
    normalized.endsWith("/.DS_Store") ||
    normalized.startsWith(".claude/") ||
    /\.bak-pre-[^/]+$/.test(normalized)
  );
}

const REVIEW_BUCKETS = [
  {
    name: "runtime-source",
    matches: (filePath) => filePath.startsWith("src/"),
  },
  {
    name: "tests",
    matches: (filePath) => filePath.startsWith("tests/"),
  },
  {
    name: "scripts",
    matches: (filePath) => filePath.startsWith("scripts/"),
  },
  {
    name: "docs",
    matches: (filePath) =>
      filePath.startsWith("docs/") ||
      /^README(?:_[A-Z]+)?\.md$/.test(filePath) ||
      /^CHANGELOG(?:\.[^.]+)?$/i.test(filePath),
  },
  {
    name: "project-config",
    matches: (filePath) =>
      filePath === ".gitignore" ||
      filePath === "config.example.yaml" ||
      filePath === "package.json" ||
      filePath === "package-lock.json" ||
      filePath === "tsconfig.json" ||
      filePath.startsWith(".github/"),
  },
  {
    name: "other",
    matches: () => true,
  },
];

function reviewBucketFor(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return REVIEW_BUCKETS.find((bucket) => bucket.matches(normalized)).name;
}

function summarizeBuckets(entries) {
  const buckets = Object.fromEntries(
    REVIEW_BUCKETS.map((bucket) => [
      bucket.name,
      {
        count: 0,
        modified: 0,
        untracked: 0,
        paths: [],
      },
    ])
  );

  for (const entry of entries) {
    const bucket = buckets[reviewBucketFor(entry.filePath)];
    bucket.count += 1;
    if (entry.status === "??") bucket.untracked += 1;
    else bucket.modified += 1;
    bucket.paths.push(entry.filePath);
  }

  return Object.fromEntries(Object.entries(buckets).filter(([, bucket]) => bucket.count > 0));
}

function classify(statusText) {
  const entries = statusText
    .split(/\r?\n/)
    .map(parseStatusLine)
    .filter(Boolean);
  const modified = entries.filter((entry) => entry.status !== "??");
  const untracked = entries.filter((entry) => entry.status === "??");
  const transient = entries.filter((entry) => isTransientArtifact(entry.filePath));
  const candidateEntries = entries.filter((entry) => !isTransientArtifact(entry.filePath));
  const untrackedCandidates = untracked.filter((entry) => !isTransientArtifact(entry.filePath));
  const buckets = summarizeBuckets(candidateEntries);
  return { entries, modified, untracked, untrackedCandidates, transient, candidateEntries, buckets };
}

function toManifest(summary, args) {
  return {
    readOnly: true,
    generatedAt: new Date().toISOString(),
    repoDir: path.resolve(args.repoDir),
    statusSource: args.statusFile
      ? {
          type: "status-file",
          path: path.resolve(args.statusFile),
        }
      : {
          type: "git",
          command: "git status --short --untracked-files=all",
        },
    handoff: {
      reviewCommands: [
        "npm run release:readiness -- --list",
        "npm run release:verify",
        "npm run upstream:matrix",
      ],
      quotaSpendingCommands: [
        "npm run upstream:matrix -- --apply",
        "npm run upstream:matrix -- --apply --include-image",
      ],
    },
    releaseReady: summary.transient.length === 0,
    counts: {
      modified: summary.modified.length,
      untrackedCandidates: summary.untrackedCandidates.length,
      transientArtifacts: summary.transient.length,
      candidateFiles: summary.candidateEntries.length,
    },
    buckets: summary.buckets,
    transientArtifacts: summary.transient.map((entry) => entry.filePath),
  };
}

function printBucketSummary(summary, listPaths) {
  console.log("candidate buckets:");
  for (const [name, bucket] of Object.entries(summary.buckets)) {
    console.log(`  - ${name}: ${bucket.count}`);
    if (listPaths) {
      for (const filePath of bucket.paths) {
        console.log(`    - ${filePath}`);
      }
    }
  }
}

function printSummary(summary, options = {}) {
  console.log("ccpa release readiness");
  console.log("read_only: true");
  console.log(`modified: ${summary.modified.length}`);
  console.log(`untracked candidates: ${summary.untrackedCandidates.length}`);
  console.log(`transient artifacts: ${summary.transient.length} visible`);
  printBucketSummary(summary, options.list);

  if (summary.transient.length > 0) {
    console.log("transient artifact paths:");
    for (const entry of summary.transient) {
      console.log(`  - ${entry.filePath}`);
    }
  }

  console.log(`release_ready: ${summary.transient.length === 0 ? "yes" : "no"}`);
  if (options.manifestPath) {
    console.log(`manifest_written: ${options.manifestPath}`);
  }
}

function writeManifest(manifest, outputPath) {
  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return resolvedOutputPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const statusText = await readStatus(args);
  const summary = classify(statusText);
  const manifest = toManifest(summary, args);
  const manifestPath = args.writeJson ? writeManifest(manifest, args.writeJson) : "";
  if (args.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    printSummary(summary, { list: args.list, manifestPath });
  }
  process.exit(summary.transient.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(2);
});
