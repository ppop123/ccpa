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

const CLAUDE_URL = "https://api.anthropic.com/v1/messages?beta=true";
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

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

function makeToken(overrides: Partial<TokenData> = {}): TokenData {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    email: "test@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeManager(authDir: string, tokens: TokenData[]): AccountManager {
  for (const token of tokens) {
    saveToken(authDir, token);
  }
  const manager = new AccountManager(authDir);
  manager.load();
  return manager;
}

function writeCodexAuth(authDir: string): void {
  fs.writeFileSync(
    path.join(authDir, "codex-auth.json"),
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
}): Promise<{ status: number; body: any; rawBody: string; headers: http.IncomingHttpHeaders }> {
  const address = serverAddress(options.server);
  const payload = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload).toString() } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let body: any = null;
          if (data) {
            try {
              body = JSON.parse(data);
            } catch {
              body = null;
            }
          }
          resolve({
            status: res.statusCode || 0,
            body,
            rawBody: data,
            headers: res.headers,
          });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function withMockedFetch(
  mock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): () => void {
  const originalFetch = global.fetch;
  global.fetch = mock as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

test("browser monitor page is directly openable and does not embed API keys", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-monitor-page-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-monitor-page-home-"));
  writeCodexAuth(authDir);

  const config = makeConfig(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const server = await withHomeDir(tmpHome, () => startApp(config, manager));

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const pageResp = await requestJson({
    server,
    method: "GET",
    path: "/monitor",
  });

  assert.equal(pageResp.status, 200);
  assert.match(String(pageResp.headers["content-type"] || ""), /text\/html/i);
  assert.match(pageResp.rawBody, /ccpa Monitor/i);
  assert.match(pageResp.rawBody, /\/admin\/accounts/);
  assert.match(pageResp.rawBody, /\/admin\/usage/);
  assert.match(pageResp.rawBody, /\/admin\/usage\/recent/);
  assert.match(pageResp.rawBody, /<input[^>]+type="password"/i);
  assert.equal(pageResp.rawBody.includes(config["api-keys"][0]), false);
});

test("admin usage endpoints expose provider, endpoint, and model aggregates", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-admin-usage-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-admin-usage-home-"));
  writeCodexAuth(authDir);

  const config = makeConfig(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);

    if (url === CLAUDE_URL) {
      return new Response(
        JSON.stringify({
          id: "msg_1",
          content: [{ type: "text", text: "claude ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url === CODEX_URL) {
      return new Response(
        JSON.stringify({
          id: "resp_codex",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "codex ok" }],
            },
          ],
          usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}; method=${init?.method}`);
  });

  const server = await withHomeDir(tmpHome, () => startApp(config, manager));

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const headers = { Authorization: "Bearer test-key" };

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers,
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi claude" }],
      stream: false,
    },
  });

  assert.equal(claudeResp.status, 200);

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers,
    body: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hi codex" }],
      stream: false,
    },
  });

  assert.equal(codexResp.status, 200);

  const usageResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage",
    headers,
  });

  assert.equal(usageResp.status, 200);
  assert.equal(usageResp.body.totals.totalRequests, 2);
  assert.equal(usageResp.body.providers.claude.totalRequests, 1);
  assert.equal(usageResp.body.providers.codex.totalRequests, 1);
  assert.equal(usageResp.body.models["claude-sonnet-4-6"].totalRequests, 1);
  assert.equal(usageResp.body.models["gpt-5.4"].totalRequests, 1);
  assert.equal(usageResp.body.endpoints["POST /v1/chat/completions"].totalRequests, 1);
  assert.equal(usageResp.body.endpoints["POST /v1/responses"].totalRequests, 1);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers,
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items.length, 2);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].provider, "codex");
  assert.equal(recentResp.body.items[0].model, "gpt-5.4");
  assert.equal(recentResp.body.items[1].provider, "claude");
});

test("admin usage tracks failed requests and recent limit", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-admin-usage-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-admin-usage-home-"));
  writeCodexAuth(authDir);

  const config = makeConfig(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);

    if (url === CLAUDE_URL) {
      return new Response(
        JSON.stringify({
          id: "msg_1",
          content: [{ type: "text", text: "claude ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  const server = await withHomeDir(tmpHome, () => startApp(config, manager));

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const headers = { Authorization: "Bearer test-key" };

  const failedResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers,
    body: {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "unsupported" }],
      stream: false,
    },
  });

  assert.equal(failedResp.status, 400);

  const successResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers,
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });

  assert.equal(successResp.status, 200);

  const usageResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage",
    headers,
  });

  assert.equal(usageResp.status, 200);
  assert.equal(usageResp.body.totals.totalRequests, 2);
  assert.equal(usageResp.body.totals.failureCount, 1);
  assert.equal(usageResp.body.totals.successCount, 1);
  assert.equal(usageResp.body.models["gpt-4.1"].failureCount, 1);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent?limit=1",
    headers,
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items.length, 1);
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(typeof recentResp.body.items[0].latencyMs, "number");
});
