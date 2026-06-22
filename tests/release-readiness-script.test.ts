import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const RELEASE_READINESS_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-release-readiness.mjs");

function runReadiness(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [RELEASE_READINESS_SCRIPT, ...args], { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({
        code:
          typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? Number((error as NodeJS.ErrnoException).code)
            : 0,
        stdout,
        stderr,
      });
    });
  });
}

function writeStatus(tmpDir: string, body: string): string {
  const statusFile = path.join(tmpDir, "status.txt");
  fs.writeFileSync(statusFile, body);
  return statusFile;
}

test("release readiness help documents local hygiene checks", async () => {
  const result = await runReadiness(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /release readiness/i);
  assert.match(result.stdout, /transient artifacts/i);
  assert.match(result.stdout, /--status-file/);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /--list/);
  assert.match(result.stdout, /--write-json/);
});

test("release readiness fails when transient artifacts are visible in git status", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-readiness-transient-"));
  const statusFile = writeStatus(
    tmpDir,
    [
      " M src/server.ts",
      "?? .DS_Store",
      "?? .claude/worktrees/vigilant-fermi-838b54/",
      "?? src/providers/codex-chat.ts.bak-pre-merge-2026-06-09",
      "?? src/providers/codex-chat.ts.bak-toolsfix-2026-06-06",
      "?? scripts/ccpa-canary.mjs",
      "",
    ].join("\n")
  );

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runReadiness(["--status-file", statusFile]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /transient artifacts: 4 visible/);
  assert.match(result.stdout, /\.DS_Store/);
  assert.match(result.stdout, /\.claude\/worktrees\/vigilant-fermi-838b54\//);
  assert.match(result.stdout, /bak-pre-merge/);
  assert.match(result.stdout, /bak-toolsfix/);
  assert.match(result.stdout, /release_ready: no/);
});

test("release readiness passes with dirty candidate changes when no transient artifacts are visible", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-readiness-candidate-"));
  const statusFile = writeStatus(
    tmpDir,
    [
      " M src/server.ts",
      " M tests/smoke.test.ts",
      "?? scripts/ccpa-canary.mjs",
      "?? tests/canary-script.test.ts",
      "",
    ].join("\n")
  );

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runReadiness(["--status-file", statusFile]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /modified: 2/);
  assert.match(result.stdout, /untracked candidates: 2/);
  assert.match(result.stdout, /transient artifacts: 0 visible/);
  assert.match(result.stdout, /candidate buckets:/);
  assert.match(result.stdout, /runtime-source: 1/);
  assert.match(result.stdout, /scripts: 1/);
  assert.match(result.stdout, /tests: 2/);
  assert.match(result.stdout, /release_ready: yes/);
});

test("release readiness emits a JSON candidate manifest grouped by review bucket", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-readiness-json-"));
  const statusFile = writeStatus(
    tmpDir,
    [
      " M README.md",
      " M config.example.yaml",
      " M package.json",
      " M src/server.ts",
      " M tests/smoke.test.ts",
      "?? docs/plans/release.md",
      "?? scripts/ccpa-canary.mjs",
      "?? src/errors/openai.ts",
      "?? tests/canary-script.test.ts",
      "",
    ].join("\n")
  );

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runReadiness(["--status-file", statusFile, "--json"]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");

  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.readOnly, true);
  assert.equal(manifest.releaseReady, true);
  assert.match(manifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Number.isNaN(Date.parse(manifest.generatedAt)), false);
  assert.equal(manifest.repoDir, process.cwd());
  assert.deepEqual(manifest.statusSource, {
    type: "status-file",
    path: path.resolve(statusFile),
  });
  assert.deepEqual(manifest.handoff.reviewCommands, [
    "npm run release:readiness -- --list",
    "npm run release:verify",
    "npm run upstream:matrix",
  ]);
  assert.deepEqual(manifest.handoff.quotaSpendingCommands, [
    "npm run upstream:matrix -- --apply",
    "npm run upstream:matrix -- --apply --include-image",
  ]);
  assert.deepEqual(manifest.counts, {
    modified: 5,
    untrackedCandidates: 4,
    transientArtifacts: 0,
    candidateFiles: 9,
  });
  assert.deepEqual(manifest.buckets["runtime-source"].paths, ["src/server.ts", "src/errors/openai.ts"]);
  assert.deepEqual(manifest.buckets.tests.paths, ["tests/smoke.test.ts", "tests/canary-script.test.ts"]);
  assert.deepEqual(manifest.buckets.scripts.paths, ["scripts/ccpa-canary.mjs"]);
  assert.deepEqual(manifest.buckets.docs.paths, ["README.md", "docs/plans/release.md"]);
  assert.deepEqual(manifest.buckets["project-config"].paths, ["config.example.yaml", "package.json"]);
});

test("release readiness can list candidate paths under each review bucket", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-readiness-list-"));
  const statusFile = writeStatus(
    tmpDir,
    [
      " M src/server.ts",
      "?? scripts/ccpa-canary.mjs",
      "?? tests/canary-script.test.ts",
      "",
    ].join("\n")
  );

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runReadiness(["--status-file", statusFile, "--list"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /candidate buckets:/);
  assert.match(result.stdout, /runtime-source: 1/);
  assert.match(result.stdout, /    - src\/server\.ts/);
  assert.match(result.stdout, /scripts: 1/);
  assert.match(result.stdout, /    - scripts\/ccpa-canary\.mjs/);
  assert.match(result.stdout, /tests: 1/);
  assert.match(result.stdout, /    - tests\/canary-script\.test\.ts/);
});

test("release readiness can write a handoff JSON manifest to an explicit path", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-readiness-write-json-"));
  const statusFile = writeStatus(
    tmpDir,
    [
      " M src/server.ts",
      "?? scripts/ccpa-canary.mjs",
      "",
    ].join("\n")
  );
  const outputFile = path.join(tmpDir, "handoff", "release-readiness.json");

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runReadiness(["--status-file", statusFile, "--write-json", outputFile]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /manifest_written:/);
  assert.match(result.stdout, /release_ready: yes/);

  const manifest = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(manifest.releaseReady, true);
  assert.deepEqual(manifest.counts, {
    modified: 1,
    untrackedCandidates: 1,
    transientArtifacts: 0,
    candidateFiles: 2,
  });
  assert.deepEqual(manifest.buckets["runtime-source"].paths, ["src/server.ts"]);
  assert.deepEqual(manifest.buckets.scripts.paths, ["scripts/ccpa-canary.mjs"]);
});
