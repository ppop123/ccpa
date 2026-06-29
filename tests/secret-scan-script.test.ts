import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

const SECRET_SCAN_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-secret-scan.mjs");

function runSecretScan(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SECRET_SCAN_SCRIPT, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
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

function writeFile(repoDir: string, relativePath: string, body: string): void {
  const filePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

function initGitRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
}

test("secret scan help documents read-only default release scope", async () => {
  const result = await runSecretScan(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /secret scan/i);
  assert.match(result.stdout, /read-only/i);
  assert.match(result.stdout, /default release-facing paths/i);
  assert.match(result.stdout, /--repo-dir/);
  assert.match(result.stdout, /--path/);
});

test("secret scan passes placeholders and redacted token examples", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-secret-scan-placeholders-"));
  const repoDir = path.join(tmpDir, "repo");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  writeFile(repoDir, "README.md", [
    "Authorization: Bearer $API_KEY",
    "Authorization: Bearer <your-api-key>",
    "Authorization: Bearer sk-[A-Za-z0-9][A-Za-z0-9_-]{6,}",
    "api-key: sk-replace-with-a-long-random-key",
    "api-key: sk-LOCAL-REDACTED",
    "",
  ].join("\n"));
  writeFile(repoDir, "docs/guide.md", JSON.stringify({
    access_token: "<redacted>",
    refresh_token: "<redacted>",
  }, null, 2));
  writeFile(repoDir, "src/index.ts", "export const ok = true;\n");

  const result = await runSecretScan(["--repo-dir", repoDir]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /ccpa secret scan/);
  assert.match(result.stdout, /read_only: true/);
  assert.match(result.stdout, /findings: 0/);
  assert.match(result.stdout, /secret_scan: yes/);
});

test("secret scan fails on real-looking OpenAI API keys and redacts output", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-secret-scan-key-"));
  const repoDir = path.join(tmpDir, "repo");
  const leakedKey = "sk-live_abcdefghijklmnopqrstuvwxyz1234567890";
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  writeFile(repoDir, "README.md", `api-key: ${leakedKey}\n`);

  const result = await runSecretScan(["--repo-dir", repoDir]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /finding: README\.md:1 probable_api_key/);
  assert.match(result.stdout, /\[api-key:redacted\]/);
  assert.match(result.stdout, /secret_scan: no/);
  assert.doesNotMatch(result.stdout, new RegExp(leakedKey));
});

test("secret scan fails on real-looking OAuth token JSON and redacts output", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-secret-scan-token-"));
  const repoDir = path.join(tmpDir, "repo");
  const leakedToken = "ya29.this-is-a-long-real-looking-token-value";
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  writeFile(repoDir, "docs/token.md", JSON.stringify({
    access_token: leakedToken,
    refresh_token: "<redacted>",
  }, null, 2));

  const result = await runSecretScan(["--repo-dir", repoDir]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /finding: docs\/token\.md:2 oauth_token/);
  assert.match(result.stdout, /\[token:redacted\]/);
  assert.doesNotMatch(result.stdout, new RegExp(leakedToken));
});

test("secret scan ignores tests directory by default", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-secret-scan-tests-"));
  const repoDir = path.join(tmpDir, "repo");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  initGitRepo(repoDir);
  writeFile(repoDir, "tests/smoke.test.ts", "const key = 'sk-live_abcdefghijklmnopqrstuvwxyz1234567890';\n");
  writeFile(repoDir, "secret-scan-script.test.ts", "const key = 'sk-live_abcdefghijklmnopqrstuvwxyz1234567890';\n");
  writeFile(repoDir, "README.md", "No release-facing secrets here.\n");

  const result = await runSecretScan(["--repo-dir", repoDir]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /secret_scan: yes/);
});

test("secret scan ignores local ccpa auth directory by default", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-secret-scan-auth-dir-"));
  const repoDir = path.join(tmpDir, "repo");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  initGitRepo(repoDir);
  writeFile(repoDir, ".ccpa/auth.json", JSON.stringify({
    access_token: "ya29.this-is-a-long-real-looking-token-value",
    refresh_token: "ya29.this-is-another-long-real-looking-token-value",
  }, null, 2));
  writeFile(repoDir, "README.md", "No release-facing secrets here.\n");

  const result = await runSecretScan(["--repo-dir", repoDir]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /secret_scan: yes/);
});

test("secret scan includes git candidate files outside default paths", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-secret-scan-git-candidates-"));
  const repoDir = path.join(tmpDir, "repo");
  const leakedKey = "sk-live_abcdefghijklmnopqrstuvwxyz1234567890";
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  initGitRepo(repoDir);
  writeFile(repoDir, "handoff.md", `api-key: ${leakedKey}\n`);

  const result = await runSecretScan(["--repo-dir", repoDir]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /finding: handoff\.md:1 probable_api_key/);
  assert.doesNotMatch(result.stdout, new RegExp(leakedKey));
});

test("secret scan can scan an explicit path outside the default scope", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-secret-scan-explicit-"));
  const repoDir = path.join(tmpDir, "repo");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  writeFile(repoDir, "tests/smoke.test.ts", "const key = 'sk-live_abcdefghijklmnopqrstuvwxyz1234567890';\n");

  const result = await runSecretScan(["--repo-dir", repoDir, "--path", "tests"]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /finding: tests\/smoke\.test\.ts:1 probable_api_key/);
});
