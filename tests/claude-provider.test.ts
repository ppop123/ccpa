import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountManager } from "../src/accounts/manager";
import { Config } from "../src/config";
import { ClaudeProvider } from "../src/providers/claude";

function makeConfig(authDir: string, claudeModels?: string[]): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": ["test-key"],
    "body-limit": "200mb",
    cloaking: {
      mode: "never",
      "strict-mode": false,
      "sensitive-words": [],
      "cache-user-id": false,
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    codex: {
      enabled: true,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4"],
    },
    ...(claudeModels ? { claude: { models: claudeModels } } : {}),
    debug: "off",
  } as Config;
}

function makeProvider(config: Config): ClaudeProvider {
  return new ClaudeProvider(config, new AccountManager(config["auth-dir"]));
}

test("ClaudeProvider keeps the default Claude model list when config omits claude.models", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-provider-"));
  const provider = makeProvider(makeConfig(authDir));

  try {
    assert.equal(provider.supportsModel("sonnet"), true);
    assert.equal(provider.supportsModel("claude-new-preview-20260622"), true);
    assert.equal(
      provider.listModels().some((model) => model.id === "claude-sonnet-4-6"),
      true
    );
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("ClaudeProvider lists and routes configured Claude aliases", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-provider-"));
  const provider = makeProvider(
    makeConfig(authDir, ["claude-custom-20260616", "my-sonnet-alias"])
  );

  try {
    assert.deepEqual(
      provider.listModels().map((model) => model.id),
      ["claude-custom-20260616", "my-sonnet-alias"]
    );
    assert.equal(provider.supportsModel("my-sonnet-alias"), true);
    assert.equal(provider.supportsModel("claude-sonnet-4-6"), false);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("ClaudeProvider preserves an explicit empty Claude model list", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-provider-empty-"));
  const provider = makeProvider(makeConfig(authDir, []));

  try {
    assert.deepEqual(provider.listModels(), []);
    assert.equal(provider.supportsModel("sonnet"), false);
    assert.equal(provider.supportsModel("claude-sonnet-4-6"), false);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
