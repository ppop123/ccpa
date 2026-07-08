import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRunManager } from "../src/agents/manager";
import { defaultAgentsConfig } from "../src/config";

function writeFakeRunner(dir: string, script: string): string {
  const runnerPath = path.join(dir, "fake-runner.js");
  fs.writeFileSync(runnerPath, `#!/usr/bin/env node\n${script}`);
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

test("AgentRunManager runs a CLI agent in a temporary workspace and returns diff artifacts", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-manager-"));
  const fakeRunner = writeFakeRunner(
    tmpDir,
    [
      "const fs = require('fs');",
      "fs.appendFileSync('src/index.ts', '\\nexport const changed = true;\\n');",
      "console.log(JSON.stringify({ result: 'ok' }));",
    ].join("\n")
  );
  const config = defaultAgentsConfig();
  config.enabled = true;
  config["runs-dir"] = path.join(tmpDir, "runs");
  config.runners["claude-code"].command = fakeRunner;

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const manager = new AgentRunManager(config);
  const started = await manager.createRun({
    agent: "claude-code",
    mode: "workspace-write",
    prompt: "make a change",
    wait: true,
    files: [{ path: "src/index.ts", content: "export const value = 1;\n", encoding: "utf8" }],
  });
  const completed = await manager.waitForRun(started.id, 10_000);

  assert.equal(completed.status, "completed");
  assert.equal(completed.exit_code, 0);
  assert.match(completed.output_text || "", /"result":"ok"/);
  assert.deepEqual(completed.changed_files, ["src/index.ts"]);
  assert.match(completed.diff || "", /changed = true/);
  assert.ok(completed.artifacts_path);
  assert.equal(fs.existsSync(completed.artifacts_path), true);
});

test("AgentRunManager can cancel a running agent process", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-manager-cancel-"));
  const fakeRunner = writeFakeRunner(
    tmpDir,
    [
      "setInterval(() => {",
      "  process.stdout.write('still running\\n');",
      "}, 100);",
    ].join("\n")
  );
  const config = defaultAgentsConfig();
  config.enabled = true;
  config["runs-dir"] = path.join(tmpDir, "runs");
  config.runners["claude-code"].command = fakeRunner;

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const manager = new AgentRunManager(config);
  const started = await manager.createRun({
    agent: "claude-code",
    mode: "workspace-write",
    prompt: "wait",
    wait: false,
    files: [{ path: "input.txt", content: "hello\n", encoding: "utf8" }],
  });

  const canceled = await manager.cancelRun(started.id);
  const final = await manager.waitForRun(started.id, 10_000);

  assert.equal(canceled.status, "canceled");
  assert.equal(final.status, "canceled");
  assert.equal(final.failure_code, "agent_run_canceled");
});

test("AgentRunManager marks runs as timed_out when the CLI exceeds timeout_ms", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-manager-timeout-"));
  const fakeRunner = writeFakeRunner(
    tmpDir,
    [
      "setInterval(() => {",
      "  process.stdout.write('still running\\n');",
      "}, 100);",
    ].join("\n")
  );
  const config = defaultAgentsConfig();
  config.enabled = true;
  config["runs-dir"] = path.join(tmpDir, "runs");
  config["max-runtime-ms"] = 200;
  config.runners["claude-code"].command = fakeRunner;

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const manager = new AgentRunManager(config);
  const started = await manager.createRun({
    agent: "claude-code",
    mode: "workspace-write",
    prompt: "timeout",
    wait: true,
    timeout_ms: 200,
    files: [],
  });
  const final = await manager.waitForRun(started.id, 10_000);

  assert.equal(final.status, "timed_out");
  assert.equal(final.failure_code, "agent_run_timed_out");
});

test("AgentRunManager removes oldest run directories beyond keep-runs", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-manager-retain-"));
  const fakeRunner = writeFakeRunner(
    tmpDir,
    [
      "const fs = require('fs');",
      "fs.writeFileSync('done.txt', 'ok\\n');",
      "console.log('ok');",
    ].join("\n")
  );
  const config = defaultAgentsConfig();
  config.enabled = true;
  config["runs-dir"] = path.join(tmpDir, "runs");
  config["keep-runs"] = 1;
  config.runners["claude-code"].command = fakeRunner;

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const manager = new AgentRunManager(config);
  const first = await manager.createRun({ agent: "claude-code", prompt: "one", wait: true, files: [] });
  const firstDone = await manager.waitForRun(first.id, 10_000);
  const second = await manager.createRun({ agent: "claude-code", prompt: "two", wait: true, files: [] });
  const secondDone = await manager.waitForRun(second.id, 10_000);

  assert.equal(secondDone.status, "completed");
  assert.equal(fs.existsSync(firstDone.run_path), false);
  assert.equal(fs.existsSync(secondDone.run_path), true);
});
