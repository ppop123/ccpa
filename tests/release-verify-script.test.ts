import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const RELEASE_VERIFY_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-release-verify.mjs");

function runVerify(
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RELEASE_VERIFY_SCRIPT, ...args],
      { timeout: 60_000, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout, stderr) => {
        resolve({
          code:
            typeof (error as NodeJS.ErrnoException | null)?.code === "number"
              ? Number((error as NodeJS.ErrnoException).code)
              : 0,
          stdout,
          stderr,
        });
      }
    );
  });
}

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body);
  fs.chmodSync(filePath, 0o755);
}

function makeFakeTools(tmpDir: string, failingNeedle = ""): { repoDir: string; logPath: string; bins: string[] } {
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "calls.log");
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-canary.mjs"), "// canary\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-contract-check.mjs"), "// contract\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-future-check.mjs"), "// future check\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-live-rollout.mjs"), "// live rollout\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-release-readiness.mjs"), "// release readiness\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-release-verify.mjs"), "// release verify\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-rollout-preflight.mjs"), "// preflight\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-secret-scan.mjs"), "// secret scan\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-security-posture.mjs"), "// security posture\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-upstream-matrix.mjs"), "// upstream matrix\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-future-maintenance.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-healthcheck.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-log-maintenance.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(repoDir, "tests", "smoke.test.ts"), "// smoke\n");

  const toolBody = (name: string) =>
    [
      "#!/usr/bin/env bash",
      `needle=${JSON.stringify(failingNeedle)}`,
      `printf '${name}:%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ -n "$needle" ] && [[ "$*" == *"$needle"* ]]; then',
      `  echo '${name} saw private.user@example.com and sk-secret1234567890' >&2`,
      "  exit 9",
      "fi",
      `echo '${name} ok'`,
      "exit 0",
      "",
    ].join("\n");

  const npmBin = path.join(binDir, "npm");
  const gitBin = path.join(binDir, "git");
  const nodeBin = path.join(binDir, "node");
  const bashBin = path.join(binDir, "bash");
  writeExecutable(npmBin, toolBody("npm"));
  writeExecutable(gitBin, toolBody("git"));
  writeExecutable(nodeBin, toolBody("node"));
  writeExecutable(bashBin, toolBody("bash"));

  return { repoDir, logPath, bins: [npmBin, gitBin, nodeBin, bashBin] };
}

function makeEnvLoggingFakeTools(tmpDir: string): { repoDir: string; logPath: string; bins: string[] } {
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "calls.log");
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  for (const script of [
    "ccpa-canary.mjs",
    "ccpa-contract-check.mjs",
    "ccpa-release-readiness.mjs",
    "ccpa-release-verify.mjs",
    "ccpa-rollout-preflight.mjs",
    "ccpa-secret-scan.mjs",
    "ccpa-security-posture.mjs",
    "ccpa-upstream-matrix.mjs",
  ]) {
    fs.writeFileSync(path.join(repoDir, "scripts", script), "// script\n");
  }

  const toolBody = (name: string) =>
    [
      "#!/usr/bin/env bash",
      `printf '${name}:%s CCPA_BASE_URL=%s CCPA_CONFIG=%s CCPA_CANARY_CHECK_DIST=%s\\n' "$*" "\${CCPA_BASE_URL-}" "\${CCPA_CONFIG-}" "\${CCPA_CANARY_CHECK_DIST-}" >> ${JSON.stringify(logPath)}`,
      `echo '${name} ok'`,
      "exit 0",
      "",
    ].join("\n");

  const npmBin = path.join(binDir, "npm");
  const gitBin = path.join(binDir, "git");
  const nodeBin = path.join(binDir, "node");
  const bashBin = path.join(binDir, "bash");
  writeExecutable(npmBin, toolBody("npm"));
  writeExecutable(gitBin, toolBody("git"));
  writeExecutable(nodeBin, toolBody("node"));
  writeExecutable(bashBin, toolBody("bash"));

  return { repoDir, logPath, bins: [npmBin, gitBin, nodeBin, bashBin] };
}

test("release verify help documents read-only aggregate gates", async () => {
  const result = await runVerify(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /release verify/i);
  assert.match(result.stdout, /read-only/i);
  assert.match(result.stdout, /npm run release:readiness/);
  assert.match(result.stdout, /npm run secrets:scan/);
  assert.match(result.stdout, /npm run security:posture/);
  assert.match(result.stdout, /npm run security:audit/);
  assert.match(result.stdout, /npm run upstream:matrix/);
  assert.match(result.stdout, /npm run rollout:preflight/);
  assert.match(result.stdout, /npm run typecheck/);
  assert.match(result.stdout, /npm run test:unit/);
  assert.match(result.stdout, /npm run test:smoke/);
  assert.match(result.stdout, /npm run test:ops/);
  assert.match(result.stdout, /--require-build-commit/);
  assert.match(result.stdout, /git diff --check/);
  assert.match(result.stdout, /node --check for scripts\/ccpa-\*\.mjs/);
  assert.match(result.stdout, /bash -n for scripts\/ccpa-\*\.sh/);
});

test("release verify runs release gates in a safe deterministic order", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-release-verify-ok-"));
  const { repoDir, logPath, bins } = makeFakeTools(tmpDir);
  const [npmBin, gitBin, nodeBin, bashBin] = bins;

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runVerify([
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--git-bin",
    gitBin,
    "--node-bin",
    nodeBin,
    "--bash-bin",
    bashBin,
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /ccpa release verify/);
  assert.match(result.stdout, /read_only: true/);
  assert.match(result.stdout, /step release:readiness: ok/);
  assert.match(result.stdout, /step secrets:scan: ok/);
  assert.match(result.stdout, /step security:posture: ok/);
  assert.match(result.stdout, /step security:audit: ok/);
  assert.match(result.stdout, /step upstream:matrix: ok/);
  assert.match(result.stdout, /step rollout:preflight: ok/);
  assert.match(result.stdout, /step typecheck: ok/);
  assert.match(result.stdout, /step test:unit: ok/);
  assert.match(result.stdout, /step test:smoke: ok/);
  assert.match(result.stdout, /step test:ops: ok/);
  assert.match(result.stdout, /step diff-check: ok/);
  assert.match(result.stdout, /step script-syntax: ok/);
  assert.match(result.stdout, /release_verify: yes/);

  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    "npm:run release:readiness",
    "npm:run secrets:scan",
    "npm:run security:posture",
    "npm:run security:audit",
    "npm:run upstream:matrix",
    "npm:run rollout:preflight",
    "npm:run typecheck",
    "npm:run test:unit",
    "npm:run test:smoke",
    "npm:run test:ops",
    "git:diff --check",
    "node:--check scripts/ccpa-canary.mjs",
    "node:--check scripts/ccpa-contract-check.mjs",
    "node:--check scripts/ccpa-future-check.mjs",
    "node:--check scripts/ccpa-live-rollout.mjs",
    "node:--check scripts/ccpa-release-readiness.mjs",
    "node:--check scripts/ccpa-release-verify.mjs",
    "node:--check scripts/ccpa-rollout-preflight.mjs",
    "node:--check scripts/ccpa-secret-scan.mjs",
    "node:--check scripts/ccpa-security-posture.mjs",
    "node:--check scripts/ccpa-upstream-matrix.mjs",
    "bash:-n scripts/ccpa-future-maintenance.sh scripts/ccpa-healthcheck.sh scripts/ccpa-log-maintenance.sh",
  ]);
});

test("release verify can require strict provider readiness", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-release-verify-provider-status-"));
  const { repoDir, logPath, bins } = makeFakeTools(tmpDir);
  const [npmBin, gitBin, nodeBin, bashBin] = bins;

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runVerify([
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--git-bin",
    gitBin,
    "--node-bin",
    nodeBin,
    "--bash-bin",
    bashBin,
    "--require-provider-status",
    "ok",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /provider_status_required: ok/);
  assert.match(
    fs.readFileSync(logPath, "utf8"),
    /npm:run rollout:preflight -- --require-provider-status ok/
  );
});

test("release verify can require a runtime build commit", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-release-verify-build-commit-"));
  const { repoDir, logPath, bins } = makeFakeTools(tmpDir);
  const [npmBin, gitBin, nodeBin, bashBin] = bins;

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runVerify([
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--git-bin",
    gitBin,
    "--node-bin",
    nodeBin,
    "--bash-bin",
    bashBin,
    "--require-build-commit",
    "abc1234",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /build_commit_required: abc1234/);
  assert.match(
    fs.readFileSync(logPath, "utf8"),
    /npm:run rollout:preflight -- --require-build-commit abc1234/
  );
});

test("release verify keeps CCPA runtime env out of test steps", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-release-verify-env-"));
  const { repoDir, logPath, bins } = makeEnvLoggingFakeTools(tmpDir);
  const [npmBin, gitBin, nodeBin, bashBin] = bins;

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runVerify(
    [
      "--repo-dir",
      repoDir,
      "--npm-bin",
      npmBin,
      "--git-bin",
      gitBin,
      "--node-bin",
      nodeBin,
      "--bash-bin",
      bashBin,
    ],
    {
      CCPA_BASE_URL: "http://127.0.0.1:8318",
      CCPA_CONFIG: "/tmp/ccpa-candidate-config.yaml",
      CCPA_CANARY_CHECK_DIST: "false",
    }
  );

  assert.equal(result.code, 0);
  const calls = fs.readFileSync(logPath, "utf8");
  assert.match(
    calls,
    /npm:run rollout:preflight CCPA_BASE_URL=http:\/\/127\.0\.0\.1:8318 CCPA_CONFIG=\/tmp\/ccpa-candidate-config\.yaml CCPA_CANARY_CHECK_DIST=false/
  );
  for (const step of ["test:unit", "test:smoke", "test:ops"]) {
    assert.match(
      calls,
      new RegExp(`npm:run ${step} CCPA_BASE_URL= CCPA_CONFIG= CCPA_CANARY_CHECK_DIST=`)
    );
  }
});

test("release verify fails fast and redacts command output", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-release-verify-fail-"));
  const { repoDir, logPath, bins } = makeFakeTools(tmpDir, "run rollout:preflight");
  const [npmBin, gitBin, nodeBin, bashBin] = bins;

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runVerify([
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--git-bin",
    gitBin,
    "--node-bin",
    nodeBin,
    "--bash-bin",
    bashBin,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /step release:readiness: ok/);
  assert.match(result.stdout, /step rollout:preflight: failed \(exit 9\)/);
  assert.match(result.stdout, /\[email:redacted\]/);
  assert.match(result.stdout, /\[api-key:redacted\]/);
  assert.match(result.stdout, /release_verify: no/);
  assert.doesNotMatch(result.stdout, /private\.user@example\.com/);
  assert.doesNotMatch(result.stdout, /sk-secret1234567890/);
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    "npm:run release:readiness",
    "npm:run secrets:scan",
    "npm:run security:posture",
    "npm:run security:audit",
    "npm:run upstream:matrix",
    "npm:run rollout:preflight",
  ]);
});
