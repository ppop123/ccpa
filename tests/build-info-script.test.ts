import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const BUILD_INFO_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-write-build-info.mjs");

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BUILD_INFO_SCRIPT, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
        stdout,
        stderr,
      });
    });
  });
}

test("build info script writes git revision metadata", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-build-info-"));
  const outPath = path.join(tmpDir, "nested", "build-info.json");

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = await runScript(["--out", outPath]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`build_info: wrote ${outPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const body = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.match(body.git_commit, /^[0-9a-f]{7,40}$/);
  assert.equal(typeof body.git_branch, "string");
  assert.equal(typeof body.git_dirty, "boolean");
  assert.match(body.built_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("package build writes dist build metadata after TypeScript compile", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

  assert.match(packageJson.scripts.build, /tsc/);
  assert.match(packageJson.scripts.build, /ccpa-write-build-info\.mjs/);
  assert.match(packageJson.scripts.build, /dist\/build-info\.json/);
});
