import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const SECURITY_POSTURE_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-security-posture.mjs");

function runPosture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SECURITY_POSTURE_SCRIPT, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
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

function writeConfig(tmpDir: string, body: string): string {
  const configPath = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(configPath, body);
  return configPath;
}

test("security posture help documents read-only config checks", async () => {
  const result = await runPosture(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /security posture/i);
  assert.match(result.stdout, /read-only/i);
  assert.match(result.stdout, /--config/);
});

test("security posture fails placeholder and weak API keys", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-security-posture-weak-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const configPath = writeConfig(
    tmpDir,
    [
      'host: "127.0.0.1"',
      "api-keys:",
      '  - "sk-replace-with-a-long-random-key"',
      '  - "short-key"',
      "rate-limit:",
      "  enabled: true",
      "",
    ].join("\n")
  );

  const result = await runPosture(["--config", configPath]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /finding: api_key_placeholder/);
  assert.match(result.stdout, /finding: api_key_too_short/);
  assert.match(result.stdout, /security_posture: no/);
  assert.doesNotMatch(result.stdout, /sk-replace-with-a-long-random-key/);
});

test("security posture rejects long test API key placeholders", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-security-posture-test-placeholder-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const configPath = writeConfig(
    tmpDir,
    [
      'host: "127.0.0.1"',
      "api-keys:",
      '  - "sk-test-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
      "rate-limit:",
      "  enabled: true",
      "",
    ].join("\n")
  );

  const result = await runPosture(["--config", configPath]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /finding: api_key_placeholder/);
  assert.match(result.stdout, /security_posture: no/);
});

test("security posture warns but does not fail for all-interface bind with rate limit disabled", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-security-posture-warn-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const configPath = writeConfig(
    tmpDir,
    [
      'host: "0.0.0.0"',
      "api-keys:",
      '  - "sk-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
      "rate-limit:",
      "  enabled: false",
      "",
    ].join("\n")
  );

  const result = await runPosture(["--config", configPath]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /warning: all_interface_bind_without_rate_limit/);
  assert.match(result.stdout, /findings: 0/);
  assert.match(result.stdout, /warnings: 1/);
  assert.match(result.stdout, /security_posture: yes/);
});

test("security posture normalizes quoted rate limit booleans like runtime config", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-security-posture-rate-limit-string-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const configPath = writeConfig(
    tmpDir,
    [
      'host: "0.0.0.0"',
      "api-keys:",
      '  - "sk-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
      "rate-limit:",
      '  enabled: "true"',
      "",
    ].join("\n")
  );

  const result = await runPosture(["--config", configPath]);

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /warning: all_interface_bind_without_rate_limit/);
  assert.match(result.stdout, /findings: 0/);
  assert.match(result.stdout, /warnings: 0/);
  assert.match(result.stdout, /security_posture: yes/);
});

test("security posture passes strong localhost config", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-security-posture-ok-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const configPath = writeConfig(
    tmpDir,
    [
      'host: "127.0.0.1"',
      "api-keys:",
      '  - "sk-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
      "rate-limit:",
      "  enabled: false",
      "",
    ].join("\n")
  );

  const result = await runPosture(["--config", configPath]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /findings: 0/);
  assert.match(result.stdout, /warnings: 0/);
  assert.match(result.stdout, /security_posture: yes/);
});
