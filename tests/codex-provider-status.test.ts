import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { AccountManager } from "../src/accounts/manager";
import { Config } from "../src/config";
import { createServer } from "../src/server";
import { saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";
import { CodexProvider } from "../src/providers/codex";

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version;

function makeConfig(authDir: string, codexAuthFile: string): Config {
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
      "auth-file": codexAuthFile,
      models: ["gpt-5.4", "codex-mini-latest"],
    },
    debug: "off",
  };
}

function makeToken(overrides: Partial<TokenData> = {}): TokenData {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    email: "test@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function writeCodexAuth(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: "codex-access-token",
        refresh_token: "codex-refresh-token",
        account_id: "acct_codex",
      },
    })
  );
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

function makeManager(authDir: string, tokens: TokenData[]): AccountManager {
  for (const token of tokens) {
    saveToken(authDir, token);
  }
  const manager = new AccountManager(authDir);
  manager.load();
  return manager;
}

async function startApp(config: Config, manager: AccountManager): Promise<http.Server> {
  const app = createServer(config, manager);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function stopApp(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
}

async function requestJson(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: any }> {
  const address = serverAddress(options.server);
  const body = options.body === undefined ? "" : JSON.stringify(options.body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(options.headers || {}),
          ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: data ? JSON.parse(data) : null,
          });
        });
      }
    );

    req.on("error", reject);
    req.end(body);
  });
}

test("CodexProvider lists configured models", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const config = makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json"));
  const provider = new CodexProvider(config);

  assert.deepEqual(
    provider.listModels().map((model) => model.id),
    ["gpt-5.4", "codex-mini-latest"]
  );
});

