import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const HEALTHCHECK_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-healthcheck.sh");

function runHealthcheck(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("bash", [HEALTHCHECK_SCRIPT, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
        stdout,
        stderr,
      });
    });
  });
}

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body);
  fs.chmodSync(filePath, 0o755);
}

test("ccpa healthcheck uses low-cost canary without hardcoded secrets or generation calls", () => {
  assert.equal(fs.existsSync(HEALTHCHECK_SCRIPT), true);
  const script = fs.readFileSync(HEALTHCHECK_SCRIPT, "utf8");

  assert.match(script, /ccpa-canary\.mjs/);
  assert.match(script, /ccpa-contract-check\.mjs/);
  assert.match(script, /require-provider-status/);
  assert.doesNotMatch(script, /sk-[A-Za-z0-9_-]{20,}/);
});

test("ccpa healthcheck documents restart controls in help output", async () => {
  const result = await runHealthcheck(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /CCPA_HEALTHCHECK_RESTART/);
  assert.match(result.stdout, /CCPA_LAUNCHD_LABEL/);
  assert.match(result.stdout, /CCPA_HEALTHCHECK_REQUIRE_PROVIDER_STATUS/);
  assert.match(result.stdout, /CCPA_HEALTHCHECK_MAINTAIN_LOGS/);
  assert.match(result.stdout, /CCPA_HEALTHCHECK_RUN_CONTRACT/);
  assert.match(result.stdout, /CCPA_CONTRACT_SCRIPT/);
  assert.match(result.stdout, /CCPA_LOG_MAINTENANCE_SCRIPT/);
});

