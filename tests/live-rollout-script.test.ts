import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const LIVE_ROLLOUT_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-live-rollout.mjs");

function runRollout(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LIVE_ROLLOUT_SCRIPT, ...args],
      {
        timeout: 30_000,
        env: { ...process.env, ...env },
      },
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeFakeRepo(tmpDir: string): { repoDir: string; logPath: string; npmBin: string; launchctlBin: string } {
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "calls.log");
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "scripts", "ccpa-healthcheck.sh"), "#!/usr/bin/env bash\n");

  const npmBin = path.join(binDir, "npm");
  const launchctlBin = path.join(binDir, "launchctl");
  writeExecutable(
    npmBin,
    [
      "#!/usr/bin/env bash",
      `printf 'npm:%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      "exit 0",
      "",
    ].join("\n")
  );
  writeExecutable(
    launchctlBin,
    [
      "#!/usr/bin/env bash",
      `printf 'launchctl:%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      "exit 0",
      "",
    ].join("\n")
  );

  return { repoDir, logPath, npmBin, launchctlBin };
}

test("ccpa live rollout documents dry-run default and explicit apply controls", async () => {
  assert.equal(fs.existsSync(LIVE_ROLLOUT_SCRIPT), true);

  const result = await runRollout(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /dry-run/i);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--install-external-healthcheck/);
  assert.match(result.stdout, /launchctl kickstart/);
  assert.match(result.stdout, /npm run contract:check/);
  assert.match(result.stdout, /--canary-retries/);
  assert.match(result.stdout, /--require-build-commit/);
});

test("ccpa live rollout dry-run does not execute commands or modify external healthcheck", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-live-rollout-dry-"));
  const { repoDir, logPath, npmBin, launchctlBin } = makeFakeRepo(tmpDir);
  const externalHealthcheck = path.join(tmpDir, "ccpa-healthcheck.sh");
  fs.writeFileSync(externalHealthcheck, "#!/usr/bin/env bash\necho old\n");

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runRollout([
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--launchctl-bin",
    launchctlBin,
    "--external-healthcheck",
    externalHealthcheck,
    "--install-external-healthcheck",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /mode: dry-run/);
  assert.match(result.stdout, /DRY-RUN npm run build/);
  assert.match(result.stdout, /DRY-RUN launchctl kickstart -k/);
  assert.match(result.stdout, /DRY-RUN npm run contract:check -- --url/);
  assert.equal(fs.existsSync(logPath), false);
  assert.match(fs.readFileSync(externalHealthcheck, "utf8"), /echo old/);
});

test("ccpa live rollout apply runs fake rollout commands without replacing external healthcheck by default", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-live-rollout-apply-"));
  const { repoDir, logPath, npmBin, launchctlBin } = makeFakeRepo(tmpDir);
  const externalHealthcheck = path.join(tmpDir, "ccpa-healthcheck.sh");
  fs.writeFileSync(externalHealthcheck, "#!/usr/bin/env bash\necho old\n");

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runRollout([
    "--apply",
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--launchctl-bin",
    launchctlBin,
    "--external-healthcheck",
    externalHealthcheck,
    "--url",
    "http://127.0.0.1:8317",
    "--launchd-label",
    "gui/503/com.wy.ccpa",
  ]);

  assert.equal(result.code, 0);
  const calls = fs.readFileSync(logPath, "utf8");
  assert.match(calls, /npm:run build/);
  assert.match(calls, /launchctl:kickstart -k gui\/503\/com\.wy\.ccpa/);
  assert.match(calls, /npm:run canary -- --url http:\/\/127\.0\.0\.1:8317/);
  assert.match(calls, /npm:run contract:check -- --url http:\/\/127\.0\.0\.1:8317/);
  assert.match(calls, /npm:run healthcheck -- --no-restart/);
  assert.match(fs.readFileSync(externalHealthcheck, "utf8"), /echo old/);
});

test("ccpa live rollout can require the post-rollout build commit", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-live-rollout-build-commit-"));
  const { repoDir, logPath, npmBin, launchctlBin } = makeFakeRepo(tmpDir);
  const externalHealthcheck = path.join(tmpDir, "ccpa-healthcheck.sh");
  fs.writeFileSync(externalHealthcheck, "#!/usr/bin/env bash\necho old\n");

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runRollout([
    "--apply",
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--launchctl-bin",
    launchctlBin,
    "--external-healthcheck",
    externalHealthcheck,
    "--url",
    "http://127.0.0.1:8317",
    "--require-build-commit",
    "abc1234",
  ]);

  assert.equal(result.code, 0);
  assert.match(
    fs.readFileSync(logPath, "utf8"),
    /npm:run canary -- --url http:\/\/127\.0\.0\.1:8317 --require-build-commit abc1234/
  );
});

