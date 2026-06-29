import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const LOG_MAINTENANCE_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-log-maintenance.sh");

function runLogMaintenance(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [LOG_MAINTENANCE_SCRIPT, ...args],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          ...env,
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
}

test("ccpa log maintenance documents defaults and controls", async () => {
  assert.equal(fs.existsSync(LOG_MAINTENANCE_SCRIPT), true);

  const result = await runLogMaintenance(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\/tmp\/ccpa\.stdout\.log/);
  assert.match(result.stdout, /\/tmp\/ccpa\.stderr\.log/);
  assert.match(result.stdout, /CCPA_LOG_MAX_BYTES/);
  assert.match(result.stdout, /CCPA_LOG_KEEP/);
  assert.match(result.stdout, /CCPA_LOG_PATHS/);
});

test("ccpa log maintenance redacts account identifiers and API keys in current logs", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-log-redact-"));
  const logPath = path.join(tmpDir, "ccpa.stderr.log");

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    logPath,
    [
      "Token refresh failed for private.user@example.com",
      "upstream body included sk-secret1234567890",
      "",
    ].join("\n")
  );

  const result = await runLogMaintenance([], {
    CCPA_LOG_PATHS: logPath,
    CCPA_LOG_MAX_BYTES: "1000000",
    CCPA_LOG_KEEP: "2",
  });

  assert.equal(result.code, 0);
  const redacted = fs.readFileSync(logPath, "utf8");
  assert.doesNotMatch(redacted, /private\.user@example\.com/);
  assert.doesNotMatch(redacted, /sk-secret1234567890/);
  assert.match(redacted, /\[email:redacted\]/);
  assert.match(redacted, /\[api-key:redacted\]/);
  assert.equal(fs.existsSync(`${logPath}.1`), false);
});

test("ccpa log maintenance copy-truncates oversized logs with redacted rotations", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-log-rotate-"));
  const logPath = path.join(tmpDir, "ccpa.stdout.log");

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.writeFileSync(logPath, `fresh private.user@example.com sk-secret1234567890 ${"x".repeat(80)}`);
  fs.writeFileSync(`${logPath}.1`, "older first.private@example.com sk-older1234567890");

  const result = await runLogMaintenance([], {
    CCPA_LOG_PATHS: logPath,
    CCPA_LOG_MAX_BYTES: "40",
    CCPA_LOG_KEEP: "2",
  });

  assert.equal(result.code, 0);
  assert.equal(fs.readFileSync(logPath, "utf8"), "");

  const newestRotation = fs.readFileSync(`${logPath}.1`, "utf8");
  assert.match(newestRotation, /fresh/);
  assert.doesNotMatch(newestRotation, /private\.user@example\.com/);
  assert.doesNotMatch(newestRotation, /sk-secret1234567890/);
  assert.match(newestRotation, /\[email:redacted\]/);
  assert.match(newestRotation, /\[api-key:redacted\]/);

  const olderRotation = fs.readFileSync(`${logPath}.2`, "utf8");
  assert.match(olderRotation, /older/);
  assert.doesNotMatch(olderRotation, /first\.private@example\.com/);
  assert.doesNotMatch(olderRotation, /sk-older1234567890/);
});