test("ccpa healthcheck preserves launchctl failure exit status", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-healthcheck-"));
  const fakeCanary = path.join(tmpDir, "fake-canary");
  const fakeLaunchctl = path.join(tmpDir, "launchctl");
  const logPath = path.join(tmpDir, "healthcheck.log");

  writeExecutable(
    fakeCanary,
    [
      "#!/usr/bin/env bash",
      "echo canary failed",
      "exit 1",
      "",
    ].join("\n")
  );
  writeExecutable(
    fakeLaunchctl,
    [
      "#!/usr/bin/env bash",
      "echo launch failed >&2",
      "exit 42",
      "",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bash",
      [HEALTHCHECK_SCRIPT, "--restart"],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${tmpDir}:${process.env.PATH || ""}`,
          CCPA_NODE_BIN: fakeCanary,
          CCPA_CANARY_SCRIPT: path.join(tmpDir, "unused-canary.mjs"),
          CCPA_HEALTHCHECK_LOG: logPath,
          CCPA_HEALTHCHECK_RESTART_SLEEP_SECONDS: "0",
        },
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
          stdout,
          stderr,
        });
      }
    );
  });

  assert.equal(result.code, 42);
  assert.match(fs.readFileSync(logPath, "utf8"), /restart failed: exit=42/);
});

test("ccpa healthcheck preserves canary failure exit status when restart is disabled", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-healthcheck-no-restart-"));
  const fakeCanary = path.join(tmpDir, "fake-canary");
  const logPath = path.join(tmpDir, "healthcheck.log");

  writeExecutable(
    fakeCanary,
    [
      "#!/usr/bin/env bash",
      "echo canary failed",
      "exit 17",
      "",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bash",
      [HEALTHCHECK_SCRIPT, "--no-restart"],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          CCPA_NODE_BIN: fakeCanary,
          CCPA_CANARY_SCRIPT: path.join(tmpDir, "unused-canary.mjs"),
          CCPA_HEALTHCHECK_LOG: logPath,
        },
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
          stdout,
          stderr,
        });
      }
    );
  });

  assert.equal(result.code, 17);
  assert.match(fs.readFileSync(logPath, "utf8"), /FAIL: canary exit=17/);
  assert.match(fs.readFileSync(logPath, "utf8"), /restart disabled/);
});

test("ccpa healthcheck redacts account identifiers before writing logs", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-healthcheck-redact-"));
  const fakeCanary = path.join(tmpDir, "fake-canary");
  const logPath = path.join(tmpDir, "healthcheck.log");

  writeExecutable(
    fakeCanary,
    [
      "#!/usr/bin/env bash",
      "echo 'canary failed for private.user@example.com with sk-secret1234567890'",
      "exit 17",
      "",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bash",
      [HEALTHCHECK_SCRIPT, "--no-restart"],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          CCPA_NODE_BIN: fakeCanary,
          CCPA_CANARY_SCRIPT: path.join(tmpDir, "unused-canary.mjs"),
          CCPA_HEALTHCHECK_LOG: logPath,
        },
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
          stdout,
          stderr,
        });
      }
    );
  });

  assert.equal(result.code, 17);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /\[email:redacted\]/);
  assert.match(log, /\[api-key:redacted\]/);
  assert.doesNotMatch(log, /private\.user@example\.com/);
  assert.doesNotMatch(log, /sk-secret1234567890/);
});

test("ccpa healthcheck treats opt-in log maintenance as non-blocking", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-healthcheck-log-maintenance-"));
  const fakeCanary = path.join(tmpDir, "fake-canary");
  const fakeMaintenance = path.join(tmpDir, "fake-maintenance");
  const logPath = path.join(tmpDir, "healthcheck.log");

  writeExecutable(
    fakeCanary,
    [
      "#!/usr/bin/env bash",
      "echo canary ok",
      "exit 0",
      "",
    ].join("\n")
  );
  writeExecutable(
    fakeMaintenance,
    [
      "#!/usr/bin/env bash",
      "echo maintenance failed >&2",
      "exit 23",
      "",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bash",
      [HEALTHCHECK_SCRIPT, "--no-restart"],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          CCPA_NODE_BIN: fakeCanary,
          CCPA_CANARY_SCRIPT: path.join(tmpDir, "unused-canary.mjs"),
          CCPA_HEALTHCHECK_LOG: logPath,
          CCPA_HEALTHCHECK_MAINTAIN_LOGS: "true",
          CCPA_LOG_MAINTENANCE_SCRIPT: fakeMaintenance,
        },
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

  assert.equal(result.code, 0);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /log maintenance failed: exit=23/);
  assert.match(log, /OK: canary ok/);
});

test("ccpa healthcheck runs the no-upstream contract gate after canary", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-healthcheck-contract-"));
  const fakeNode = path.join(tmpDir, "fake-node");
  const logPath = path.join(tmpDir, "healthcheck.log");
  const canaryScript = path.join(tmpDir, "ccpa-canary.mjs");
  const contractScript = path.join(tmpDir, "ccpa-contract-check.mjs");

  fs.writeFileSync(canaryScript, "");
  fs.writeFileSync(contractScript, "");
  writeExecutable(
    fakeNode,
    [
      "#!/usr/bin/env bash",
      "case \"$1\" in",
      "  *ccpa-canary.mjs) echo canary ok; exit 0 ;;",
      "  *ccpa-contract-check.mjs) echo contract failed; exit 23 ;;",
      "  *) echo unexpected script \"$1\" >&2; exit 99 ;;",
      "esac",
      "",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bash",
      [HEALTHCHECK_SCRIPT, "--no-restart"],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          CCPA_NODE_BIN: fakeNode,
          CCPA_CANARY_SCRIPT: canaryScript,
          CCPA_CONTRACT_SCRIPT: contractScript,
          CCPA_HEALTHCHECK_LOG: logPath,
        },
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

  assert.equal(result.code, 23);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /FAIL: contract exit=23/);
  assert.match(log, /contract failed/);
  assert.match(log, /restart disabled/);
});

test("ccpa healthcheck can disable the contract gate explicitly", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-healthcheck-no-contract-"));
  const fakeNode = path.join(tmpDir, "fake-node");
  const logPath = path.join(tmpDir, "healthcheck.log");
  const canaryScript = path.join(tmpDir, "ccpa-canary.mjs");
  const contractScript = path.join(tmpDir, "ccpa-contract-check.mjs");

  fs.writeFileSync(canaryScript, "");
  fs.writeFileSync(contractScript, "");
  writeExecutable(
    fakeNode,
    [
      "#!/usr/bin/env bash",
      "case \"$1\" in",
      "  *ccpa-canary.mjs) echo canary ok; exit 0 ;;",
      "  *ccpa-contract-check.mjs) echo contract should not run; exit 23 ;;",
      "  *) echo unexpected script \"$1\" >&2; exit 99 ;;",
      "esac",
      "",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bash",
      [HEALTHCHECK_SCRIPT, "--no-restart"],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          CCPA_NODE_BIN: fakeNode,
          CCPA_CANARY_SCRIPT: canaryScript,
          CCPA_CONTRACT_SCRIPT: contractScript,
          CCPA_HEALTHCHECK_LOG: logPath,
          CCPA_HEALTHCHECK_RUN_CONTRACT: "false",
        },
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

  assert.equal(result.code, 0);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /OK: canary ok/);
  assert.doesNotMatch(log, /contract should not run/);
});
