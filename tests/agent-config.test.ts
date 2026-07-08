import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config";

test("loadConfig keeps Agent Runs disabled by default", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-config-default-"));
  const configPath = path.join(tmpDir, "config.yaml");

  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );

    const config = loadConfig(configPath);

    assert.equal(config.agents?.enabled, false);
    assert.equal(config.agents?.["max-concurrency"], 1);
    assert.equal(config.agents?.["max-files"], 200);
    assert.equal(config.agents?.runners["claude-code"].enabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
test("loadConfig normalizes Agent Runs limits and runner command overrides", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-config-enabled-"));
  const configPath = path.join(tmpDir, "config.yaml");

  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
        "agents:",
        "  enabled: \"true\"",
        "  runs-dir: ./tmp-agent-runs",
        "  max-concurrency: \"2\"",
        "  max-runtime-ms: \"120000\"",
        "  sync-wait-ms: 5000",
        "  max-files: 3",
        "  max-file-bytes: 1024",
        "  max-total-bytes: 2048",
        "  keep-runs: 7",
        "  runners:",
        "    claude-code:",
        "      enabled: true",
        "      command: /tmp/fake-claude",
        "    grok-cli:",
        "      enabled: false",
      ].join("\n")
    );

    const config = loadConfig(configPath);

    assert.equal(config.agents?.enabled, true);
    assert.equal(config.agents?.["runs-dir"], "./tmp-agent-runs");
    assert.equal(config.agents?.["max-concurrency"], 2);
    assert.equal(config.agents?.["max-runtime-ms"], 120000);
    assert.equal(config.agents?.["sync-wait-ms"], 5000);
    assert.equal(config.agents?.["max-files"], 3);
    assert.equal(config.agents?.["max-file-bytes"], 1024);
    assert.equal(config.agents?.["max-total-bytes"], 2048);
    assert.equal(config.agents?.["keep-runs"], 7);
    assert.equal(config.agents?.runners["claude-code"].command, "/tmp/fake-claude");
    assert.equal(config.agents?.runners["grok-cli"].enabled, false);
    assert.equal(config.agents?.runners["codex-cli"].enabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
