import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const PREFLIGHT_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-rollout-preflight.mjs");

function runPreflight(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PREFLIGHT_SCRIPT, ...args],
      { timeout: 30_000, env: { ...process.env, ...env } },
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

function writeBasicFiles(tmpDir: string): {
  config: string;
  dist: string;
  repoHealthcheck: string;
  logMaintenance: string;
  contract: string;
} {
  const config = path.join(tmpDir, "config.yaml");
  const dist = path.join(tmpDir, "dist", "index.js");
  const repoHealthcheck = path.join(tmpDir, "ccpa-healthcheck.sh");
  const logMaintenance = path.join(tmpDir, "ccpa-log-maintenance.sh");
  const contract = path.join(tmpDir, "fake-contract.mjs");

  fs.mkdirSync(path.dirname(dist), { recursive: true });
  fs.writeFileSync(config, "api-keys:\n  - sk-secret1234567890\n");
  fs.writeFileSync(dist, "// dist marker\n");
  fs.writeFileSync(repoHealthcheck, "#!/usr/bin/env bash\n# ccpa-canary.mjs\n# CCPA_HEALTHCHECK_MAINTAIN_LOGS\n");
  fs.writeFileSync(logMaintenance, "#!/usr/bin/env bash\n");
  fs.writeFileSync(contract, "console.log('contract: ok');\nprocess.exit(0);\n");

  return { config, dist, repoHealthcheck, logMaintenance, contract };
}

test("ccpa rollout preflight documents read-only behavior and rollout controls", async () => {
  assert.equal(fs.existsSync(PREFLIGHT_SCRIPT), true);

  const result = await runPreflight(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /read-only/i);
  assert.match(result.stdout, /ccpa-canary\.mjs/);
  assert.match(result.stdout, /ccpa-contract-check\.mjs/);
  assert.match(result.stdout, /--external-healthcheck/);
  assert.match(result.stdout, /launchctl kickstart/);
});

test("ccpa rollout preflight reports stale live canary without leaking API keys", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-preflight-stale-"));
  const { config, dist, repoHealthcheck, logMaintenance, contract } = writeBasicFiles(tmpDir);
  const canary = path.join(tmpDir, "fake-canary.mjs");
  const externalHealthcheck = path.join(tmpDir, "external-healthcheck.sh");

  fs.writeFileSync(
    canary,
    [
      "console.log('checking sk-secret1234567890');",
      "console.error('health missing runtime identity for private.user@example.com');",
      "process.exit(1);",
      "",
    ].join("\n")
  );
  fs.writeFileSync(externalHealthcheck, "#!/usr/bin/env bash\ncurl /v1/chat/completions -H 'Authorization: Bearer sk-secret1234567890'\n");

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runPreflight([
    "--url",
    "http://127.0.0.1:8317",
    "--config",
    config,
    "--dist",
    dist,
    "--canary-script",
    canary,
    "--external-healthcheck",
    externalHealthcheck,
    "--repo-healthcheck",
    repoHealthcheck,
    "--log-maintenance",
    logMaintenance,
    "--contract-script",
    contract,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /read_only: true/);
  assert.match(result.stdout, /canary: failed/);
  assert.match(result.stdout, /contract: ok/);
  assert.match(result.stdout, /health missing runtime identity/);
  assert.match(result.stdout, /external healthcheck has hardcoded API-key-shaped text/);
  assert.match(result.stdout, /launchctl kickstart -k/);
  assert.doesNotMatch(result.stdout, /sk-secret1234567890/);
  assert.doesNotMatch(result.stdout, /private\.user@example\.com/);
  assert.doesNotMatch(result.stderr, /sk-secret1234567890/);
});

