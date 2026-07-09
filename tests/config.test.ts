import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { loadConfig } from "../src/config";

test("config.example.yaml exposes current Grok model IDs", () => {
  const examplePath = path.join(process.cwd(), "config.example.yaml");
  const example = yaml.load(fs.readFileSync(examplePath, "utf-8")) as any;

  assert.ok(Array.isArray(example.grok?.models));
  assert.ok(example.grok.models.includes("grok-4.5"));
  assert.ok(example.grok.models.includes("grok-4.3"));
});

test("loadConfig uses ccpa auth dir for new default configs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-default-auth-dir-"));
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

    assert.equal(config["auth-dir"], "~/.ccpa");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes malformed api-keys before returning config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-api-keys-"));
  const configPath = path.join(tmpDir, "config.yaml");

  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - 123",
        "  - \"\"",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );

    const config = loadConfig(configPath);

    assert.equal(config["api-keys"].length, 1);
    assert.match(config["api-keys"][0], /^sk-[0-9a-f]{64}$/);
    assert.match(fs.readFileSync(configPath, "utf-8"), /sk-[0-9a-f]{64}/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes timeout values to positive integers", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-timeouts-"));
  const configPath = path.join(tmpDir, "config.yaml");

  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "timeouts:",
        "  messages-ms: \"45000\"",
        "  stream-messages-ms: -1",
        "  count-tokens-ms: abc",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );

    const config = loadConfig(configPath);

    assert.equal(config.timeouts["messages-ms"], 45000);
    assert.equal(config.timeouts["stream-messages-ms"], 600000);
    assert.equal(config.timeouts["count-tokens-ms"], 30000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes rate-limit values before returning config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-rate-limit-"));
  const enabledConfigPath = path.join(tmpDir, "enabled.yaml");
  const disabledConfigPath = path.join(tmpDir, "disabled.yaml");

  try {
    fs.writeFileSync(
      enabledConfigPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "rate-limit:",
        "  enabled: \"true\"",
        "  window-ms: \"2500\"",
        "  max-requests: \"7\"",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );
    fs.writeFileSync(
      disabledConfigPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "rate-limit:",
        "  enabled: \"false\"",
        "  window-ms: 0",
        "  max-requests: -1",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );

    const enabledConfig = loadConfig(enabledConfigPath);
    assert.equal(enabledConfig["rate-limit"]?.enabled, true);
    assert.equal(enabledConfig["rate-limit"]?.["window-ms"], 2500);
    assert.equal(enabledConfig["rate-limit"]?.["max-requests"], 7);

    const disabledConfig = loadConfig(disabledConfigPath);
    assert.equal(disabledConfig["rate-limit"]?.enabled, false);
    assert.equal(disabledConfig["rate-limit"]?.["window-ms"], 60000);
    assert.equal(disabledConfig["rate-limit"]?.["max-requests"], 60);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes provider model lists and codex booleans", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-provider-"));
  const configPath = path.join(tmpDir, "config.yaml");

  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "claude:",
        "  models:",
        "    - claude-sonnet-4-6",
        "    - 123",
        "    - \"\"",
        "codex:",
        "  enabled: \"false\"",
        "  store: \"true\"",
        "  auth-file: ~/.codex/auth.json",
        "  models:",
        "    - gpt-5.4",
        "    - 456",
        "    - \" \"",
        "    - gpt-5.5",
      ].join("\n")
    );

    const config = loadConfig(configPath);

    assert.deepEqual(config.claude?.models, ["claude-sonnet-4-6"]);
    assert.equal(config.codex.enabled, false);
    assert.equal(config.codex.store, true);
    assert.deepEqual(config.codex.models, ["gpt-5.4", "gpt-5.5"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes experimental Grok OAuth provider config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-grok-"));
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
        "grok:",
        "  enabled: \"true\"",
        "  auth-file: ~/.grok/auth.json",
        "  base-url: https://api.x.ai/v1/",
        "  models:",
        "    - grok-4.3",
        "    - 123",
        "    - \" \"",
        "    - grok-build-0.1",
      ].join("\n")
    );

    const config = loadConfig(configPath);

    assert.equal(config.grok?.enabled, true);
    assert.equal(config.grok?.["auth-file"], "~/.grok/auth.json");
    assert.equal(config.grok?.["base-url"], "https://api.x.ai/v1");
    assert.deepEqual(config.grok?.models, ["grok-4.3", "grok-build-0.1"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig keeps Grok OAuth disabled by default", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-grok-default-"));
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

    assert.equal(config.grok?.enabled, false);
    assert.equal(config.grok?.["auth-file"], "~/.grok/auth.json");
    assert.equal(config.grok?.["base-url"], "https://api.x.ai/v1");
    assert.deepEqual(config.grok?.models, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig preserves an explicit empty Claude model list", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-empty-claude-"));
  const configPath = path.join(tmpDir, "config.yaml");

  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "claude:",
        "  models: []",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );

    const config = loadConfig(configPath);

    assert.deepEqual(config.claude?.models, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes cloaking billing build hash", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-config-cloaking-"));
  const validConfigPath = path.join(tmpDir, "valid.yaml");
  const invalidConfigPath = path.join(tmpDir, "invalid.yaml");

  try {
    fs.writeFileSync(
      validConfigPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "cloaking:",
        "  billing-build-hash: abc",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );
    fs.writeFileSync(
      invalidConfigPath,
      [
        "api-keys:",
        "  - sk-test-key",
        "cloaking:",
        "  billing-build-hash: random",
        "codex:",
        "  enabled: false",
        "  auth-file: ~/.codex/auth.json",
        "  models: []",
      ].join("\n")
    );

    assert.equal(loadConfig(validConfigPath).cloaking["billing-build-hash"], "abc");
    assert.equal(loadConfig(invalidConfigPath).cloaking["billing-build-hash"], "000");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