test("CodexProvider reports unavailable when auth.json is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-home-"));

  try {
    const status = withHomeDir(tmpHome, () => {
      const config = makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json"));
      const provider = new CodexProvider(config);
      return provider.getStatus();
    });

    assert.equal(status.name, "codex");
    assert.equal(status.available, false);
    assert.equal(
      status.details?.hint,
      "Run `node dist/index.js --login-codex` or `codex login` to make Codex models available."
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("CodexProvider falls back to the default local Codex auth file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-home-"));

  try {
    const fallbackAuthFile = path.join(tmpHome, ".codex", "auth.json");
    writeCodexAuth(fallbackAuthFile);

    const status = withHomeDir(tmpHome, () => {
      const config = makeConfig(tmpDir, path.join(tmpDir, ".codex", "missing.json"));
      const provider = new CodexProvider(config);
      return provider.getStatus();
    });

    assert.equal(status.available, true);
    assert.equal(status.details?.path, fallbackAuthFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("CodexProvider supports only configured models when enabled", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const config = makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json"));
  const provider = new CodexProvider(config);

  assert.equal(provider.supportsModel("gpt-5.4"), true);
  assert.equal(provider.supportsModel("o3"), false);
});

test("CodexProvider rejects all models when disabled", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const config = {
    ...makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json")),
    codex: {
      enabled: false,
      "auth-file": path.join(tmpDir, ".codex", "auth.json"),
      models: ["gpt-5.4"],
    },
  };
  const provider = new CodexProvider(config);

  assert.equal(provider.supportsModel("gpt-5.4"), false);
  assert.deepEqual(provider.listModels(), []);
  assert.equal(provider.getStatus().available, false);
});

test("server exposes Claude and Codex models and provider status", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-server-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-home-"));
  const config = makeConfig(authDir, path.join(authDir, ".codex", "auth.json"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = withHomeDir(tmpHome, () => startApp(config, manager));

  t.after(async () => {
    await stopApp(await server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const modelsResp = await requestJson({
    server: await server,
    method: "GET",
    path: "/v1/models",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(modelsResp.status, 200);
  assert.ok(modelsResp.body.data.some((model: any) => model.id === "claude-sonnet-4-6"));
  assert.ok(modelsResp.body.data.some((model: any) => model.id === "gpt-5.4"));

  const adminResp = await requestJson({
    server: await server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.server.service, "auth2api");
  assert.equal(adminResp.body.server.version, PACKAGE_VERSION);
  assert.match(adminResp.body.server.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof adminResp.body.server.uptime_ms, "number");
  assert.equal(adminResp.body.server.provider_status, "degraded");
  assert.deepEqual(adminResp.body.server.providers, {
    total: 2,
    available: 1,
    unavailable: ["codex"],
  });
  assert.equal(adminResp.body.claude.name, "claude");
  assert.equal(adminResp.body.codex.name, "codex");
  assert.equal(adminResp.body.codex.available, false);
});

test("public health exposes runtime identity without provider details", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-health-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-health-home-"));
  const buildInfoPath = path.join(authDir, "build-info.json");
  fs.writeFileSync(
    buildInfoPath,
    JSON.stringify({
      git_commit: "abc1234",
      git_branch: "codex/test-build-info",
      git_dirty: false,
      built_at: "2026-06-22T00:00:00.000Z",
    })
  );
  const originalBuildInfoFile = process.env.CCPA_BUILD_INFO_FILE;
  process.env.CCPA_BUILD_INFO_FILE = buildInfoPath;
  const config = makeConfig(authDir, path.join(authDir, ".codex", "auth.json"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = withHomeDir(tmpHome, () => startApp(config, manager));

  t.after(async () => {
    await stopApp(await server);
    if (originalBuildInfoFile === undefined) {
      delete process.env.CCPA_BUILD_INFO_FILE;
    } else {
      process.env.CCPA_BUILD_INFO_FILE = originalBuildInfoFile;
    }
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const healthResp = await requestJson({
    server: await server,
    method: "GET",
    path: "/health",
  });

  assert.equal(healthResp.status, 200);
  assert.equal(healthResp.body.status, "ok");
  assert.equal(healthResp.body.service, "auth2api");
  assert.equal(healthResp.body.version, PACKAGE_VERSION);
  assert.match(healthResp.body.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof healthResp.body.uptime_ms, "number");
  assert.deepEqual(healthResp.body.build, {
    git_commit: "abc1234",
    git_branch: "codex/test-build-info",
    git_dirty: false,
    built_at: "2026-06-22T00:00:00.000Z",
  });
  assert.equal(healthResp.body.accounts, undefined);
  assert.equal(healthResp.body.claude, undefined);
  assert.equal(healthResp.body.codex, undefined);
});

test("server does not expose default Claude models when claude.models is explicit empty", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-server-empty-claude-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-home-empty-claude-"));
  const config = {
    ...makeConfig(authDir, path.join(authDir, ".codex", "auth.json")),
    claude: { models: [], "beta-header": "test-beta" },
  } satisfies Config;
  const manager = makeManager(authDir, [makeToken()]);
  const originalFetch = global.fetch;
  const upstreamCalls: string[] = [];
  global.fetch = (async (input) => {
    upstreamCalls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const server = withHomeDir(tmpHome, () => startApp(config, manager));

  t.after(async () => {
    global.fetch = originalFetch;
    await stopApp(await server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const modelsResp = await requestJson({
    server: await server,
    method: "GET",
    path: "/v1/models",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(modelsResp.status, 200);
  assert.equal(
    modelsResp.body.data.some((model: any) => model.owned_by === "anthropic"),
    false
  );
  assert.ok(modelsResp.body.data.some((model: any) => model.id === "gpt-5.4"));

  const chatResp = await requestJson({
    server: await server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4,
    },
  });

  assert.equal(chatResp.status, 400);
  assert.equal(chatResp.body.error.code, "unsupported_model");

  const messagesResp = await requestJson({
    server: await server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 4,
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(messagesResp.status, 400);
  assert.equal(messagesResp.body.error.code, "unsupported_model");

  const countResp = await requestJson({
    server: await server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(countResp.status, 400);
  assert.equal(countResp.body.error.code, "unsupported_model");
  assert.deepEqual(upstreamCalls, []);
});

test("admin status shows login hints for unavailable providers", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-server-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-home-"));
  const fallbackAuthFile = path.join(tmpHome, ".codex", "auth.json");
  writeCodexAuth(fallbackAuthFile);

  const config = makeConfig(authDir, path.join(authDir, ".codex", "missing.json"));
  const manager = makeManager(authDir, []);
  const server = withHomeDir(tmpHome, () => startApp(config, manager));

  t.after(async () => {
    await stopApp(await server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const adminResp = await requestJson({
    server: await server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.claude.available, false);
  assert.equal(
    adminResp.body.claude.details.hint,
    "Run `node dist/index.js --login` to make Claude models available."
  );
  assert.equal(adminResp.body.codex.available, true);
  assert.equal(adminResp.body.codex.details.path, fallbackAuthFile);
});
