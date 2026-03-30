import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, resolveAuthDir } from "../src/config";
import { CodexAuthStore } from "../src/providers/codex-auth";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test("loadConfig provides default codex config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-config-"));
  const configPath = path.join(tmpDir, "config.yaml");

  const config = loadConfig(configPath);

  assert.equal(config.codex.enabled, true);
  assert.equal(config.codex["auth-file"], "~/.codex/auth.json");
  assert.deepEqual(config.codex.models, []);
});

test("CodexAuthStore reads token data from auth.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-auth-"));
  const authDir = path.join(tmpDir, ".codex");
  const authFile = path.join(authDir, "auth.json");
  writeJson(authFile, {
    auth_mode: "oauth",
    tokens: {
      access_token: "codex-access-token",
      refresh_token: "codex-refresh-token",
      account_id: "acct_123",
    },
    last_refresh: "2026-03-30T00:00:00.000Z",
  });

  const store = new CodexAuthStore(authFile);
  const snapshot = store.load();

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.accessToken, "codex-access-token");
  assert.equal(snapshot.refreshToken, "codex-refresh-token");
  assert.equal(snapshot.accountId, "acct_123");
  assert.equal(snapshot.authMode, "oauth");
});

test("CodexAuthStore rejects auth.json without access token", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-auth-missing-"));
  const authFile = path.join(tmpDir, "auth.json");
  writeJson(authFile, {
    auth_mode: "oauth",
    tokens: {
      refresh_token: "codex-refresh-token",
      account_id: "acct_123",
    },
  });

  const store = new CodexAuthStore(authFile);

  assert.throws(() => store.load(), /access_token/i);
});

test("CodexAuthStore rejects missing auth.json with a controlled error", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-auth-absent-"));
  const authFile = path.join(tmpDir, "auth.json");
  const store = new CodexAuthStore(authFile);

  assert.throws(() => store.load(), /not found/i);
});

test("CodexAuthStore reloads when auth.json mtime changes", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-auth-reload-"));
  const authFile = path.join(tmpDir, "auth.json");
  writeJson(authFile, {
    auth_mode: "oauth",
    tokens: {
      access_token: "first-token",
      refresh_token: "first-refresh",
      account_id: "acct_123",
    },
  });

  const store = new CodexAuthStore(authFile);
  const first = store.load();
  assert.equal(first.accessToken, "first-token");

  await new Promise((resolve) => setTimeout(resolve, 20));
  writeJson(authFile, {
    auth_mode: "oauth",
    tokens: {
      access_token: "second-token",
      refresh_token: "second-refresh",
      account_id: "acct_123",
    },
  });

  const second = store.load();
  assert.equal(second.accessToken, "second-token");
  assert.equal(second.refreshToken, "second-refresh");
});

test("CodexAuthStore falls back to secondary auth file when primary is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-auth-fallback-"));
  const primaryAuthFile = path.join(tmpDir, "missing", "auth.json");
  const fallbackAuthFile = path.join(tmpDir, ".codex", "auth.json");
  writeJson(fallbackAuthFile, {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "fallback-access-token",
      refresh_token: "fallback-refresh-token",
      account_id: "acct_fallback",
    },
    last_refresh: "2026-03-30T00:00:00.000Z",
  });

  const store = new CodexAuthStore(primaryAuthFile, fallbackAuthFile);
  const snapshot = store.load();

  assert.equal(snapshot.accessToken, "fallback-access-token");
  assert.equal(snapshot.refreshToken, "fallback-refresh-token");
  assert.equal(snapshot.accountId, "acct_fallback");
  assert.equal(snapshot.authMode, "chatgpt");
  assert.equal(snapshot.path, fallbackAuthFile);
});

test("CodexAuthStore does not fall back when the primary auth file exists but is invalid", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-auth-invalid-primary-"));
  const primaryAuthFile = path.join(tmpDir, "primary", "auth.json");
  const fallbackAuthFile = path.join(tmpDir, ".codex", "auth.json");

  writeJson(primaryAuthFile, {
    auth_mode: "oauth",
    tokens: {
      refresh_token: "missing-access-token",
      account_id: "acct_primary",
    },
  });
  writeJson(fallbackAuthFile, {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "fallback-access-token",
      refresh_token: "fallback-refresh-token",
      account_id: "acct_fallback",
    },
  });

  const store = new CodexAuthStore(primaryAuthFile, fallbackAuthFile);

  assert.throws(() => store.load(), /access_token/i);
});

test("resolveAuthDir still resolves home-based paths", () => {
  const resolved = resolveAuthDir("~/.codex");
  assert.ok(resolved.includes(".codex"));
});
