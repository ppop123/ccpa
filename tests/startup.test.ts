import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountManager } from "../src/accounts/manager";
import { Config, defaultAgentsConfig } from "../src/config";
import { canStartServer } from "../src/startup";
import { saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";
import { redactProxyUrlForLog } from "../src/logging/redact";
import { configureOutboundProxy } from "../src/outbound-proxy";

function makeConfig(authDir: string): Config {
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
    debug: "off",
    codex: {
      enabled: true,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4"],
    },
  };
}

function writeClaudeToken(authDir: string): void {
  const token: TokenData = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    email: "test@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  saveToken(authDir, token);
}

function writeCodexAuth(authDir: string): void {
  fs.writeFileSync(
    path.join(authDir, "codex-auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: "codex-access-token",
        refresh_token: "codex-refresh-token",
        account_id: "acct_codex",
      },
    })
  );
}

function loadManager(authDir: string): AccountManager {
  const manager = new AccountManager(authDir);
  manager.load();
  return manager;
}

function withHomeDir<T>(homeDir: string, fn: () => T): T {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    return fn();
  } finally {
    process.env.HOME = originalHome;
  }
}

test("allows startup when Claude is missing but Codex auth is available", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-home-"));

  try {
    writeCodexAuth(authDir);
    const manager = loadManager(authDir);

    assert.equal(withHomeDir(tmpHome, () => canStartServer(makeConfig(authDir), manager)), true);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("redacts proxy credentials in startup logs", () => {
  const redacted = redactProxyUrlForLog("http://proxy-user:proxy-pass@127.0.0.1:7890");

  assert.equal(redacted, "http://127.0.0.1:7890");
  assert.doesNotMatch(redacted, /proxy-user/);
  assert.doesNotMatch(redacted, /proxy-pass/);
});

test("startup proxy configuration falls back to LaunchAgent proxy env", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-proxy-plist-"));
  const plistPath = path.join(tmpDir, "com.wy.ccpa.plist");
  fs.writeFileSync(
    plistPath,
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>HTTPS_PROXY</key>",
      "    <string>http://proxy-user:proxy-pass@127.0.0.1:6152</string>",
      "    <key>NO_PROXY</key>",
      "    <string>localhost,127.0.0.1,::1,.local</string>",
      "  </dict>",
      "</dict>",
      "</plist>",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const logs: string[] = [];
  let dispatcherUrl = "";
  let dispatcherConfigured = false;
  const proxyUrl = configureOutboundProxy({
    env: { PATH: "/usr/bin" },
    launchAgentPlistPaths: [plistPath],
    createProxyAgent: (url) => {
      dispatcherUrl = url;
      return {} as any;
    },
    setDispatcher: () => {
      dispatcherConfigured = true;
    },
    log: (message) => {
      logs.push(message);
    },
  });

  assert.equal(proxyUrl, "http://proxy-user:proxy-pass@127.0.0.1:6152");
  assert.equal(dispatcherUrl, "http://proxy-user:proxy-pass@127.0.0.1:6152");
  assert.equal(dispatcherConfigured, true);
  assert.deepEqual(logs, ["Outbound HTTP proxy: http://127.0.0.1:6152"]);
});

test("rejects startup when neither Claude nor Codex auth is available", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-home-"));

  try {
    const manager = loadManager(authDir);

    assert.equal(withHomeDir(tmpHome, () => canStartServer(makeConfig(authDir), manager)), false);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("allows startup when Agent Runs is enabled without provider auth", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-agents-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-agents-home-"));

  try {
    const manager = loadManager(authDir);
    const config = makeConfig(authDir);
    config.codex.enabled = false;
    config.codex.models = [];
    config.agents = defaultAgentsConfig();
    config.agents.enabled = true;

    assert.equal(withHomeDir(tmpHome, () => canStartServer(config, manager)), true);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("allows startup when Claude auth is available even if Codex auth is missing", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-home-"));

  try {
    writeClaudeToken(authDir);
    const manager = loadManager(authDir);

    assert.equal(withHomeDir(tmpHome, () => canStartServer(makeConfig(authDir), manager)), true);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("rejects startup when Codex auth exists but no Codex models are configured", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-startup-home-"));

  try {
    writeCodexAuth(authDir);
    const manager = loadManager(authDir);
    const config = makeConfig(authDir);
    config.codex.models = [];

    assert.equal(withHomeDir(tmpHome, () => canStartServer(config, manager)), false);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
