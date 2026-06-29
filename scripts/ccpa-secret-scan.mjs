#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATHS = [
  "README.md",
  "README_CN.md",
  "config.example.yaml",
  "docs",
  "scripts",
  "src",
  "package.json",
  "tsconfig.json",
  ".gitignore",
];

const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const JSON_TOKEN_RE = /"(access_token|refresh_token)"\s*:\s*"([^"]+)"/gi;
const BEARER_RE = /Authorization:\s*Bearer\s+([^\s'"`<>]+)/gi;
const SK_PLACEHOLDER_RE = /^sk-(?:[A-Z0-9_-]*REDACTED|REMOTE-XXX|LOCAL-REDACTED|XXX|replace-with-|example|test|dummy)/i;

function printUsage() {
  console.log(`Usage: node scripts/ccpa-secret-scan.mjs [options]

Runs a read-only CCPA secret scan over default release-facing paths. The default
release-facing paths are combined with visible git candidate files and
intentionally exclude tests/, config.yaml, dist/, node_modules/, and local auth
directories so test fixtures and private runtime credentials do not block a
release handoff.

Checks:
  - real-looking OpenAI-style sk-* API keys
  - real-looking OAuth access_token / refresh_token JSON values
  - real-looking Authorization: Bearer values

Options:
  --repo-dir DIR       Repository directory, default cwd
  --path PATH          Scan an explicit file or directory, repeatable
  --help, -h           Show this help`);
}

function parseArgs(argv) {
  const args = {
    repoDir: process.cwd(),
    paths: [],
    explicitPaths: false,
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
    else if (arg === "--path") {
      args.paths.push(next());
      args.explicitPaths = true;
    }
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.repoDir = path.resolve(args.repoDir);
  if (args.paths.length === 0) {
    args.paths = DEFAULT_PATHS;
  }
  return args;
}

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join("/");
}

function isSkippedDirectory(name) {
  return (
    name === ".git" ||
    name === ".claude" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "coverage" ||
    name === ".turbo"
  );
}

function isSkippedCandidatePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const basename = path.posix.basename(normalized);
  return (
    normalized === "config.yaml" ||
    normalized === "config.yml" ||
    /\.(?:test|spec)\.(?:[cm]?[jt]s|tsx?)$/i.test(basename) ||
    normalized.startsWith("tests/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".git/") ||
    normalized.startsWith(".claude/") ||
    normalized.startsWith(".ccpa/") ||
    normalized.startsWith("coverage/")
  );
}

function parseStatusLine(line) {
  if (!line.trim() || line.length < 4) return null;
  const status = line.slice(0, 2);
  if (status.includes("D")) return null;
  const rawPath = line.slice(3).trim();
  if (!rawPath) return null;
  const renameArrow = " -> ";
  const filePath = rawPath.includes(renameArrow) ? rawPath.slice(rawPath.indexOf(renameArrow) + renameArrow.length) : rawPath;
  return filePath || null;
}

function discoverGitCandidatePaths(repoDir) {
  try {
    const stdout = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 10_000,
    });
    return stdout
      .split(/\r?\n/)
      .map(parseStatusLine)
      .filter(Boolean)
      .map(normalizeRelative)
      .filter((filePath) => !isSkippedCandidatePath(filePath));
  } catch {
    return [];
  }
}

function discoverFiles(repoDir, targetPaths) {
  const files = [];
  const seen = new Set();

  function addFile(filePath) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    files.push(resolved);
  }

  function walk(entryPath) {
    let stat;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      const base = path.basename(entryPath);
      if (isSkippedDirectory(base)) return;
      for (const name of fs.readdirSync(entryPath).sort()) {
        walk(path.join(entryPath, name));
      }
      return;
    }

    if (stat.isFile()) {
      addFile(entryPath);
    }
  }

  for (const targetPath of targetPaths) {
    const resolved = path.resolve(repoDir, targetPath);
    walk(resolved);
  }

  return files.sort();
}

function isProbablyText(buffer) {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function isAllowedSecretValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.length < 12) return true;
  if (/^[$<]/.test(trimmed)) return true;
  if (/redacted/i.test(trimmed)) return true;
  if (/[\[\]{}]/.test(trimmed)) return true;
  if (/^(?:test|dummy|example|placeholder|your[-_]api[-_]key)(?:[-_].*)?$/i.test(trimmed)) return true;
  if (SK_PLACEHOLDER_RE.test(trimmed)) return true;
  return false;
}

function redactLine(line) {
  return line
    .replace(SK_KEY_RE, (value) => (isAllowedSecretValue(value) ? value : "[api-key:redacted]"))
    .replace(JSON_TOKEN_RE, (_match, key, value) =>
      `"${key}": "${isAllowedSecretValue(value) ? value : "[token:redacted]"}"`
    )
    .replace(BEARER_RE, (_match, value) =>
      `Authorization: Bearer ${isAllowedSecretValue(value) ? value : "[token:redacted]"}`
    );
}

function scanLine(relativePath, lineNumber, line) {
  const findings = [];

  for (const match of line.matchAll(SK_KEY_RE)) {
    const value = match[0];
    if (!isAllowedSecretValue(value)) {
      findings.push({
        path: relativePath,
        line: lineNumber,
        code: "probable_api_key",
        snippet: redactLine(line.trim()),
      });
    }
  }

  for (const match of line.matchAll(JSON_TOKEN_RE)) {
    const value = match[2];
    if (!isAllowedSecretValue(value)) {
      findings.push({
        path: relativePath,
        line: lineNumber,
        code: "oauth_token",
        snippet: redactLine(line.trim()),
      });
    }
  }

  for (const match of line.matchAll(BEARER_RE)) {
    const value = match[1];
    if (!isAllowedSecretValue(value)) {
      findings.push({
        path: relativePath,
        line: lineNumber,
        code: "bearer_token",
        snippet: redactLine(line.trim()),
      });
    }
  }

  return findings;
}

function scanFile(repoDir, filePath) {
  const raw = fs.readFileSync(filePath);
  if (!isProbablyText(raw)) return [];

  const relativePath = normalizeRelative(path.relative(repoDir, filePath));
  const body = raw.toString("utf8");
  const findings = [];
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    findings.push(...scanLine(relativePath, index + 1, lines[index]));
  }
  return findings;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetPaths = args.explicitPaths
    ? args.paths
    : [...args.paths, ...discoverGitCandidatePaths(args.repoDir)];
  const files = discoverFiles(args.repoDir, targetPaths);
  const findings = [];

  for (const filePath of files) {
    findings.push(...scanFile(args.repoDir, filePath));
  }

  console.log("ccpa secret scan");
  console.log("read_only: true");
  console.log(`repo: ${args.repoDir}`);
  console.log(`paths_scanned: ${files.length}`);
  console.log(`findings: ${findings.length}`);

  for (const finding of findings) {
    console.log(`finding: ${finding.path}:${finding.line} ${finding.code} ${finding.snippet}`);
  }

  console.log(`secret_scan: ${findings.length === 0 ? "yes" : "no"}`);
  process.exit(findings.length === 0 ? 0 : 1);
}

main();