test("ccpa rollout preflight runs contract gate and redacts failures", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-preflight-contract-"));
  const { config, dist, repoHealthcheck, logMaintenance, contract } = writeBasicFiles(tmpDir);
  const canary = path.join(tmpDir, "fake-canary.mjs");
  const externalHealthcheck = path.join(tmpDir, "external-healthcheck.sh");

  fs.writeFileSync(canary, "console.log('health: ok');\nprocess.exit(0);\n");
  fs.writeFileSync(
    contract,
    [
      "console.log('GET /v1/models without auth failed for sk-secret1234567890');",
      "console.error('contract error for private.user@example.com');",
      "process.exit(1);",
      "",
    ].join("\n")
  );
  fs.writeFileSync(externalHealthcheck, '#!/usr/bin/env bash\nexec "/opt/homebrew/bin/npm" run healthcheck -- "$@"\n');

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runPreflight([
    "--url",
    "http://127.0.0.1:8317",
    "--config",
    config,
    "--dist",
    dist,
    "--canary-script",
    canary,
    "--contract-script",
    contract,
    "--external-healthcheck",
    externalHealthcheck,
    "--repo-healthcheck",
    repoHealthcheck,
    "--log-maintenance",
    logMaintenance,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /canary: ok/);
  assert.match(result.stdout, /contract: failed/);
  assert.match(result.stdout, /GET \/v1\/models without auth failed/);
  assert.match(result.stdout, /ready: no/);
  assert.doesNotMatch(result.stdout, /sk-secret1234567890/);
  assert.doesNotMatch(result.stdout, /private\.user@example\.com/);
  assert.doesNotMatch(result.stderr, /sk-secret1234567890/);
});

test("ccpa rollout preflight passes when local files and canary are ready", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-preflight-ready-"));
  const { config, dist, repoHealthcheck, logMaintenance, contract } = writeBasicFiles(tmpDir);
  const canary = path.join(tmpDir, "fake-canary.mjs");
  const externalHealthcheck = path.join(tmpDir, "external-healthcheck.sh");

  fs.writeFileSync(canary, "console.log('health: ok');\nprocess.exit(0);\n");
  fs.writeFileSync(externalHealthcheck, '#!/usr/bin/env bash\nexec "/opt/homebrew/bin/npm" run healthcheck -- "$@"\n');

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runPreflight([
    "--url",
    "http://127.0.0.1:8317",
    "--config",
    config,
    "--dist",
    dist,
    "--canary-script",
    canary,
    "--contract-script",
    contract,
    "--external-healthcheck",
    externalHealthcheck,
    "--repo-healthcheck",
    repoHealthcheck,
    "--log-maintenance",
    logMaintenance,
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /ready: yes/);
  assert.match(result.stdout, /canary: ok/);
  assert.match(result.stdout, /contract: ok/);
  assert.match(result.stdout, /external healthcheck: ok/);
  assert.doesNotMatch(result.stdout, /external healthcheck does not appear to use repository canary\/healthcheck/);
  assert.doesNotMatch(result.stdout, /sk-secret1234567890/);
});

test("ccpa rollout preflight defaults operator paths from the current user", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-preflight-user-defaults-"));
  const homeDir = path.join(tmpDir, "home");
  const { config, dist, repoHealthcheck, logMaintenance, contract } = writeBasicFiles(tmpDir);
  const canary = path.join(tmpDir, "fake-canary.mjs");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(canary, "console.log('health: ok');\nprocess.exit(0);\n");

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runPreflight(
    [
      "--url",
      "http://127.0.0.1:8317",
      "--config",
      config,
      "--dist",
      dist,
      "--canary-script",
      canary,
      "--contract-script",
      contract,
      "--repo-healthcheck",
      repoHealthcheck,
      "--log-maintenance",
      logMaintenance,
    ],
    {
      HOME: homeDir,
      USER: "wangyan",
      LOGNAME: "wangyan",
      CCPA_EXTERNAL_HEALTHCHECK: "",
      CCPA_LAUNCHD_LABEL: "",
    }
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`external healthcheck missing: ${escapeRegExp(path.join(homeDir, "ccpa-healthcheck.sh"))}`));
  assert.match(result.stdout, new RegExp(`launchctl kickstart -k gui/${process.getuid?.() ?? "\\$\\(id -u\\)"}/com\\.wangyan\\.ccpa`));
});