test("ccpa live rollout defaults launchd label and external healthcheck to current operator", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-live-rollout-operator-"));
  const { repoDir, npmBin, launchctlBin } = makeFakeRepo(tmpDir);
  const uid = typeof process.getuid === "function" ? process.getuid() : "$(id -u)";

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runRollout(
    [
      "--repo-dir",
      repoDir,
      "--npm-bin",
      npmBin,
      "--launchctl-bin",
      launchctlBin,
      "--install-external-healthcheck",
    ],
    {
      CCPA_EXTERNAL_HEALTHCHECK: "",
      CCPA_LAUNCHD_LABEL: "",
      HOME: "/Users/wangyan",
      LOGNAME: "wangyan",
      USER: "wangyan",
    }
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`DRY-RUN launchctl kickstart -k gui/${uid}/com\\.wangyan\\.ccpa`));
  assert.match(result.stdout, /DRY-RUN backup \/Users\/wangyan\/ccpa-healthcheck\.sh ->/);
  assert.match(result.stdout, /DRY-RUN write repository healthcheck wrapper to \/Users\/wangyan\/ccpa-healthcheck\.sh/);
});

test("ccpa live rollout retries post-kickstart canary before contract checks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-live-rollout-retry-"));
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "calls.log");
  const canaryCountPath = path.join(tmpDir, "canary-count");
  const externalHealthcheck = path.join(tmpDir, "ccpa-healthcheck.sh");
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(externalHealthcheck, "#!/usr/bin/env bash\necho old\n");

  const npmBin = path.join(binDir, "npm");
  const launchctlBin = path.join(binDir, "launchctl");
  writeExecutable(
    npmBin,
    [
      "#!/usr/bin/env bash",
      `printf 'npm:%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$*" = "run canary -- --url http://127.0.0.1:8317" ]; then',
      `  count="$(cat ${JSON.stringify(canaryCountPath)} 2>/dev/null || printf 0)"`,
      "  count=$((count + 1))",
      `  printf '%s' "$count" > ${JSON.stringify(canaryCountPath)}`,
      '  if [ "$count" -eq 1 ]; then',
      "    echo 'fetch failed' >&2",
      "    exit 1",
      "  fi",
      "fi",
      "exit 0",
      "",
    ].join("\n")
  );
  writeExecutable(
    launchctlBin,
    [
      "#!/usr/bin/env bash",
      `printf 'launchctl:%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      "exit 0",
      "",
    ].join("\n")
  );

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runRollout([
    "--apply",
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--launchctl-bin",
    launchctlBin,
    "--external-healthcheck",
    externalHealthcheck,
    "--canary-retries",
    "2",
    "--canary-retry-delay-ms",
    "1",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stderr, /retrying npm run canary -- --url http:\/\/127\.0\.0\.1:8317 after failed attempt 1\/2/);
  assert.equal(fs.readFileSync(canaryCountPath, "utf8"), "2");
  const calls = fs.readFileSync(logPath, "utf8");
  assert.match(calls, /npm:run contract:check -- --url http:\/\/127\.0\.0\.1:8317/);
});

test("ccpa live rollout apply can explicitly install a repository healthcheck wrapper", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-live-rollout-install-"));
  const { repoDir, npmBin, launchctlBin } = makeFakeRepo(tmpDir);
  const externalHealthcheck = path.join(tmpDir, "ccpa-healthcheck.sh");
  fs.writeFileSync(externalHealthcheck, "#!/usr/bin/env bash\necho old sk-secret1234567890\n");

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runRollout([
    "--apply",
    "--install-external-healthcheck",
    "--repo-dir",
    repoDir,
    "--npm-bin",
    npmBin,
    "--launchctl-bin",
    launchctlBin,
    "--external-healthcheck",
    externalHealthcheck,
  ]);

  assert.equal(result.code, 0);
  const replacement = fs.readFileSync(externalHealthcheck, "utf8");
  assert.match(replacement, /CCPA_HEALTHCHECK_MAINTAIN_LOGS/);
  assert.match(replacement, /run healthcheck/);
  assert.match(replacement, new RegExp(`export PATH="${escapeRegExp(path.dirname(npmBin))}:\\$\\{PATH:-\\}"`));
  assert.match(replacement, new RegExp(`exec ${escapeRegExp(JSON.stringify(npmBin))} run healthcheck -- "\\$@"`));
  assert.doesNotMatch(replacement, /sk-secret1234567890/);
  const backups = fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith("ccpa-healthcheck.sh.bak-pre-repo-healthcheck-"));
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(tmpDir, backups[0]), "utf8"), /echo old sk-secret1234567890/);
});
