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

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

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
      models: ["gpt-5.4", "o3", "codex-mini-latest", "gpt-image-2"],
    },
  };
}

function makeConfigWithRateLimit(
  authDir: string,
  rateLimit: { enabled: boolean; "window-ms": number; "max-requests": number }
): Config {
  return {
    ...makeConfig(authDir),
    "rate-limit": rateLimit,
  } as Config;
}

function makeConfigWithCodex(authDir: string, codex: Config["codex"]): Config {
  return {
    ...makeConfig(authDir),
    codex,
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

function writeCodexAuth(authDir: string, accessToken = "codex-access-token"): void {
  fs.writeFileSync(
    path.join(authDir, "codex-auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: accessToken,
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

async function requestJson(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
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
              body = data;
            }
          }
          resolve({
            status: res.statusCode || 0,
            body,
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

async function requestRawJson(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  rawBody: string;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const address = serverAddress(options.server);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(options.rawBody).toString(),
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
              body = data;
            }
          }
          resolve({
            status: res.statusCode || 0,
            body,
            headers: res.headers,
          });
        });
      }
    );

    req.on("error", reject);
    req.write(options.rawBody);
    req.end();
  });
}

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
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

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("accepts x-api-key auth and serves models/admin state", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const modelsResp = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(modelsResp.status, 200);
  assert.ok(Array.isArray(modelsResp.body.data));
  assert.ok(modelsResp.body.data.length > 0);
  assert.equal(modelsResp.body.data.some((model: { id: string }) => model.id === "claude-sonnet-4-6"), true);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.account_count, 1);
  assert.equal(adminResp.body.accounts[0].email, "test@example.com");
});

test("unimplemented /v1 endpoints return an OpenAI-style JSON 404", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/embeddings",
    headers: { Authorization: "Bearer test-key" },
    body: { model: "text-embedding-3-small", input: "hi" },
  });

  assert.equal(resp.status, 404);
  assert.match(String(resp.headers["content-type"] || ""), /application\/json/);
  assert.equal(resp.body.error.type, "invalid_request_error");
  assert.equal(resp.body.error.code, "endpoint_not_implemented");
});

test("unimplemented /admin endpoints return JSON after authentication", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-admin-404-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "GET",
    path: "/admin/not-real",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(resp.status, 404);
  assert.match(String(resp.headers["content-type"] || ""), /application\/json/);
  assert.equal(resp.body.error.message, "Endpoint not implemented: GET /admin/not-real");
  assert.equal(resp.body.error.type, "invalid_request_error");
  assert.equal(resp.body.error.code, "endpoint_not_implemented");
});

test("local /v1 authentication errors return OpenAI-style JSON", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-auth-errors-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const missing = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
  });

  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.message, "Missing API key");
  assert.equal(missing.body.error.type, "authentication_error");
  assert.equal(missing.body.error.code, "missing_api_key");

  const invalid = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { Authorization: "Bearer wrong-key" },
  });

  assert.equal(invalid.status, 403);
  assert.equal(invalid.body.error.message, "Invalid API key");
  assert.equal(invalid.body.error.type, "authentication_error");
  assert.equal(invalid.body.error.code, "invalid_api_key");
});

test("local /v1 authentication runs before JSON parsing", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-auth-before-json-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestRawJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    rawBody: "{\"model\":\"claude-sonnet-4-6\",",
  });

  assert.equal(resp.status, 401);
  assert.match(String(resp.headers["content-type"] || ""), /application\/json/);
  assert.equal(resp.body.error.message, "Missing API key");
  assert.equal(resp.body.error.type, "authentication_error");
  assert.equal(resp.body.error.code, "missing_api_key");
});

test("unauthenticated /v1 requests do not consume local rate limit quota", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-rate-limit-auth-first-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, []);
  const server = await startApp(
    makeConfigWithRateLimit(authDir, {
      enabled: true,
      "window-ms": 60_000,
      "max-requests": 2,
    }),
    manager
  );

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (let i = 0; i < 2; i++) {
    const missing = await requestJson({
      server,
      method: "GET",
      path: "/v1/models",
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, "missing_api_key");
  }

  const valid = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(valid.status, 200);
});

test("JSON parse and body limit errors return OpenAI-style JSON", async (t) => {
  const parseAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-json-parse-"));
  const limitAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-json-limit-"));
  const parseManager = makeManager(parseAuthDir, [makeToken()]);
  const limitManager = makeManager(limitAuthDir, [makeToken()]);
  const parseServer = await startApp(makeConfig(parseAuthDir), parseManager);
  const limitServer = await startApp(
    {
      ...makeConfig(limitAuthDir),
      "body-limit": "10b",
    },
    limitManager
  );

  t.after(async () => {
    await stopApp(parseServer);
    await stopApp(limitServer);
    fs.rmSync(parseAuthDir, { recursive: true, force: true });
    fs.rmSync(limitAuthDir, { recursive: true, force: true });
  });

  const malformed = await requestRawJson({
    server: parseServer,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    rawBody: "{\"model\":\"claude-sonnet-4-6\",",
  });

  assert.equal(malformed.status, 400);
  assert.match(String(malformed.headers["content-type"] || ""), /application\/json/);
  assert.equal(malformed.body.error.message, "Invalid JSON body");
  assert.equal(malformed.body.error.type, "invalid_request_error");
  assert.equal(malformed.body.error.code, "invalid_json");

  const tooLarge = await requestRawJson({
    server: limitServer,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    rawBody: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assert.equal(tooLarge.status, 413);
  assert.match(String(tooLarge.headers["content-type"] || ""), /application\/json/);
  assert.equal(tooLarge.body.error.message, "Request body too large");
  assert.equal(tooLarge.body.error.type, "invalid_request_error");
  assert.equal(tooLarge.body.error.code, "request_body_too_large");
});

test("Claude proxy validation errors return OpenAI-style JSON", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-validation-errors-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const chat = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: { model: "claude-sonnet-4-6" },
  });

  assert.equal(chat.status, 400);
  assert.equal(chat.body.error.message, "messages is required");
  assert.equal(chat.body.error.type, "invalid_request_error");
  assert.equal(chat.body.error.code, "missing_required_parameter");

  const responses = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: { model: "claude-sonnet-4-6" },
  });

  assert.equal(responses.status, 400);
  assert.equal(responses.body.error.message, "input is required");
  assert.equal(responses.body.error.type, "invalid_request_error");
  assert.equal(responses.body.error.code, "missing_required_parameter");
});

test("OpenAI-compatible endpoints require a model parameter", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-missing-model-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called when model is missing");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const chat = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(chat.status, 400);
  assert.equal(chat.body.error.message, "model is required");
  assert.equal(chat.body.error.type, "invalid_request_error");
  assert.equal(chat.body.error.code, "missing_required_parameter");

  const responses = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      input: "hello",
    },
  });

  assert.equal(responses.status, 400);
  assert.equal(responses.body.error.message, "model is required");
  assert.equal(responses.body.error.type, "invalid_request_error");
  assert.equal(responses.body.error.code, "missing_required_parameter");
});

test("OpenAI responses input must be a string or array before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-responses-input-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    throw new Error("Upstream should not be called when responses input is invalid");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        input: { role: "user", content: "hello" },
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "input must be a string or array");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses input arrays must not be empty before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-empty-responses-input-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_empty_responses_input",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_empty_responses_input\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        input: [],
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "input must contain at least one item");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses input items must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-responses-input-items-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_responses_input_item",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_responses_input_item\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidInputs = [
    {
      input: [{ content: "hello" }],
      message: "input[0].role is invalid",
    },
    {
      input: [{ role: "user" }],
      message: "input[0].content is required",
    },
    {
      input: [{ role: "user", content: { text: "hello" } }],
      message: "input[0].content must be a string or array",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalidInputs) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/responses",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          input: invalid.input,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses typed function input items must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-responses-typed-items-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_responses_typed_item",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_responses_typed_item\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidInputs = [
    {
      input: [{ type: "function_call", name: "lookup_weather", arguments: "{}" }],
      message: "input[0].call_id is required",
    },
    {
      input: [{ type: "function_call", call_id: "call_1", arguments: "{}" }],
      message: "input[0].name is required",
    },
    {
      input: [{ type: "function_call", call_id: "call_1", name: "lookup_weather" }],
      message: "input[0].arguments is required",
    },
    {
      input: [{ type: "function_call", call_id: "call_1", name: "lookup_weather", arguments: "not json" }],
      message: "input[0].arguments must be valid JSON",
    },
    {
      input: [{ type: "function_call_output", output: "sunny" }],
      message: "input[0].call_id is required",
    },
    {
      input: [{ type: "function_call_output", call_id: "call_1" }],
      message: "input[0].output is required",
    },
    {
      input: [{ type: "function_call_output", call_id: "call_1", output: { weather: "sunny" } }],
      message: "input[0].output must be a string",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalidInputs) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/responses",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          input: invalid.input,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses content parts must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-responses-content-parts-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_responses_content_part",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_responses_content_part\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidInputs = [
    {
      input: [{ role: "user", content: ["hello"] }],
      message: "input[0].content[0] must be an object",
    },
    {
      input: [{ role: "user", content: [{ type: "input_text" }] }],
      message: "input[0].content[0].text is required",
    },
    {
      input: [{ role: "user", content: [{ type: "input_image" }] }],
      message: "input[0].content[0].image_url is required",
    },
    {
      input: [{ role: "user", content: [{ type: "input_audio", audio: "..." }] }],
      message: "input[0].content[0].type is invalid",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalidInputs) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/responses",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          input: invalid.input,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses tools must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-responses-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_responses_tools",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_responses_tools\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidTools = [
    {
      tools: { type: "function", name: "lookup_weather" },
      message: "tools must be an array",
    },
    {
      tools: [null],
      message: "tools[0] must be an object",
    },
    {
      tools: [{ name: "lookup_weather" }],
      message: "tools[0].type is invalid",
    },
    {
      tools: [{ type: "function" }],
      message: "tools[0].name is required",
    },
    {
      tools: [{ type: "function", name: "lookup_weather", description: 42 }],
      message: "tools[0].description must be a string",
    },
    {
      tools: [{ type: "function", name: "lookup_weather", parameters: "bad" }],
      message: "tools[0].parameters must be an object",
    },
    {
      tools: [{ type: "function", name: "lookup_weather", strict: "true" }],
      message: "tools[0].strict must be a boolean",
    },
    {
      tools: [{ type: "file_search" }],
      message: "tools[0].vector_store_ids is required",
    },
    {
      tools: [{ type: "mcp", server_label: "deepwiki" }],
      message: "tools[0].server_url or connector_id is required",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalidTools) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/responses",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          input: "hello",
          tools: invalid.tools,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses hosted tools are explicitly unsupported before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-hosted-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(
      JSON.stringify({
        id: "msg_responses_hosted_tools",
        content: [{ type: "text", text: "unexpected hosted tools upstream call" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const tools = [
    { type: "file_search", vector_store_ids: ["vs_123"] },
    { type: "web_search", search_context_size: "low" },
    { type: "web_search_2025_08_26", search_context_size: "high" },
    { type: "computer_use_preview", display_width: 1024, display_height: 768, environment: "browser" },
    { type: "code_interpreter", container: "cntr_123" },
    { type: "mcp", server_label: "deepwiki", server_url: "https://example.com/mcp" },
    { type: "local_shell" },
    { type: "shell" },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const provider = model.startsWith("claude") ? "Claude" : "Codex";
    for (const tool of tools) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/responses",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          input: "use a hosted tool",
          tools: [tool],
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(
        resp.body.error.message,
        `tools[0].type is unsupported for ${provider} responses models`
      );
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("Claude responses rejects image_generation tool usage before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-responses-image-tool-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(
      JSON.stringify({
        id: "msg_unsupported_image_tool",
        content: [{ type: "text", text: "unexpected upstream call" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      body: { tools: [{ type: "image_generation", size: "1024x1024" }] },
      message: "tools[0].type is unsupported for Claude responses models",
    },
    {
      body: { tool_choice: { type: "image_generation" } },
      message: "tool_choice image_generation is unsupported for Claude responses models",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        input: "draw a small icon",
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses custom tools route only to Codex", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-custom-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_custom_tool",
          content: [{ type: "text", text: "unexpected custom tool upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_custom_tool\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"output\":[{\"type\":\"custom_tool_call\",\"call_id\":\"call_custom_2\",\"name\":\"render_markdown\",\"input\":\"**bye**\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const unsupportedClaudeTool = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "render markdown",
      tools: [{ type: "custom", name: "render_markdown", format: { type: "text" } }],
    },
  });

  assert.equal(unsupportedClaudeTool.status, 400);
  assert.equal(
    unsupportedClaudeTool.body.error.message,
    "tools[0].type is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeTool.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeTool.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const unsupportedClaudeChoice = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "render markdown",
      tool_choice: { type: "custom", name: "render_markdown" },
    },
  });

  assert.equal(unsupportedClaudeChoice.status, 400);
  assert.equal(
    unsupportedClaudeChoice.body.error.message,
    "tool_choice custom is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeChoice.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeChoice.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const unsupportedClaudeInput = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: [{ type: "custom_tool_call", call_id: "call_custom_1", name: "render_markdown", input: "**hello**" }],
    },
  });

  assert.equal(unsupportedClaudeInput.status, 400);
  assert.equal(
    unsupportedClaudeInput.body.error.message,
    "input[0].type is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeInput.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeInput.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: [
        { type: "custom_tool_call", call_id: "call_custom_1", name: "render_markdown", input: "**hello**" },
        { type: "custom_tool_call_output", call_id: "call_custom_1", output: "<strong>hello</strong>" },
        { role: "user", content: "continue" },
      ],
      tools: [{
        type: "custom",
        name: "render_markdown",
        description: "Render markdown text",
        format: { type: "text" },
      }],
      tool_choice: { type: "custom", name: "render_markdown" },
    },
  });

  assert.equal(codexResp.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.tools, [{
    type: "custom",
    name: "render_markdown",
    description: "Render markdown text",
    format: { type: "text" },
  }]);
  assert.deepEqual(calls[0].body.tool_choice, { type: "custom", name: "render_markdown" });
  assert.deepEqual(calls[0].body.input, [
    { type: "custom_tool_call", call_id: "call_custom_1", name: "render_markdown", input: "**hello**" },
    { type: "custom_tool_call_output", call_id: "call_custom_1", output: "<strong>hello</strong>" },
    { role: "user", content: "continue" },
  ]);
});

test("OpenAI responses allowed_tools tool_choice routes only to Codex", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-allowed-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_allowed_tools",
          content: [{ type: "text", text: "unexpected allowed_tools upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_allowed_tools\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const toolChoice = {
    type: "allowed_tools",
    mode: "required",
    tools: [
      { type: "function", name: "lookup_weather" },
      { type: "custom", name: "render_markdown" },
      { type: "image_generation" },
    ],
  };

  const unsupportedClaudeChoice = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "use a tool",
      tool_choice: toolChoice,
    },
  });

  assert.equal(unsupportedClaudeChoice.status, 400);
  assert.equal(
    unsupportedClaudeChoice.body.error.message,
    "tool_choice allowed_tools is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeChoice.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeChoice.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "use a tool",
      tool_choice: toolChoice,
    },
  });

  assert.equal(codexResp.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.tool_choice, toolChoice);
});

test("OpenAI responses hosted tool_choice is explicitly unsupported before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-hosted-tool-choice-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(
      JSON.stringify({
        id: "msg_responses_hosted_tool_choice",
        content: [{ type: "text", text: "unexpected hosted tool_choice upstream call" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const choices = [
    { type: "file_search" },
    { type: "web_search_preview" },
    { type: "web_search_preview_2025_03_11" },
    { type: "computer_use_preview" },
    { type: "code_interpreter" },
    { type: "mcp", server_label: "deepwiki" },
    { type: "apply_patch" },
    { type: "shell" },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const provider = model.startsWith("claude") ? "Claude" : "Codex";
    for (const tool_choice of choices) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/responses",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          input: "use a hosted tool",
          tool_choice,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(
        resp.body.error.message,
        `tool_choice ${tool_choice.type} is unsupported for ${provider} responses models`
      );
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("Claude responses rejects unsupported text format before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-responses-text-format-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(
      JSON.stringify({
        id: "msg_unsupported_text_format",
        content: [{ type: "text", text: "unexpected upstream call" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { text: "json", message: "text must be an object" },
    { text: { format: "json_object" }, message: "text.format must be an object" },
    {
      text: { format: { type: "xml" } },
      message: "text.format.type must be one of text, json_object, json_schema",
    },
    { text: { format: { type: "json_object" } }, message: "text.format json_object is unsupported for Claude responses models" },
    { text: { format: { type: "json_schema" } }, message: "text.format.name is required" },
    { text: { format: { type: "json_schema", name: "answer" } }, message: "text.format.schema is required" },
    {
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object" },
        },
      },
      message: "text.format json_schema is unsupported for Claude responses models",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        input: "return JSON",
        text: invalid.text,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);

  const textResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      text: { format: { type: "text" } },
    },
  });

  assert.equal(textResp.status, 200);
  assert.equal(calls.length, 1);
});

test("OpenAI responses reasoning fields must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-reasoning-effort-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_reasoning_effort",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_reasoning_effort\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", reasoning: "low", message: "reasoning must be an object" },
    { model: "gpt-5.4", reasoning: "low", message: "reasoning must be an object" },
    {
      model: "claude-sonnet-4-6",
      reasoning: { effort: "mega" },
      message: "reasoning.effort must be one of none, minimal, low, medium, high, xhigh",
    },
    {
      model: "gpt-5.4",
      reasoning: { effort: "mega" },
      message: "reasoning.effort must be one of none, minimal, low, medium, high, xhigh",
    },
    {
      model: "claude-sonnet-4-6",
      reasoning: { summary: "verbose" },
      message: "reasoning.summary must be one of auto, concise, detailed",
    },
    {
      model: "gpt-5.4",
      reasoning: { summary: "verbose" },
      message: "reasoning.summary must be one of auto, concise, detailed",
    },
    {
      model: "claude-sonnet-4-6",
      reasoning: { summary: 1 },
      message: "reasoning.summary must be one of auto, concise, detailed",
    },
    {
      model: "gpt-5.4",
      reasoning: { generate_summary: "short" },
      message: "reasoning.generate_summary must be one of auto, concise, detailed",
    },
    {
      model: "claude-sonnet-4-6",
      reasoning: { generate_summary: null },
      message: "reasoning.generate_summary must be one of auto, concise, detailed",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        reasoning: invalid.reasoning,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);

  const unsupportedClaudeSummary = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      reasoning: { summary: "concise" },
    },
  });

  assert.equal(unsupportedClaudeSummary.status, 400);
  assert.equal(unsupportedClaudeSummary.body.error.message, "reasoning.summary is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeSummary.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeSummary.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const unsupportedClaudeGenerateSummary = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      reasoning: { generate_summary: "detailed" },
    },
  });

  assert.equal(unsupportedClaudeGenerateSummary.status, 400);
  assert.equal(
    unsupportedClaudeGenerateSummary.body.error.message,
    "reasoning.generate_summary is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeGenerateSummary.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeGenerateSummary.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      reasoning: { effort: "minimal" },
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.deepEqual(calls[0].body.thinking, { type: "enabled", budget_tokens: 1024 });

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      reasoning: { effort: "xhigh", summary: "concise", generate_summary: "detailed" },
    },
  });

  assert.equal(codexResp.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.deepEqual(calls[1].body.reasoning, { effort: "xhigh", summary: "concise", generate_summary: "detailed" });
});

test("OpenAI responses sampling parameters must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-sampling-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_sampling",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_sampling\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      body: { temperature: 2 },
      message: "temperature must be a number between 0 and 1",
    },
    {
      model: "claude-sonnet-4-6",
      body: { temperature: "0.7" },
      message: "temperature must be a number between 0 and 1",
    },
    {
      model: "claude-sonnet-4-6",
      body: { top_p: 2 },
      message: "top_p must be a number between 0 and 1",
    },
    {
      model: "claude-sonnet-4-6",
      body: { top_logprobs: "3" },
      message: "top_logprobs must be an integer between 0 and 20",
    },
    {
      model: "gpt-5.4",
      body: { temperature: 3 },
      message: "temperature must be a number between 0 and 2",
    },
    {
      model: "gpt-5.4",
      body: { temperature: "0.7" },
      message: "temperature must be a number between 0 and 2",
    },
    {
      model: "gpt-5.4",
      body: { top_p: -0.1 },
      message: "top_p must be a number between 0 and 1",
    },
    {
      model: "gpt-5.4",
      body: { top_logprobs: 1.5 },
      message: "top_logprobs must be an integer between 0 and 20",
    },
    {
      model: "gpt-5.4",
      body: { top_logprobs: 21 },
      message: "top_logprobs must be an integer between 0 and 20",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);

  const unsupportedClaudeTopLogprobs = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      top_logprobs: 3,
    },
  });

  assert.equal(unsupportedClaudeTopLogprobs.status, 400);
  assert.equal(unsupportedClaudeTopLogprobs.body.error.message, "top_logprobs is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeTopLogprobs.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeTopLogprobs.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      temperature: 0.7,
      top_p: 0.9,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.temperature, 0.7);
  assert.equal(calls[0].body.top_p, 0.9);

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      temperature: 1.7,
      top_logprobs: 3,
      top_p: 0.8,
    },
  });

  assert.equal(codexResp.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.temperature, 1.7);
  assert.equal(calls[1].body.top_logprobs, 3);
  assert.equal(calls[1].body.top_p, 0.8);
});

test("OpenAI responses parallel_tool_calls must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-parallel-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_parallel_tools",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_parallel_tools\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", parallel_tool_calls: "false" },
    { model: "gpt-5.4", parallel_tool_calls: "false" },
    { model: "gpt-5.4", parallel_tool_calls: 1 },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        parallel_tool_calls: invalid.parallel_tool_calls,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "parallel_tool_calls must be a boolean");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      parallel_tool_calls: false,
    },
  });

  assert.equal(unsupportedClaudeFalse.status, 400);
  assert.equal(unsupportedClaudeFalse.body.error.message, "parallel_tool_calls false is unsupported");
  assert.equal(unsupportedClaudeFalse.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeFalse.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeTrue = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      parallel_tool_calls: true,
    },
  });

  assert.equal(claudeTrue.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.parallel_tool_calls, undefined);

  const codexFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      parallel_tool_calls: false,
    },
  });

  assert.equal(codexFalse.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.parallel_tool_calls, false);
});

test("OpenAI responses service_tier must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-service-tier-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_service_tier",
          content: [{ type: "text", text: "unexpected service tier upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_service_tier\",\"model\":\"gpt-5.4\",\"service_tier\":\"priority\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", service_tier: "express" },
    { model: "gpt-5.4", service_tier: "express" },
    { model: "gpt-5.4", service_tier: 1 },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        service_tier: invalid.service_tier,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "service_tier must be one of auto, default, flex, scale, priority");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeTier = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      service_tier: "default",
    },
  });

  assert.equal(unsupportedClaudeTier.status, 400);
  assert.equal(unsupportedClaudeTier.body.error.message, "service_tier is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeTier.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeTier.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexPriority = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      service_tier: "priority",
    },
  });

  assert.equal(codexPriority.status, 200);
  assert.equal(codexPriority.body.service_tier, "priority");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.service_tier, "priority");
});

test("OpenAI responses prompt cache parameters must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-prompt-cache-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_prompt_cache",
          content: [{ type: "text", text: "unexpected prompt cache upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_prompt_cache\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      body: { prompt_cache_key: 42 },
      message: "prompt_cache_key must be a string",
    },
    {
      model: "gpt-5.4",
      body: { prompt_cache_key: 42 },
      message: "prompt_cache_key must be a string",
    },
    {
      model: "gpt-5.4",
      body: { prompt_cache_retention: "1h" },
      message: "prompt_cache_retention must be one of in-memory, 24h",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudePromptCache = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      prompt_cache_key: "tenant:user-42",
      prompt_cache_retention: "24h",
    },
  });

  assert.equal(unsupportedClaudePromptCache.status, 400);
  assert.equal(
    unsupportedClaudePromptCache.body.error.message,
    "prompt cache parameters are unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudePromptCache.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudePromptCache.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexPromptCache = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      prompt_cache_key: "tenant:user-42",
      prompt_cache_retention: "in-memory",
    },
  });

  assert.equal(codexPromptCache.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.prompt_cache_key, "tenant:user-42");
  assert.equal(calls[0].body.prompt_cache_retention, "in-memory");
});

test("OpenAI responses truncation must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-truncation-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_truncation",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_truncation\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", truncation: "left" },
    { model: "gpt-5.4", truncation: "left" },
    { model: "gpt-5.4", truncation: 1 },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        truncation: invalid.truncation,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "truncation must be one of auto, disabled");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeAuto = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      truncation: "auto",
    },
  });

  assert.equal(unsupportedClaudeAuto.status, 400);
  assert.equal(unsupportedClaudeAuto.body.error.message, "truncation auto is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeAuto.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeAuto.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeDisabled = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      truncation: "disabled",
    },
  });

  assert.equal(claudeDisabled.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.truncation, undefined);

  const codexAuto = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      truncation: "auto",
    },
  });

  assert.equal(codexAuto.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.truncation, "auto");
});

test("OpenAI responses previous_response_id must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-previous-response-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_previous_response",
          content: [{ type: "text", text: "unexpected previous response upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_previous_response\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", previous_response_id: 42 },
    { model: "gpt-5.4", previous_response_id: 42 },
    { model: "gpt-5.4", previous_response_id: { id: "resp_prev" } },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        previous_response_id: invalid.previous_response_id,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "previous_response_id must be a string");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudePrevious = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      previous_response_id: "resp_prev_123",
    },
  });

  assert.equal(unsupportedClaudePrevious.status, 400);
  assert.equal(
    unsupportedClaudePrevious.body.error.message,
    "previous_response_id is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudePrevious.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudePrevious.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexPrevious = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      previous_response_id: "resp_prev_123",
    },
  });

  assert.equal(codexPrevious.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.previous_response_id, "resp_prev_123");
});

test("OpenAI responses conversation must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-conversation-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_conversation",
          content: [{ type: "text", text: "unexpected conversation upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_conversation\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      body: { conversation: 42 },
      message: "conversation must be a string or object with an id string",
    },
    {
      model: "gpt-5.4",
      body: { conversation: 42 },
      message: "conversation must be a string or object with an id string",
    },
    {
      model: "gpt-5.4",
      body: { conversation: { id: 42 } },
      message: "conversation must be a string or object with an id string",
    },
    {
      model: "gpt-5.4",
      body: { conversation: "conv_123", previous_response_id: "resp_prev_123" },
      message: "conversation cannot be used with previous_response_id",
    },
    {
      model: "claude-sonnet-4-6",
      body: { conversation: "conv_123", previous_response_id: "resp_prev_123" },
      message: "conversation cannot be used with previous_response_id",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeConversation = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      conversation: "conv_123",
    },
  });

  assert.equal(unsupportedClaudeConversation.status, 400);
  assert.equal(unsupportedClaudeConversation.body.error.message, "conversation is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeConversation.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeConversation.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexConversationString = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      conversation: "conv_123",
    },
  });

  assert.equal(codexConversationString.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.conversation, "conv_123");

  const codexConversationObject = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      conversation: { id: "conv_456" },
    },
  });

  assert.equal(codexConversationObject.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.deepEqual(calls[1].body.conversation, { id: "conv_456" });
});

test("OpenAI responses include must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-include-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_include",
          content: [{ type: "text", text: "unexpected include upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_include\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const includeValueError =
    "include values must be one of file_search_call.results, web_search_call.results, web_search_call.action.sources, message.input_image.image_url, computer_call_output.output.image_url, code_interpreter_call.outputs, reasoning.encrypted_content, message.output_text.logprobs";
  const invalids = [
    { model: "claude-sonnet-4-6", include: "reasoning.encrypted_content", message: "include must be an array" },
    { model: "gpt-5.4", include: "reasoning.encrypted_content", message: "include must be an array" },
    { model: "gpt-5.4", include: [42], message: includeValueError },
    { model: "gpt-5.4", include: ["unknown.include"], message: includeValueError },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        include: invalid.include,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeInclude = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      include: ["reasoning.encrypted_content"],
    },
  });

  assert.equal(unsupportedClaudeInclude.status, 400);
  assert.equal(unsupportedClaudeInclude.body.error.message, "include is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeInclude.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeInclude.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexInclude = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
    },
  });

  assert.equal(codexInclude.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.include, ["reasoning.encrypted_content", "message.output_text.logprobs"]);
});

test("OpenAI responses stream_options must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-stream-options-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_responses_stream_options\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]);
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_stream_options\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      body: { stream: true, stream_options: "none" },
      message: "stream_options must be an object",
    },
    {
      model: "gpt-5.4",
      body: { stream: true, stream_options: "none" },
      message: "stream_options must be an object",
    },
    {
      model: "gpt-5.4",
      body: { stream_options: {} },
      message: "stream_options can only be set when stream is true",
    },
    {
      model: "gpt-5.4",
      body: { stream: true, stream_options: { include_obfuscation: "false" } },
      message: "stream_options.include_obfuscation must be a boolean",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeStreamOptions = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      stream: true,
      stream_options: { include_obfuscation: false },
    },
  });

  assert.equal(unsupportedClaudeStreamOptions.status, 400);
  assert.equal(
    unsupportedClaudeStreamOptions.body.error.message,
    "stream_options.include_obfuscation is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeStreamOptions.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeStreamOptions.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeEmptyStreamOptions = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      stream: true,
      stream_options: {},
    },
  });

  assert.equal(claudeEmptyStreamOptions.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.stream_options, undefined);
  assert.match(String(claudeEmptyStreamOptions.body), /response\.created/);

  const codexStreamOptions = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      stream: true,
      stream_options: { include_obfuscation: false },
    },
  });

  assert.equal(codexStreamOptions.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.deepEqual(calls[1].body.stream_options, { include_obfuscation: false });
  assert.match(String(codexStreamOptions.body), /response\.completed/);
});

test("OpenAI responses store must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-store-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_store",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_store\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", store: "false" },
    { model: "gpt-5.4", store: "false" },
    { model: "gpt-5.4", store: null },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        store: invalid.store,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "store must be a boolean");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeStore = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      store: true,
    },
  });

  assert.equal(unsupportedClaudeStore.status, 400);
  assert.equal(unsupportedClaudeStore.body.error.message, "store true is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeStore.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeStore.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeStoreFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      store: false,
    },
  });

  assert.equal(claudeStoreFalse.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.store, undefined);

  const codexStoreTrue = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      store: true,
    },
  });

  assert.equal(codexStoreTrue.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.store, true);
});

test("OpenAI responses instructions must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-instructions-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_instructions",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_instructions\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", instructions: 42 },
    { model: "gpt-5.4", instructions: 42 },
    { model: "gpt-5.4", instructions: null },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        instructions: invalid.instructions,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "instructions must be a string");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const claudeInstructions = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      instructions: "Answer tersely.",
    },
  });

  assert.equal(claudeInstructions.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.deepEqual(calls[0].body.system, [{ type: "text", text: "Answer tersely." }]);

  const codexInstructions = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      instructions: "Answer directly.",
    },
  });

  assert.equal(codexInstructions.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.instructions, "Answer directly.");
});

test("OpenAI responses background must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-background-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_background",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_background\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", background: "true" },
    { model: "gpt-5.4", background: "true" },
    { model: "gpt-5.4", background: null },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        background: invalid.background,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "background must be a boolean");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeBackground = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      background: true,
    },
  });

  assert.equal(unsupportedClaudeBackground.status, 400);
  assert.equal(
    unsupportedClaudeBackground.body.error.message,
    "background true is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeBackground.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeBackground.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const unsupportedCodexBackground = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      background: true,
    },
  });

  assert.equal(unsupportedCodexBackground.status, 400);
  assert.equal(unsupportedCodexBackground.body.error.message, "background true is unsupported for Codex responses models");
  assert.equal(unsupportedCodexBackground.body.error.type, "invalid_request_error");
  assert.equal(unsupportedCodexBackground.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeBackgroundFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      background: false,
    },
  });

  assert.equal(claudeBackgroundFalse.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.background, undefined);

  const codexBackgroundFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      background: false,
    },
  });

  assert.equal(codexBackgroundFalse.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.background, false);
});

test("OpenAI responses safety_identifier must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-safety-id-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_safety_id",
          content: [{ type: "text", text: "unexpected safety_identifier upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_safety_id\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", safety_identifier: 42, message: "safety_identifier must be a string" },
    { model: "gpt-5.4", safety_identifier: 42, message: "safety_identifier must be a string" },
    {
      model: "gpt-5.4",
      safety_identifier: "u".repeat(65),
      message: "safety_identifier must be at most 64 characters",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        safety_identifier: invalid.safety_identifier,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeSafetyId = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      safety_identifier: "user-hash-42",
    },
  });

  assert.equal(unsupportedClaudeSafetyId.status, 400);
  assert.equal(
    unsupportedClaudeSafetyId.body.error.message,
    "safety_identifier is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeSafetyId.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeSafetyId.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexSafetyId = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      safety_identifier: "user-hash-42",
    },
  });

  assert.equal(codexSafetyId.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.safety_identifier, "user-hash-42");
});

test("OpenAI responses user must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-user-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_user",
          content: [{ type: "text", text: "unexpected user upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_user\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const invalid of [
    { model: "claude-sonnet-4-6", user: 42 },
    { model: "gpt-5.4", user: 42 },
  ]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        user: invalid.user,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "user must be a string");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeUser = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      user: "legacy-user-42",
    },
  });

  assert.equal(unsupportedClaudeUser.status, 400);
  assert.equal(unsupportedClaudeUser.body.error.message, "user is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeUser.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeUser.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexUser = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      user: "legacy-user-42",
    },
  });

  assert.equal(codexUser.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.user, "legacy-user-42");
});

test("OpenAI responses max_tool_calls must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-max-tool-calls-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_max_tool_calls",
          content: [{ type: "text", text: "unexpected max_tool_calls upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_max_tool_calls\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", max_tool_calls: "2" },
    { model: "gpt-5.4", max_tool_calls: "2" },
    { model: "gpt-5.4", max_tool_calls: null },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        max_tool_calls: invalid.max_tool_calls,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "max_tool_calls must be a number");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeMaxToolCalls = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      max_tool_calls: 2,
    },
  });

  assert.equal(unsupportedClaudeMaxToolCalls.status, 400);
  assert.equal(
    unsupportedClaudeMaxToolCalls.body.error.message,
    "max_tool_calls is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeMaxToolCalls.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeMaxToolCalls.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexMaxToolCalls = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      max_tool_calls: 2,
    },
  });

  assert.equal(codexMaxToolCalls.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.max_tool_calls, 2);
});

test("OpenAI responses prompt must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-prompt-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_prompt",
          content: [{ type: "text", text: "unexpected prompt upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_prompt\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", prompt: "pmpt_123", message: "prompt must be an object" },
    { model: "gpt-5.4", prompt: "pmpt_123", message: "prompt must be an object" },
    { model: "gpt-5.4", prompt: { version: "1" }, message: "prompt.id must be a string" },
    {
      model: "gpt-5.4",
      prompt: { id: "pmpt_123", variables: { count: 3 } },
      message: "prompt.variables.count must be a string or response input object",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        prompt: invalid.prompt,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const promptTemplate = {
    id: "pmpt_123",
    version: "7",
    variables: {
      name: "Wy",
      brief: { type: "input_text", text: "Keep it concise." },
    },
  };

  const unsupportedClaudePrompt = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      prompt: promptTemplate,
    },
  });

  assert.equal(unsupportedClaudePrompt.status, 400);
  assert.equal(unsupportedClaudePrompt.body.error.message, "prompt is unsupported for Claude responses models");
  assert.equal(unsupportedClaudePrompt.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudePrompt.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexPrompt = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      prompt: promptTemplate,
    },
  });

  assert.equal(codexPrompt.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.prompt, promptTemplate);
});

test("OpenAI responses context_management must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-context-management-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_context_management",
          content: [{ type: "text", text: "unexpected context_management upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_context_management\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      context_management: {},
      message: "context_management must be an array",
    },
    {
      model: "gpt-5.4",
      context_management: {},
      message: "context_management must be an array",
    },
    {
      model: "gpt-5.4",
      context_management: [{ type: "memory" }],
      message: "context_management[0].type must be compaction",
    },
    {
      model: "gpt-5.4",
      context_management: [{ type: "compaction", compact_threshold: 999 }],
      message: "context_management[0].compact_threshold must be at least 1000",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        context_management: invalid.context_management,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const contextManagement = [{ type: "compaction", compact_threshold: 2000 }];

  const unsupportedClaudeContextManagement = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      context_management: contextManagement,
    },
  });

  assert.equal(unsupportedClaudeContextManagement.status, 400);
  assert.equal(
    unsupportedClaudeContextManagement.body.error.message,
    "context_management is unsupported for Claude responses models"
  );
  assert.equal(unsupportedClaudeContextManagement.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeContextManagement.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexContextManagement = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      context_management: contextManagement,
    },
  });

  assert.equal(codexContextManagement.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.context_management, contextManagement);
});

test("OpenAI responses metadata must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-metadata-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_metadata",
          content: [{ type: "text", text: "unexpected metadata upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_metadata\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", metadata: "tenant", message: "metadata must be an object" },
    { model: "gpt-5.4", metadata: "tenant", message: "metadata must be an object" },
    { model: "claude-sonnet-4-6", metadata: { tenant: 42 }, message: "metadata values must be strings" },
    { model: "gpt-5.4", metadata: { tenant: "v".repeat(513) }, message: "metadata values must be at most 512 characters" },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        input: "hello",
        metadata: invalid.metadata,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);

  const unsupportedClaudeMetadata = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
      metadata: { tenant: "personal", workflow: "responses" },
    },
  });

  assert.equal(unsupportedClaudeMetadata.status, 400);
  assert.equal(unsupportedClaudeMetadata.body.error.message, "metadata is unsupported for Claude responses models");
  assert.equal(unsupportedClaudeMetadata.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeMetadata.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "hello",
      metadata: { tenant: "personal", workflow: "responses" },
    },
  });

  assert.equal(codexResp.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.metadata, { tenant: "personal", workflow: "responses" });
});

test("OpenAI responses rejects invalid tool_choice strings before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-responses-tool-choice-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_responses_tool_choice",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_responses_tool_choice\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidToolChoices = [
    "sometimes",
    { type: "custom" },
    { type: "custom", name: "" },
    { type: "allowed_tools" },
    { type: "allowed_tools", mode: "sometimes", tools: [] },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "function", function: { name: "nested_chat_shape" } }] },
    { type: "mcp" },
    { type: "mcp", server_label: "" },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const tool_choice of invalidToolChoices) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/responses",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          input: "hello",
          tool_choice,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(
        resp.body.error.message,
        "tool_choice must be one of auto, none, required, an allowed_tools tool choice, a function tool choice, a custom tool choice, a hosted tool choice, an MCP tool choice, a shell/apply_patch tool choice, or an image_generation tool choice"
      );
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI responses stream must be a boolean before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-invalid-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_invalid_responses_stream\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]);
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_responses_stream\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        input: "hello",
        stream: "false",
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "stream must be a boolean");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("Claude OpenAI-compatible token limits must be positive integers before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-token-limits-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(
      JSON.stringify({
        id: "msg_invalid_token_limit",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidRequests = [
    {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: "32",
      },
      message: "max_tokens must be a positive integer",
    },
    {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 0,
      },
      message: "max_tokens must be a positive integer",
    },
    {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: "32",
      },
      message: "max_completion_tokens must be a positive integer",
    },
    {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 0,
      },
      message: "max_completion_tokens must be a positive integer",
    },
    {
      path: "/v1/chat/completions",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32,
        max_completion_tokens: 64,
      },
      message: "max_tokens and max_completion_tokens must match when both are provided",
    },
    {
      path: "/v1/responses",
      body: {
        model: "claude-sonnet-4-6",
        input: "hello",
        max_output_tokens: "32",
      },
      message: "max_output_tokens must be a positive integer",
    },
    {
      path: "/v1/responses",
      body: {
        model: "claude-sonnet-4-6",
        input: "hello",
        max_output_tokens: 0,
      },
      message: "max_output_tokens must be a positive integer",
    },
  ];

  for (const invalid of invalidRequests) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: invalid.path,
      headers: { Authorization: "Bearer test-key" },
      body: invalid.body,
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);

  const validResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 64,
      stream: false,
    },
  });

  assert.equal(validResp.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.max_tokens, 64);
});

test("OpenAI chat reasoning_effort must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-reasoning-effort-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_reasoning_effort",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_reasoning_effort\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", reasoning_effort: "mega" },
    { model: "gpt-5.4", reasoning_effort: "mega" },
    { model: "claude-sonnet-4-6", reasoning_effort: 1 },
    { model: "gpt-5.4", reasoning_effort: 1 },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: invalid.reasoning_effort,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(
      resp.body.error.message,
      "reasoning_effort must be one of none, minimal, low, medium, high, xhigh"
    );
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "minimal",
      stream: false,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.deepEqual(calls[0].body.thinking, { type: "enabled", budget_tokens: 1024 });

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      stream: false,
    },
  });

  assert.equal(codexResp.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.deepEqual(calls[1].body.reasoning, { effort: "high" });
});

test("OpenAI chat output modalities must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-modalities-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_modalities",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_modalities\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidCases = [
    {
      body: { modalities: "audio" },
      message: "modalities must be an array",
    },
    {
      body: { modalities: ["video"] },
      message: "modalities must contain only text, audio, or image",
    },
    {
      body: { modalities: ["text", "audio"], audio: { format: "mp3", voice: "alloy" } },
      message: "audio output is unsupported",
    },
    {
      body: { audio: { format: "mp3", voice: "alloy" } },
      message: "audio output is unsupported",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalidCases) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          ...invalid.body,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat parallel_tool_calls must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-parallel-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_parallel_tools",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_parallel_tools\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const invalidResp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        parallel_tool_calls: "false",
        stream: false,
      },
    });

    assert.equal(invalidResp.status, 400);
    assert.equal(invalidResp.body.error.message, "parallel_tool_calls must be a boolean");
    assert.equal(invalidResp.body.error.type, "invalid_request_error");
    assert.equal(invalidResp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      parallel_tool_calls: false,
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeFalse.status, 400);
  assert.equal(unsupportedClaudeFalse.body.error.message, "parallel_tool_calls false is unsupported");
  assert.equal(unsupportedClaudeFalse.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeFalse.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeTrue = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      parallel_tool_calls: true,
      stream: false,
    },
  });

  assert.equal(claudeTrue.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.parallel_tool_calls, undefined);

  const codexFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      parallel_tool_calls: false,
      stream: false,
    },
  });

  assert.equal(codexFalse.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.parallel_tool_calls, false);
});

test("OpenAI chat service_tier must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-service-tier-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_service_tier",
          content: [{ type: "text", text: "unexpected service tier upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_service_tier\",\"model\":\"gpt-5.4\",\"service_tier\":\"priority\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const invalidResp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        service_tier: "express",
        stream: false,
      },
    });

    assert.equal(invalidResp.status, 400);
    assert.equal(invalidResp.body.error.message, "service_tier must be one of auto, default, flex, scale, priority");
    assert.equal(invalidResp.body.error.type, "invalid_request_error");
    assert.equal(invalidResp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeTier = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      service_tier: "default",
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeTier.status, 400);
  assert.equal(unsupportedClaudeTier.body.error.message, "service_tier is unsupported for Claude chat");
  assert.equal(unsupportedClaudeTier.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeTier.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexPriority = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      service_tier: "priority",
      stream: false,
    },
  });

  assert.equal(codexPriority.status, 200);
  assert.equal(codexPriority.body.service_tier, "priority");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.service_tier, "priority");
});

test("OpenAI chat prompt cache parameters must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-prompt-cache-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_prompt_cache",
          content: [{ type: "text", text: "unexpected prompt cache upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_prompt_cache\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const invalidKeyResp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        prompt_cache_key: 42,
        stream: false,
      },
    });

    assert.equal(invalidKeyResp.status, 400);
    assert.equal(invalidKeyResp.body.error.message, "prompt_cache_key must be a string");
    assert.equal(invalidKeyResp.body.error.type, "invalid_request_error");
    assert.equal(invalidKeyResp.body.error.code, "invalid_parameter");

    const invalidRetentionResp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        prompt_cache_retention: "1h",
        stream: false,
      },
    });

    assert.equal(invalidRetentionResp.status, 400);
    assert.equal(invalidRetentionResp.body.error.message, "prompt_cache_retention must be one of in_memory, 24h");
    assert.equal(invalidRetentionResp.body.error.type, "invalid_request_error");
    assert.equal(invalidRetentionResp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudePromptCache = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      prompt_cache_key: "tenant:user-42",
      prompt_cache_retention: "24h",
      stream: false,
    },
  });

  assert.equal(unsupportedClaudePromptCache.status, 400);
  assert.equal(unsupportedClaudePromptCache.body.error.message, "prompt cache parameters are unsupported for Claude chat");
  assert.equal(unsupportedClaudePromptCache.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudePromptCache.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexPromptCache = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      prompt_cache_key: "tenant:user-42",
      prompt_cache_retention: "in_memory",
      stream: false,
    },
  });

  assert.equal(codexPromptCache.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.prompt_cache_key, "tenant:user-42");
  assert.equal(calls[0].body.prompt_cache_retention, "in-memory");
});

test("OpenAI chat metadata must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-metadata-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_metadata",
          content: [{ type: "text", text: "unexpected metadata upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_metadata\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const invalidShapeResp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        metadata: "tenant",
        stream: false,
      },
    });

    assert.equal(invalidShapeResp.status, 400);
    assert.equal(invalidShapeResp.body.error.message, "metadata must be an object");
    assert.equal(invalidShapeResp.body.error.type, "invalid_request_error");
    assert.equal(invalidShapeResp.body.error.code, "invalid_parameter");

    const invalidValueResp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        metadata: { tenant: 42 },
        stream: false,
      },
    });

    assert.equal(invalidValueResp.status, 400);
    assert.equal(invalidValueResp.body.error.message, "metadata values must be strings");
    assert.equal(invalidValueResp.body.error.type, "invalid_request_error");
    assert.equal(invalidValueResp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeMetadata = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      metadata: { tenant: "personal", workflow: "daily" },
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeMetadata.status, 400);
  assert.equal(unsupportedClaudeMetadata.body.error.message, "metadata is unsupported for Claude chat");
  assert.equal(unsupportedClaudeMetadata.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeMetadata.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexMetadata = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      metadata: { tenant: "personal", workflow: "daily" },
      stream: false,
    },
  });

  assert.equal(codexMetadata.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.metadata, { tenant: "personal", workflow: "daily" });
});

test("OpenAI chat safety_identifier must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-safety-identifier-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_safety_identifier",
          content: [{ type: "text", text: "unexpected safety_identifier upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_safety_identifier\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    { model: "claude-sonnet-4-6", safety_identifier: 42, message: "safety_identifier must be a string" },
    { model: "gpt-5.4", safety_identifier: 42, message: "safety_identifier must be a string" },
    {
      model: "claude-sonnet-4-6",
      safety_identifier: "u".repeat(65),
      message: "safety_identifier must be at most 64 characters",
    },
    {
      model: "gpt-5.4",
      safety_identifier: "u".repeat(65),
      message: "safety_identifier must be at most 64 characters",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        safety_identifier: invalid.safety_identifier,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeSafetyIdentifier = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      safety_identifier: "user-hash-42",
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeSafetyIdentifier.status, 400);
  assert.equal(unsupportedClaudeSafetyIdentifier.body.error.message, "safety_identifier is unsupported for Claude chat");
  assert.equal(unsupportedClaudeSafetyIdentifier.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeSafetyIdentifier.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexSafetyIdentifier = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      safety_identifier: "user-hash-42",
      stream: false,
    },
  });

  assert.equal(codexSafetyIdentifier.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.safety_identifier, "user-hash-42");
});

test("OpenAI chat user must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-user-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_user",
          content: [{ type: "text", text: "unexpected user upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_user\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const invalid of [
    { model: "claude-sonnet-4-6", user: 42 },
    { model: "gpt-5.4", user: 42 },
  ]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        user: invalid.user,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "user must be a string");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeUser = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      user: "legacy-user-42",
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeUser.status, 400);
  assert.equal(unsupportedClaudeUser.body.error.message, "user is unsupported for Claude chat");
  assert.equal(unsupportedClaudeUser.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeUser.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexUser = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      user: "legacy-user-42",
      stream: false,
    },
  });

  assert.equal(codexUser.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.equal(calls[0].body.user, "legacy-user-42");
});

test("OpenAI chat seed must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-seed-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_seed",
          content: [{ type: "text", text: "unexpected seed upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_seed\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidMessage = "seed must be a number between -9223372036854776000 and 9223372036854776000";
  const invalids = [
    { model: "claude-sonnet-4-6", seed: "42" },
    { model: "gpt-5.4", seed: "42" },
    { model: "claude-sonnet-4-6", seed: 1e20 },
    { model: "gpt-5.4", seed: 1e20 },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        seed: invalid.seed,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalidMessage);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        seed: 42,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "seed is unsupported");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);
});

test("OpenAI chat store must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-store-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_store",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_store\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const invalid of [
    { model: "claude-sonnet-4-6", store: "false" },
    { model: "gpt-5.4", store: "false" },
    { model: "gpt-5.4", store: null },
  ]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        store: invalid.store,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "store must be a boolean");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeStore = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      store: true,
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeStore.status, 400);
  assert.equal(unsupportedClaudeStore.body.error.message, "store true is unsupported for Claude chat");
  assert.equal(unsupportedClaudeStore.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeStore.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeStoreFalse = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      store: false,
      stream: false,
    },
  });

  assert.equal(claudeStoreFalse.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.store, undefined);

  const codexStoreTrue = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      store: true,
      stream: false,
    },
  });

  assert.equal(codexStoreTrue.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.equal(calls[1].body.store, true);
});

test("OpenAI chat stream_options must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-stream-options-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_chat_stream_options\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]);
    }

    return makeSseResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"hello\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_chat_stream_options\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":7,\"total_tokens\":12}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      body: { stream: true, stream_options: "none" },
      message: "stream_options must be an object",
    },
    {
      model: "gpt-5.4",
      body: { stream: true, stream_options: "none" },
      message: "stream_options must be an object",
    },
    {
      model: "gpt-5.4",
      body: { stream_options: {} },
      message: "stream_options can only be set when stream is true",
    },
    {
      model: "gpt-5.4",
      body: { stream: false, stream_options: {} },
      message: "stream_options can only be set when stream is true",
    },
    {
      model: "gpt-5.4",
      body: { stream: true, stream_options: { include_usage: "true" } },
      message: "stream_options.include_usage must be a boolean",
    },
    {
      model: "gpt-5.4",
      body: { stream: true, stream_options: { include_obfuscation: "false" } },
      message: "stream_options.include_obfuscation must be a boolean",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeObfuscation = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_obfuscation: false },
    },
  });

  assert.equal(unsupportedClaudeObfuscation.status, 400);
  assert.equal(
    unsupportedClaudeObfuscation.body.error.message,
    "stream_options.include_obfuscation is unsupported for Claude chat"
  );
  assert.equal(unsupportedClaudeObfuscation.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeObfuscation.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const claudeIncludeUsage = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    },
  });

  assert.equal(claudeIncludeUsage.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("anthropic.com"));
  assert.equal(calls[0].body.stream_options, undefined);
  assert.match(String(claudeIncludeUsage.body), /"usage":null/);
  assert.match(String(claudeIncludeUsage.body), /"choices":\[\],"usage":\{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7/);

  const codexStreamOptions = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true, include_obfuscation: false },
    },
  });

  assert.equal(codexStreamOptions.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("chatgpt.com"));
  assert.deepEqual(calls[1].body.stream_options, { include_obfuscation: false });
  assert.match(String(codexStreamOptions.body), /"usage":null/);
  assert.match(String(codexStreamOptions.body), /"choices":\[\],"usage":\{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12\}/);
});

test("OpenAI chat web_search_options must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-web-search-options-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_web_search_options",
          content: [{ type: "text", text: "unexpected web search" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_web_search_options\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      web_search_options: "enabled",
      message: "web_search_options must be an object",
    },
    {
      model: "gpt-5.4",
      web_search_options: "enabled",
      message: "web_search_options must be an object",
    },
    {
      model: "gpt-5.4",
      web_search_options: { search_context_size: "huge" },
      message: "web_search_options.search_context_size must be one of low, medium, high",
    },
    {
      model: "gpt-5.4",
      web_search_options: { user_location: { type: "exact", approximate: { country: "US" } } },
      message: "web_search_options.user_location.type must be approximate",
    },
    {
      model: "gpt-5.4",
      web_search_options: { user_location: { type: "approximate", approximate: { city: 42 } } },
      message: "web_search_options.user_location.approximate.city must be a string",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        web_search_options: invalid.web_search_options,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        web_search_options: {
          search_context_size: "medium",
          user_location: {
            type: "approximate",
            approximate: {
              city: "San Francisco",
              country: "US",
              region: "California",
              timezone: "America/Los_Angeles",
            },
          },
        },
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "web_search_options is unsupported");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);
});

test("OpenAI chat verbosity must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-verbosity-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_verbosity",
          content: [{ type: "text", text: "unexpected verbosity upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_verbosity\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        verbosity: "quiet",
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "verbosity must be one of low, medium, high");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const unsupportedClaudeVerbosity = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      verbosity: "low",
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeVerbosity.status, 400);
  assert.equal(unsupportedClaudeVerbosity.body.error.message, "verbosity is unsupported for Claude chat");
  assert.equal(unsupportedClaudeVerbosity.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeVerbosity.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexVerbosity = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      verbosity: "high",
      stream: false,
    },
  });

  assert.equal(codexVerbosity.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.text, { verbosity: "high" });
});

test("OpenAI chat messages must not be empty before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-empty-chat-messages-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_empty_chat",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_empty_chat\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [],
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "messages must contain at least one message");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat message roles must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-chat-role-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_role",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_role\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const messages of [
    [{ content: "hello" }],
    [{ role: "critic", content: "hello" }],
  ]) {
    for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, "messages[0].role is invalid");
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat developer messages stay instructional before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-developer-role-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const url = String(input);
    calls.push({ url, body });
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_developer_role",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_developer_role\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const messages = [
    { role: "developer", content: "be terse" },
    { role: "user", content: "hello" },
  ];

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages,
    },
  });

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(codexResp.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.system, [{ type: "text", text: "be terse" }]);
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(calls[1].body.input[0].role, "developer");
  assert.equal(calls[1].body.input[0].content, "be terse");
  assert.equal(calls[1].body.input[1].role, "user");
  assert.equal(calls[1].body.input[1].content, "hello");
});

test("OpenAI chat message content must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-chat-content-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("anthropic.com")) {
      calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_content",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_content\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const { messages, message } of [
    { messages: [{ role: "user" }], message: "messages[0].content is required" },
    { messages: [{ role: "user", content: { text: "hello" } }], message: "messages[0].content must be a string or array" },
    { messages: [{ role: "user", content: [null] }], message: "messages[0].content[0] must be an object" },
    { messages: [{ role: "user", content: [{ type: "text" }] }], message: "messages[0].content[0].text is required" },
    { messages: [{ role: "user", content: [{ type: "image_url" }] }], message: "messages[0].content[0].image_url.url is required" },
    {
      messages: [{
        role: "system",
        content: [{ type: "image_url", image_url: { url: "https://example.com/system.png" } }],
      }],
      message: "messages[0].content[0].type is unsupported for system messages",
    },
    {
      messages: [{
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: "...", format: "mp3" } }],
      }],
      message: "messages[0].content[0].type is unsupported",
    },
    {
      messages: [{
        role: "user",
        content: [{ type: "file", file: { file_id: "file_123" } }],
      }],
      message: "messages[0].content[0].type is unsupported",
    },
  ]) {
    for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);

  const validImageResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } },
        ],
      }],
    },
  });

  assert.equal(validImageResp.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.messages[0].content, [
    { type: "text", text: "describe this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
  ]);
});

test("OpenAI chat tool messages must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-invalid-chat-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_tools",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_tools\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidCases = [
    {
      messages: [{ role: "tool", content: "result" }],
      message: "messages[0].tool_call_id is required",
    },
    {
      messages: [{
        role: "assistant",
        content: "calling tool",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{bad json" },
        }],
      }],
      message: "messages[0].tool_calls[0].function.arguments must be valid JSON",
    },
    {
      messages: [{ role: "function", content: "result" }],
      message: "messages[0].name is required",
    },
    {
      messages: [{ role: "function", name: "lookup_weather", content: "sunny" }],
      message: "messages[0] has no matching prior assistant function_call",
    },
    {
      messages: [{
        role: "assistant",
        content: null,
        function_call: { name: "lookup_weather", arguments: "{bad json" },
      }],
      message: "messages[0].function_call.arguments must be valid JSON",
    },
  ];

  for (const { messages, message } of invalidCases) {
    for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat stream must be a boolean before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_invalid_stream\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]);
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_stream\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        stream: "false",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "stream must be a boolean");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat n must be 1 before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-n-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_n",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_n\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const n of [2, 0, "1"]) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          n,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, "n must be 1; multiple choices are unsupported");
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat sampling parameters must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-sampling-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_sampling",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_sampling\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      model: "claude-sonnet-4-6",
      body: { temperature: 2 },
      message: "temperature must be a number between 0 and 1",
    },
    {
      model: "claude-sonnet-4-6",
      body: { top_p: 2 },
      message: "top_p must be a number between 0 and 1",
    },
    {
      model: "gpt-5.4",
      body: { temperature: 3 },
      message: "temperature must be a number between 0 and 2",
    },
    {
      model: "gpt-5.4",
      body: { temperature: "0.7" },
      message: "temperature must be a number between 0 and 2",
    },
    {
      model: "gpt-5.4",
      body: { top_p: -0.1 },
      message: "top_p must be a number between 0 and 1",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: invalid.model,
        messages: [{ role: "user", content: "hello" }],
        ...invalid.body,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, invalid.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat prediction must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-prediction-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_prediction",
          content: [{ type: "text", text: "unexpected prediction upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_prediction\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      body: { prediction: "hello" },
      message: "prediction must be an object",
    },
    {
      body: { prediction: { type: "static", content: "hello" } },
      message: "prediction.type must be content",
    },
    {
      body: { prediction: { type: "content", content: [{ type: "text" }] } },
      message: "prediction.content[0].text is required",
    },
    {
      body: { prediction: { type: "content", content: "hello" } },
      message: "prediction is unsupported",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalids) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages: [{ role: "user", content: "hello" }],
          ...invalid.body,
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat logprobs must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-logprobs-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_logprobs",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_logprobs\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      body: { logprobs: "true" },
      message: "logprobs must be a boolean",
    },
    {
      body: { logprobs: true },
      message: "logprobs is unsupported",
    },
    {
      body: { top_logprobs: 21 },
      message: "top_logprobs must be an integer between 0 and 20",
    },
    {
      body: { top_logprobs: 3 },
      message: "top_logprobs is unsupported",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalids) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages: [{ role: "user", content: "hello" }],
          ...invalid.body,
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat penalties must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-penalties-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_penalties",
          content: [{ type: "text", text: "penalty zero accepted" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_penalties\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      body: { presence_penalty: "0.5" },
      message: "presence_penalty must be a number between -2 and 2",
    },
    {
      body: { presence_penalty: 1 },
      message: "presence_penalty is unsupported",
    },
    {
      body: { frequency_penalty: -3 },
      message: "frequency_penalty must be a number between -2 and 2",
    },
    {
      body: { frequency_penalty: 0.5 },
      message: "frequency_penalty is unsupported",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalids) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages: [{ role: "user", content: "hello" }],
          ...invalid.body,
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: false,
      },
    });

    assert.equal(resp.status, 200);
  }

  assert.equal(calls.length, 2);
});

test("OpenAI chat response_format must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-response-format-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_response_format",
          content: [{ type: "text", text: "text response format accepted" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_response_format\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalids = [
    {
      body: { response_format: "json_object" },
      message: "response_format must be an object",
    },
    {
      body: { response_format: { type: "xml" } },
      message: "response_format.type must be one of text, json_object, json_schema",
    },
    {
      body: { response_format: { type: "json_schema" } },
      message: "response_format.json_schema is required",
    },
    {
      body: {
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", schema: "object" },
        },
      },
      message: "response_format.json_schema.schema must be an object",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalids) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages: [{ role: "user", content: "hello" }],
          ...invalid.body,
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);

  for (const response_format of [
    { type: "json_object" },
    {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    },
  ]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        response_format,
        stream: false,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, `response_format ${response_format.type} is unsupported`);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }
  assert.equal(calls.length, 0);

  const textResponses = await Promise.all(
    ["claude-sonnet-4-6", "gpt-5.4"].map((model) => requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model,
        messages: [{ role: "user", content: "hello" }],
        response_format: { type: "text" },
        stream: false,
      },
    }))
  );

  assert.equal(textResponses[0].status, 200);
  assert.equal(textResponses[1].status, 200);
  assert.equal(calls.length, 2);

  const codexJsonObject = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_object" },
      stream: false,
    },
  });

  assert.equal(codexJsonObject.status, 200);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].url.includes("chatgpt.com"));
  assert.deepEqual(calls[2].body.text.format, { type: "json_object" });

  const answerSchema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const codexJsonSchema = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          description: "Answer payload",
          schema: answerSchema,
          strict: true,
        },
      },
      stream: false,
    },
  });

  assert.equal(codexJsonSchema.status, 200);
  assert.equal(calls.length, 4);
  assert.ok(calls[3].url.includes("chatgpt.com"));
  assert.deepEqual(calls[3].body.text.format, {
    type: "json_schema",
    name: "answer",
    description: "Answer payload",
    schema: answerSchema,
    strict: true,
  });
});

test("OpenAI chat stop must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-stop-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_stop",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_stop\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const stop of [123, ["END", 123]]) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          stop,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, "stop must be a string or array of strings");
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  assert.equal(calls.length, 0);
});

test("OpenAI chat tools must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-tools-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_tools",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_tools\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidTools = [
    {
      tools: { type: "function", function: { name: "lookup_weather" } },
      message: "tools must be an array",
    },
    {
      tools: [null],
      message: "tools[0] must be an object",
    },
    {
      tools: [{ function: { name: "lookup_weather" } }],
      message: "tools[0].type is invalid",
    },
    {
      tools: [{ type: "function" }],
      message: "tools[0].function is required",
    },
    {
      tools: [{ type: "function", function: { description: "lookup weather" } }],
      message: "tools[0].function.name is required",
    },
    {
      tools: [{ type: "function", function: { name: "lookup_weather", description: 42 } }],
      message: "tools[0].function.description must be a string",
    },
    {
      tools: [{ type: "function", function: { name: "lookup_weather", parameters: "bad" } }],
      message: "tools[0].function.parameters must be an object",
    },
    {
      tools: [{ type: "function", function: { name: "lookup_weather", strict: "true" } }],
      message: "tools[0].function.strict must be a boolean",
    },
    {
      tools: [{ type: "web_search" }],
      message: "tools[0].type is unsupported",
    },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const invalid of invalidTools) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages: [{ role: "user", content: "hello" }],
          tools: invalid.tools,
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalid.message);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  const unsupportedClaudeTool = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "draw a cat" }],
      tools: [{ type: "image_generation" }],
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeTool.status, 400);
  assert.equal(unsupportedClaudeTool.body.error.message, "tools[0].type is unsupported for Claude chat models");
  assert.equal(unsupportedClaudeTool.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeTool.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const unsupportedClaudeCustomTool = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "render this markdown" }],
      tools: [{
        type: "custom",
        custom: {
          name: "render_markdown",
          description: "Render markdown text",
          format: { type: "text" },
        },
      }],
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeCustomTool.status, 400);
  assert.equal(unsupportedClaudeCustomTool.body.error.message, "tools[0].type is unsupported for Claude chat models");
  assert.equal(unsupportedClaudeCustomTool.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeCustomTool.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexCustomTool = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "render this markdown" }],
      tools: [{
        type: "custom",
        custom: {
          name: "render_markdown",
          description: "Render markdown text",
          format: { type: "text" },
        },
      }],
      stream: false,
    },
  });

  assert.equal(codexCustomTool.status, 200);
  assert.equal(calls.length, 1);
});

test("OpenAI chat tool_choice must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-invalid-tool-choice-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_invalid_chat_tool_choice",
          content: [{ type: "text", text: "unexpected upstream call" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_invalid_chat_tool_choice\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidToolChoiceMessage =
    "tool_choice must be one of auto, none, required, a function tool choice, a custom tool choice, or an image_generation tool choice";
  const invalidToolChoices = [
    "sometimes",
    { type: "function" },
    { type: "function", function: { name: "" } },
    { type: "custom" },
    { type: "custom", custom: { name: "" } },
  ];

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    for (const tool_choice of invalidToolChoices) {
      const resp = await requestJson({
        server,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        body: {
          model,
          messages: [{ role: "user", content: "hello" }],
          tool_choice,
          stream: false,
        },
      });

      assert.equal(resp.status, 400);
      assert.equal(resp.body.error.message, invalidToolChoiceMessage);
      assert.equal(resp.body.error.type, "invalid_request_error");
      assert.equal(resp.body.error.code, "invalid_parameter");
    }
  }

  const unsupportedClaudeToolChoice = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "draw a cat" }],
      tool_choice: { type: "image_generation" },
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeToolChoice.status, 400);
  assert.equal(
    unsupportedClaudeToolChoice.body.error.message,
    "tool_choice image_generation is unsupported for Claude chat models"
  );
  assert.equal(unsupportedClaudeToolChoice.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeToolChoice.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const allowedToolsChoice = {
    type: "allowed_tools",
    allowed_tools: {
      mode: "required",
      tools: [{ type: "function", function: { name: "lookup_weather" } }],
    },
  };
  const unsupportedClaudeAllowedTools = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup_weather" } }],
      tool_choice: allowedToolsChoice,
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeAllowedTools.status, 400);
  assert.equal(
    unsupportedClaudeAllowedTools.body.error.message,
    "tool_choice allowed_tools is unsupported for Claude chat models"
  );
  assert.equal(unsupportedClaudeAllowedTools.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeAllowedTools.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const codexAllowedTools = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }],
      tool_choice: allowedToolsChoice,
      stream: false,
    },
  });

  assert.equal(codexAllowedTools.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chatgpt.com"));
  assert.deepEqual(calls[0].body.tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: "lookup_weather" }],
  });

  const unsupportedClaudeCustomChoice = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "render this markdown" }],
      tool_choice: { type: "custom", custom: { name: "render_markdown" } },
      stream: false,
    },
  });

  assert.equal(unsupportedClaudeCustomChoice.status, 400);
  assert.equal(
    unsupportedClaudeCustomChoice.body.error.message,
    "tool_choice custom is unsupported for Claude chat models"
  );
  assert.equal(unsupportedClaudeCustomChoice.body.error.type, "invalid_request_error");
  assert.equal(unsupportedClaudeCustomChoice.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 1);

  const codexCustomChoice = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "render this markdown" }],
      tools: [{
        type: "custom",
        custom: {
          name: "render_markdown",
          description: "Render markdown text",
          format: { type: "text" },
        },
      }],
      tool_choice: { type: "custom", custom: { name: "render_markdown" } },
      stream: false,
    },
  });

  assert.equal(codexCustomChoice.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.tools, [{
    type: "custom",
    name: "render_markdown",
    description: "Render markdown text",
    format: { type: "text" },
  }]);
  assert.deepEqual(calls[1].body.tool_choice, { type: "custom", name: "render_markdown" });
});

test("proxies a non-stream chat completion through Claude OAuth token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer access-token");

    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "hello from claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.choices[0].message.content, "hello from claude");
  assert.equal(resp.body.usage.total_tokens, 17);
});

test("OpenAI chat legacy functions and function_call route through providers", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-legacy-functions-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_legacy_functions",
          content: [{ type: "text", text: "tool ready" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_legacy_functions\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const parameters = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  };

  const legacyRequest = {
    messages: [{ role: "user", content: "weather in Paris?" }],
    functions: [{
      name: "lookup_weather",
      description: "Look up weather",
      parameters,
    }],
    function_call: { name: "lookup_weather" },
    stream: false,
  };

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      ...legacyRequest,
      model: "claude-sonnet-4-6",
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.deepEqual(calls[0].body.tools, [{
    name: "lookup_weather",
    description: "Look up weather",
    input_schema: parameters,
    cache_control: { type: "ephemeral" },
  }]);
  assert.deepEqual(calls[0].body.tool_choice, { type: "tool", name: "lookup_weather" });

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      ...legacyRequest,
      model: "gpt-5.4",
    },
  });

  assert.equal(codexResp.status, 200);
  assert.deepEqual(calls[1].body.tools, [{
    type: "function",
    name: "lookup_weather",
    description: "Look up weather",
    parameters,
    strict: false,
  }]);
  assert.deepEqual(calls[1].body.tool_choice, { type: "function", name: "lookup_weather" });
});

test("OpenAI chat legacy functions return legacy function_call responses", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-legacy-function-response-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_legacy_function_response",
          content: [{
            type: "tool_use",
            id: "toolu_weather_1",
            name: "lookup_weather",
            input: { city: "Paris" },
          }],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_legacy_function_response\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_weather_1\",\"name\":\"lookup_weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const legacyRequest = {
    messages: [{ role: "user", content: "weather in Paris?" }],
    functions: [{
      name: "lookup_weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    }],
    stream: false,
  };

  for (const model of ["claude-sonnet-4-6", "gpt-5.4"]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: { ...legacyRequest, model },
    });

    assert.equal(resp.status, 200);
    assert.deepEqual(resp.body.choices[0].message.function_call, {
      name: "lookup_weather",
      arguments: "{\"city\":\"Paris\"}",
    });
    assert.equal(resp.body.choices[0].message.tool_calls, undefined);
    assert.equal(resp.body.choices[0].finish_reason, "function_call");
  }
});

test("OpenAI chat legacy function call messages route through providers", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-chat-legacy-function-messages-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_chat_legacy_function_messages",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_chat_legacy_function_messages\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const legacyMessages = [
    { role: "user", content: "weather in Paris?" },
    {
      role: "assistant",
      content: null,
      function_call: { name: "lookup_weather", arguments: "{\"city\":\"Paris\"}" },
    },
    { role: "function", name: "lookup_weather", content: "sunny" },
    { role: "user", content: "thanks" },
  ];

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: legacyMessages,
      stream: false,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.deepEqual(calls[0].body.messages, [
    { role: "user", content: "weather in Paris?" },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "call_legacy_1_lookup_weather",
        name: "lookup_weather",
        input: { city: "Paris" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call_legacy_1_lookup_weather",
        content: "sunny",
      }],
    },
    { role: "user", content: "thanks" },
  ]);

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: legacyMessages,
      stream: false,
    },
  });

  assert.equal(codexResp.status, 200);
  assert.deepEqual(calls[1].body.input, [
    { role: "user", content: "weather in Paris?" },
    {
      type: "function_call",
      call_id: "call_legacy_1_lookup_weather",
      name: "lookup_weather",
      arguments: "{\"city\":\"Paris\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_legacy_1_lookup_weather",
      output: "sunny",
    },
    { role: "user", content: "thanks" },
  ]);
});

test("routes OpenAI responses requests to Codex based on model", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, CODEX_RESPONSES_URL);
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer codex-access-token");

    const parsedBody = JSON.parse(String(init?.body || "{}"));
    assert.equal(parsedBody.model, "gpt-5.4");
    assert.equal(parsedBody.input[0].content, "hello codex");

    return new Response(
      JSON.stringify({
        id: "resp_codex",
        object: "response",
        model: "gpt-5.4",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from codex" }],
          },
        ],
        usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello codex" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "response");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.output[0].content[0].text, "hello from codex");
  assert.equal(resp.body.usage.total_tokens, 11);
});

test("routes OpenAI responses string input to Claude as a user message", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.method, "POST");

    const parsedBody = JSON.parse(String(init?.body || "{}"));
    calls.push({ body: parsedBody });

    return new Response(
      JSON.stringify({
        id: "msg_resp_string",
        content: [{ type: "text", text: "hello from claude responses" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello claude responses",
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.messages, [{ role: "user", content: "hello claude responses" }]);
  assert.equal(resp.body.object, "response");
});

test("OpenAI responses developer input stays instructional before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-developer-role-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const parsedBody = JSON.parse(String(init?.body || "{}"));
    calls.push({ url, body: parsedBody });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_responses_developer_role",
          content: [{ type: "text", text: "hello from claude developer" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_responses_developer_role\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const input = [
    { role: "developer", content: "be terse" },
    { role: "user", content: "hello" },
  ];

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input,
      stream: false,
    },
  });
  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input,
      stream: false,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(codexResp.status, 200);
  assert.deepEqual(calls[0]?.body.system, [{ type: "text", text: "be terse" }]);
  assert.deepEqual(calls[0]?.body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(calls[1]?.body.input[0].role, "developer");
  assert.equal(calls[1]?.body.input[0].content, "be terse");
  assert.equal(calls[1]?.body.input[1].role, "user");
  assert.equal(calls[1]?.body.input[1].content, "hello");
});

test("routes OpenAI responses image content parts to Claude without dropping image_url strings", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-image-part-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    const parsedBody = JSON.parse(String(init?.body || "{}"));
    calls.push({ body: parsedBody });

    return new Response(
      JSON.stringify({
        id: "msg_resp_image_part",
        content: [{ type: "text", text: "hello from claude image" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const imageUrl = "https://example.com/cat.png";
  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "what is in this image?" },
          { type: "input_image", image_url: imageUrl },
        ],
      }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.messages, [{
    role: "user",
    content: [
      { type: "text", text: "what is in this image?" },
      { type: "image", source: { type: "url", url: imageUrl } },
    ],
  }]);
});

test("routes OpenAI responses function tool_choice without losing tool name", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-responses-tool-choice-name-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const parsedBody = JSON.parse(String(init?.body || "{}"));
    calls.push({ url, body: parsedBody });

    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_resp_tool_choice",
          content: [{ type: "text", text: "hello from claude tool choice" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return makeSseResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_tool_choice\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const body = {
    input: "weather please",
    tools: [{
      type: "function",
      name: "lookup_weather",
      description: "Look up weather",
      parameters: { type: "object", properties: {} },
    }],
    tool_choice: { type: "function", name: "lookup_weather" },
    stream: false,
  };

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      ...body,
    },
  });
  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      ...body,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(codexResp.status, 200);
  assert.deepEqual(calls[0]?.body.tool_choice, { type: "tool", name: "lookup_weather" });
  assert.deepEqual(calls[1]?.body.tool_choice, { type: "function", name: "lookup_weather" });
});

test("routes OpenAI chat completions requests to Codex based on model", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, CODEX_RESPONSES_URL);
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer codex-access-token");

    const parsedBody = JSON.parse(String(init?.body || "{}"));
    assert.equal(parsedBody.model, "gpt-5.4");
    assert.equal(parsedBody.input[0].content, "hello from codex chat");

    return new Response(
      JSON.stringify({
        id: "resp_codex_chat",
        object: "response",
        model: "gpt-5.4",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from codex chat" }],
          },
        ],
        usage: { input_tokens: 6, output_tokens: 5, total_tokens: 11 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello from codex chat" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.choices[0].message.content, "hello from codex chat");
  assert.equal(resp.body.usage.total_tokens, 11);
});

test("proxies OpenAI image generations through Codex image generation", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any; auth?: string; accept?: string }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string>;
    const parsedBody = JSON.parse(String(init?.body || "{}"));
    calls.push({
      url,
      body: parsedBody,
      auth: headers.Authorization,
      accept: headers.Accept,
    });

    return makeSseResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_img\",\"model\":\"gpt-image-2\",\"status\":\"in_progress\"}}\n\n",
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":2,\"item\":{\"id\":\"ig_1\",\"type\":\"image_generation_call\",\"status\":\"in_progress\"},\"output_index\":0}\n\n",
      "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"sequence_number\":3,\"item_id\":\"ig_1\",\"output_format\":\"png\",\"partial_image_b64\":\"iVBORw0KGgo=\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":4,\"response\":{\"id\":\"resp_img\",\"model\":\"gpt-image-2\",\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1,\"total_tokens\":11}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":5}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-image-2",
      prompt: "A tiny blue icon on a white background",
      size: "1024x1024",
      quality: "high",
      response_format: "b64_json",
      n: 1,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CODEX_RESPONSES_URL);
  assert.equal(calls[0].auth, "Bearer codex-access-token");
  assert.equal(calls[0].accept, "text/event-stream");
  assert.deepEqual(calls[0].body, {
    model: "gpt-5.5",
    instructions: "",
    store: false,
    input: [{ role: "user", content: "A tiny blue icon on a white background" }],
    tools: [{ type: "image_generation", size: "1024x1024", quality: "high" }],
    stream: true,
  });
  assert.equal(resp.body.created > 0, true);
  assert.deepEqual(resp.body.data, [{ b64_json: "iVBORw0KGgo=", revised_prompt: "A tiny blue icon on a white background" }]);
});

test("OpenAI image generation params must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-image-params-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const calls: any[] = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({ input, init });
    throw new Error("Upstream should not be called for invalid image generation parameters");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    {
      body: { response_format: "json" },
      message: "response_format must be one of b64_json, url",
    },
    {
      body: { background: "transparent" },
      message: "background transparent is unsupported for gpt-image-2",
    },
    {
      body: { output_format: "png", output_compression: 80 },
      message: "output_compression is only supported for jpeg or webp output_format",
    },
    {
      body: { stream: true },
      message: "stream is unsupported for /v1/images/generations",
    },
    {
      body: { user: 42 },
      message: "user must be a string",
    },
  ];

  for (const item of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/images/generations",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-image-2",
        prompt: "A tiny blue icon on a white background",
        ...item.body,
      },
    });

    assert.equal(resp.status, 400, item.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.message, item.message);
  }
  assert.equal(calls.length, 0);
});

test("retries a transient Codex image generation network failure", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  let attempts = 0;
  const restoreFetch = withMockedFetch(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError("fetch failed");
    }

    return makeSseResponse([
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":1,\"item\":{\"id\":\"ig_retry\",\"type\":\"image_generation_call\",\"status\":\"in_progress\"},\"output_index\":0}\n\n",
      "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"sequence_number\":2,\"item_id\":\"ig_retry\",\"output_format\":\"png\",\"partial_image_b64\":\"iVBORw0KGgo=\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_retry\",\"model\":\"gpt-image-2\",\"status\":\"completed\"}}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-image-2",
      prompt: "A tiny blue icon on a white background",
      size: "1024x1024",
      response_format: "b64_json",
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(resp.body.data, [{ b64_json: "iVBORw0KGgo=", revised_prompt: "A tiny blue icon on a white background" }]);
});

test("retries Codex image generation with refreshed auth after upstream 401", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir, "stale-codex-token");
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ auth?: string }> = [];
  const restoreFetch = withMockedFetch(async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ auth: headers.Authorization });

    if (calls.length === 1) {
      writeCodexAuth(authDir, "fresh-codex-token");
      return new Response("unauthorized", { status: 401 });
    }

    return makeSseResponse([
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":1,\"item\":{\"id\":\"ig_refresh\",\"type\":\"image_generation_call\",\"status\":\"in_progress\"},\"output_index\":0}\n\n",
      "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"sequence_number\":2,\"item_id\":\"ig_refresh\",\"output_format\":\"png\",\"partial_image_b64\":\"iVBORw0KGgo=\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_refresh\",\"model\":\"gpt-image-2\",\"status\":\"completed\"}}\n\n",
    ]);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-image-2",
      prompt: "A tiny blue icon on a white background",
      response_format: "b64_json",
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls.map((call) => call.auth), [
    "Bearer stale-codex-token",
    "Bearer fresh-codex-token",
  ]);
  assert.deepEqual(resp.body.data, [{ b64_json: "iVBORw0KGgo=", revised_prompt: "A tiny blue icon on a white background" }]);
});

test("refreshes the OAuth token after an upstream 401 and retries successfully", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: string[] = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      const authHeader = (init?.headers as Record<string, string>).Authorization;
      if (authHeader === "Bearer access-token") {
        return new Response("unauthorized", { status: 401 });
      }
      if (authHeader === "Bearer refreshed-access-token") {
        return new Response(
          JSON.stringify({
            id: "msg_after_refresh",
            content: [{ type: "text", text: "refreshed ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access-token",
          refresh_token: "refreshed-refresh-token",
          expires_in: 3600,
          account: { email_address: "test@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "refresh me" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "refreshed ok");
  assert.deepEqual(calls, [
    "https://api.anthropic.com/v1/messages?beta=true",
    TOKEN_URL,
    "https://api.anthropic.com/v1/messages?beta=true",
  ]);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.accounts[0].lastRefreshAt !== null, true);
  assert.equal(adminResp.body.accounts[0].totalSuccesses, 1);
});

test("Claude upstream 401 records auth failure when refresh fails", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-401-refresh-fail-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: string[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return new Response("unauthorized", { status: 401 });
    }

    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "refresh will fail" }],
    },
  });

  assert.equal(resp.status, 401);
  assert.equal(resp.body.error.code, "upstream_auth_error");
  assert.deepEqual(calls, [
    "https://api.anthropic.com/v1/messages?beta=true",
    TOKEN_URL,
  ]);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.accounts[0].available, false);
  assert.equal(adminResp.body.accounts[0].failureCount, 1);
  assert.equal(adminResp.body.accounts[0].totalFailures, 1);
  assert.equal(adminResp.body.accounts[0].lastError, "auth");
});

test("Claude upstream invalid JSON returns upstream invalid response error", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-invalid-json-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "bad upstream json" }],
    },
  });

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream returned invalid JSON");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_invalid_response");

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.accounts[0].failureCount, 1);
  assert.equal(adminResp.body.accounts[0].totalFailures, 1);
  assert.equal(adminResp.body.accounts[0].lastError, "server: invalid JSON response");
});

test("Claude chat stream records failure when upstream stream ends before completion", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-chat-truncated-stream-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_truncated_chat\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "stream then truncate" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.accounts[0].totalSuccesses, 0);
  assert.equal(adminResp.body.accounts[0].failureCount, 1);
  assert.equal(adminResp.body.accounts[0].totalFailures, 1);
  assert.equal(adminResp.body.accounts[0].lastError, "network: stream terminated before completion");

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "network_error");
  assert.equal(recentResp.body.items[0].failureContext.message, "Upstream stream ended before completion");
});

test("Claude responses stream records failure when upstream stream ends before completion", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-responses-truncated-stream-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_truncated_responses\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      input: "stream then truncate",
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.accounts[0].totalSuccesses, 0);
  assert.equal(adminResp.body.accounts[0].failureCount, 1);
  assert.equal(adminResp.body.accounts[0].totalFailures, 1);
  assert.equal(adminResp.body.accounts[0].lastError, "network: stream terminated before completion");

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "network_error");
  assert.equal(recentResp.body.items[0].failureContext.message, "Upstream stream ended before completion");
});

test("Codex chat stream records failure when upstream stream ends before completion", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-truncated-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_chat_truncated\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"partial\"}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream then truncate" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "network_error");
  assert.equal(recentResp.body.items[0].failureContext.message, "Upstream stream ended before completion");
});

test("Codex chat stream records upstream SSE error events", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-sse-error-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: error\ndata: {\"type\":\"error\",\"sequence_number\":1,\"code\":\"rate_limit_exceeded\",\"message\":\"Upstream quota exhausted\",\"param\":null}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream then upstream error" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "rate_limit");
  assert.equal(recentResp.body.items[0].failureContext.message, "Upstream quota exhausted");
  assert.equal(recentResp.body.items[0].failureContext.upstreamStatus, 502);
});

test("Codex chat stream treats response.incomplete as a terminal event", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-incomplete-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_chat_incomplete\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"partial\"}\n\n",
        "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"sequence_number\":3,\"response\":{\"id\":\"resp_codex_chat_incomplete\",\"model\":\"gpt-5.4\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream to incomplete" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /\"finish_reason\":\"length\"/);
  assert.match(resp.body, /data: \[DONE\]/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("Codex chat stream records response.failed events", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-failed-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.failed\ndata: {\"type\":\"response.failed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_chat_failed\",\"model\":\"gpt-5.4\",\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"Model execution failed\"}}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream to failed" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "upstream_error");
  assert.equal(recentResp.body.items[0].failureContext.message, "Model execution failed");
  assert.equal(recentResp.body.items[0].failureContext.upstreamStatus, 502);
});

test("Codex chat stream treats response.completed as a terminal event", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-completed-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_chat_completed\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"complete\"}\n\n",
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_codex_chat_completed\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream to completed" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /data: \[DONE\]/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("Codex chat stream emits response.output_text.done text without deltas", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-output-text-done-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_chat_output_text_done\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"sequence_number\":2,\"text\":\"final text from done\"}\n\n",
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_codex_chat_output_text_done\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "stream to output_text.done" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /"content":"final text from done"/);
  assert.match(resp.body, /data: \[DONE\]/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("Codex responses stream records failure when upstream stream ends before completion", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-truncated-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_responses_truncated\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"partial\"}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "stream then truncate",
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "network_error");
  assert.equal(recentResp.body.items[0].failureContext.message, "Upstream stream ended before completion");
});

test("Codex responses stream records upstream SSE error events", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-sse-error-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: error\ndata: {\"type\":\"error\",\"sequence_number\":1,\"code\":\"rate_limit_exceeded\",\"message\":\"Upstream quota exhausted\",\"param\":null}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "stream then upstream error",
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /event: error/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "rate_limit");
  assert.equal(recentResp.body.items[0].failureContext.message, "Upstream quota exhausted");
  assert.equal(recentResp.body.items[0].failureContext.upstreamStatus, 502);
});

test("Codex responses stream treats response.incomplete as a terminal event", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-incomplete-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_responses_incomplete\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"partial\"}\n\n",
        "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"sequence_number\":3,\"response\":{\"id\":\"resp_codex_responses_incomplete\",\"model\":\"gpt-5.4\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "stream to incomplete",
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /event: response.incomplete/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("Codex responses stream records response.failed events", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-failed-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.failed\ndata: {\"type\":\"response.failed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_responses_failed\",\"model\":\"gpt-5.4\",\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"Model execution failed\"}}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "stream to failed",
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /event: response.failed/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "upstream_error");
  assert.equal(recentResp.body.items[0].failureContext.message, "Model execution failed");
  assert.equal(recentResp.body.items[0].failureContext.upstreamStatus, 502);
});

test("Codex responses stream treats response.completed as a terminal event", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-completed-stream-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === CODEX_RESPONSES_URL) {
      return makeSseResponse([
        "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_codex_responses_completed\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"complete\"}\n\n",
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_codex_responses_completed\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "stream to completed",
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /event: response.completed/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("Claude chat stream preserves event names across read chunks", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-chat-split-event-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url.includes("anthropic.com/v1/messages")) {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_split_chat\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":2,\"output_tokens\":0}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "split event" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /data: \[DONE\]/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("Claude responses stream preserves event names across read chunks", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-responses-split-event-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url.includes("anthropic.com/v1/messages")) {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_split_responses\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":2,\"output_tokens\":0}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "split event",
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /event: response.completed/);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/responses");
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("returns rate limited when the configured account is cooled down", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "rate_limit", "forced for smoke test");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called while the configured account is cooled down");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 429);
  assert.equal(resp.body.error.message, "Rate limited on the configured account");
  assert.equal(resp.body.error.type, "rate_limit_error");
  assert.equal(resp.body.error.code, "account_rate_limited");
});

test("Claude proxy missing account errors return OpenAI-style JSON", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-missing-account-"));
  const manager = makeManager(authDir, []);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const chat = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(chat.status, 503);
  assert.equal(chat.body.error.message, "No available account");
  assert.equal(chat.body.error.type, "api_error");
  assert.equal(chat.body.error.code, "no_available_account");

  const responses = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
    },
  });

  assert.equal(responses.status, 503);
  assert.equal(responses.body.error.message, "No available account");
  assert.equal(responses.body.error.type, "api_error");
  assert.equal(responses.body.error.code, "no_available_account");
});

test("Claude proxy expired account errors return OpenAI-style JSON without upstream calls", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-expired-account-"));
  const manager = makeManager(authDir, [
    makeToken({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  ]);
  let upstreamCalls = 0;
  const restoreFetch = withMockedFetch(async () => {
    upstreamCalls++;
    return new Response("{}", { status: 200 });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const chat = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(chat.status, 503);
  assert.equal(chat.body.error.type, "api_error");
  assert.equal(chat.body.error.code, "account_token_expired");

  const responses = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
    },
  });

  assert.equal(responses.status, 503);
  assert.equal(responses.body.error.type, "api_error");
  assert.equal(responses.body.error.code, "account_token_expired");
  assert.equal(upstreamCalls, 0);
});

test("Claude proxy upstream network errors return OpenAI-style JSON", async (t) => {
  const chatAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-chat-network-"));
  const responsesAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-responses-network-"));
  const chatManager = makeManager(chatAuthDir, [makeToken()]);
  const responsesManager = makeManager(responsesAuthDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async () => {
    throw new TypeError("fetch failed");
  });
  const chatServer = await startApp(makeConfig(chatAuthDir), chatManager);
  const responsesServer = await startApp(makeConfig(responsesAuthDir), responsesManager);

  t.after(async () => {
    restoreFetch();
    await stopApp(chatServer);
    await stopApp(responsesServer);
    fs.rmSync(chatAuthDir, { recursive: true, force: true });
    fs.rmSync(responsesAuthDir, { recursive: true, force: true });
  });

  const chat = await requestJson({
    server: chatServer,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(chat.status, 502);
  assert.equal(chat.body.error.message, "Upstream network error");
  assert.equal(chat.body.error.type, "api_error");
  assert.equal(chat.body.error.code, "upstream_network_error");

  const responses = await requestJson({
    server: responsesServer,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      input: "hello",
    },
  });

  assert.equal(responses.status, 502);
  assert.equal(responses.body.error.message, "Upstream network error");
  assert.equal(responses.body.error.type, "api_error");
  assert.equal(responses.body.error.code, "upstream_network_error");
});

test("Claude native passthrough errors return OpenAI-style JSON", async (t) => {
  const validationAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-validation-"));
  const missingAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-missing-"));
  const cooldownAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-cooldown-"));
  const validationManager = makeManager(validationAuthDir, [makeToken()]);
  const missingManager = makeManager(missingAuthDir, []);
  const cooldownManager = makeManager(cooldownAuthDir, [makeToken()]);
  cooldownManager.recordFailure("test@example.com", "rate_limit", "forced for native smoke test");
  const validationServer = await startApp(makeConfig(validationAuthDir), validationManager);
  const missingServer = await startApp(makeConfig(missingAuthDir), missingManager);
  const cooldownServer = await startApp(makeConfig(cooldownAuthDir), cooldownManager);

  t.after(async () => {
    await stopApp(validationServer);
    await stopApp(missingServer);
    await stopApp(cooldownServer);
    fs.rmSync(validationAuthDir, { recursive: true, force: true });
    fs.rmSync(missingAuthDir, { recursive: true, force: true });
    fs.rmSync(cooldownAuthDir, { recursive: true, force: true });
  });

  const validation = await requestJson({
    server: validationServer,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: { model: "claude-sonnet-4-6" },
  });

  assert.equal(validation.status, 400);
  assert.equal(validation.body.error.message, "messages is required");
  assert.equal(validation.body.error.type, "invalid_request_error");
  assert.equal(validation.body.error.code, "missing_required_parameter");

  const missingMessages = await requestJson({
    server: missingServer,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(missingMessages.status, 503);
  assert.equal(missingMessages.body.error.message, "No available account");
  assert.equal(missingMessages.body.error.type, "api_error");
  assert.equal(missingMessages.body.error.code, "no_available_account");

  const missingCount = await requestJson({
    server: missingServer,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(missingCount.status, 503);
  assert.equal(missingCount.body.error.message, "No available account");
  assert.equal(missingCount.body.error.type, "api_error");
  assert.equal(missingCount.body.error.code, "no_available_account");

  const cooldownCount = await requestJson({
    server: cooldownServer,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(cooldownCount.status, 429);
  assert.equal(cooldownCount.body.error.message, "Rate limited on the configured account");
  assert.equal(cooldownCount.body.error.type, "rate_limit_error");
  assert.equal(cooldownCount.body.error.code, "account_rate_limited");
});

test("Claude native passthrough requires messages arrays before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-messages-validation-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidMessages = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: "hello",
    },
  });

  assert.equal(invalidMessages.status, 400);
  assert.equal(invalidMessages.body.error.message, "messages must be an array");
  assert.equal(invalidMessages.body.error.type, "invalid_request_error");
  assert.equal(invalidMessages.body.error.code, "invalid_parameter");

  const missingCountMessages = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
    },
  });

  assert.equal(missingCountMessages.status, 400);
  assert.equal(missingCountMessages.body.error.message, "messages is required");
  assert.equal(missingCountMessages.body.error.type, "invalid_request_error");
  assert.equal(missingCountMessages.body.error.code, "missing_required_parameter");

  const invalidCountMessages = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: "hello",
    },
  });

  assert.equal(invalidCountMessages.status, 400);
  assert.equal(invalidCountMessages.body.error.message, "messages must be an array");
  assert.equal(invalidCountMessages.body.error.type, "invalid_request_error");
  assert.equal(invalidCountMessages.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);
});

test("Claude native passthrough messages arrays must not be empty before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-empty-messages-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const emptyMessages = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [],
    },
  });

  assert.equal(emptyMessages.status, 400);
  assert.equal(emptyMessages.body.error.message, "messages must contain at least one message");
  assert.equal(emptyMessages.body.error.type, "invalid_request_error");
  assert.equal(emptyMessages.body.error.code, "invalid_parameter");

  const emptyCountMessages = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [],
    },
  });

  assert.equal(emptyCountMessages.status, 400);
  assert.equal(emptyCountMessages.body.error.message, "messages must contain at least one message");
  assert.equal(emptyCountMessages.body.error.type, "invalid_request_error");
  assert.equal(emptyCountMessages.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);
});

test("Claude native passthrough message items must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-message-items-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    {
      body: { messages: [null] },
      message: "messages[0] must be an object",
    },
    {
      body: { messages: [{ role: "system", content: "hello" }] },
      message: "messages[0].role must be one of user, assistant",
    },
    {
      body: { messages: [{ role: "user" }] },
      message: "messages[0].content is required",
    },
    {
      body: { messages: [{ role: "user", content: [{ type: "text", text: "" }] }] },
      message: "messages[0].content[0].text must be a non-empty string",
    },
    {
      body: { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", input: {} }] }] },
      message: "messages[0].content[0].name must be a non-empty string",
    },
    {
      body: { messages: [{ role: "user", content: [{ type: "tool_result", content: "ok" }] }] },
      message: "messages[0].content[0].tool_use_id must be a non-empty string",
    },
  ];

  for (const item of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/messages",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        ...item.body,
      },
    });

    assert.equal(resp.status, 400, item.message);
    assert.equal(resp.body.error.message, item.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  const countTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "text" }] }],
    },
  });

  assert.equal(countTokens.status, 400);
  assert.equal(countTokens.body.error.message, "messages[0].content[0].text must be a non-empty string");
  assert.equal(countTokens.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);
});

test("Claude native passthrough requires model before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-missing-model-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const missingMessagesModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(missingMessagesModel.status, 400);
  assert.equal(missingMessagesModel.body.error.message, "model is required");
  assert.equal(missingMessagesModel.body.error.type, "invalid_request_error");
  assert.equal(missingMessagesModel.body.error.code, "missing_required_parameter");

  const missingCountModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(missingCountModel.status, 400);
  assert.equal(missingCountModel.body.error.message, "model is required");
  assert.equal(missingCountModel.body.error.type, "invalid_request_error");
  assert.equal(missingCountModel.body.error.code, "missing_required_parameter");
  assert.equal(calls.length, 0);
});

test("Claude native passthrough model must be a non-empty string before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-invalid-model-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidMessagesModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: 123,
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(invalidMessagesModel.status, 400);
  assert.equal(invalidMessagesModel.body.error.message, "model must be a non-empty string");
  assert.equal(invalidMessagesModel.body.error.type, "invalid_request_error");
  assert.equal(invalidMessagesModel.body.error.code, "invalid_parameter");

  const invalidCountModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: { id: "claude-sonnet-4-6" },
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(invalidCountModel.status, 400);
  assert.equal(invalidCountModel.body.error.message, "model must be a non-empty string");
  assert.equal(invalidCountModel.body.error.type, "invalid_request_error");
  assert.equal(invalidCountModel.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);
});

test("Claude native messages requires max_tokens before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-missing-max-tokens-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const missingMaxTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(missingMaxTokens.status, 400);
  assert.equal(missingMaxTokens.body.error.message, "max_tokens is required");
  assert.equal(missingMaxTokens.body.error.type, "invalid_request_error");
  assert.equal(missingMaxTokens.body.error.code, "missing_required_parameter");
  assert.equal(calls.length, 0);
});

test("Claude native messages max_tokens must be a positive integer before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-invalid-max-tokens-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const maxTokens of ["32", 0, 1.5]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/messages",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "max_tokens must be a positive integer");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("Claude native messages stream must be a boolean before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-invalid-stream-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: unknown[] = [];
  const restoreFetch = withMockedFetch(async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const stream of ["false", 1]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/messages",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        stream,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "stream must be a boolean");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(calls.length, 0);
});

test("Claude native messages stream records failure when upstream stream ends before completion", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-truncated-stream-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_native_truncated\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "stream then truncate" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.accounts[0].totalSuccesses, 0);
  assert.equal(adminResp.body.accounts[0].failureCount, 1);
  assert.equal(adminResp.body.accounts[0].totalFailures, 1);
  assert.equal(adminResp.body.accounts[0].lastError, "network: stream terminated before completion");

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/messages");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, false);
  assert.equal(recentResp.body.items[0].failureContext.kind, "network_error");
  assert.equal(recentResp.body.items[0].failureContext.message, "Upstream stream ended before completion");
});

test("Claude native messages stream records success when upstream stream completes", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-complete-stream-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return makeSseResponse([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_native_complete\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "complete stream" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.accounts[0].totalSuccesses, 1);
  assert.equal(adminResp.body.accounts[0].failureCount, 0);
  assert.equal(adminResp.body.accounts[0].totalFailures, 0);

  const recentResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(recentResp.status, 200);
  assert.equal(recentResp.body.items[0].endpoint, "POST /v1/messages");
  assert.equal(recentResp.body.items[0].statusCode, 200);
  assert.equal(recentResp.body.items[0].success, true);
  assert.equal(recentResp.body.items[0].failureContext, null);
});

test("Claude native count_tokens stream must be disabled before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-count-stream-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ input_tokens: 12 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const invalidType = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      stream: "false",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(invalidType.status, 400);
  assert.equal(invalidType.body.error.message, "stream must be a boolean");
  assert.equal(invalidType.body.error.type, "invalid_request_error");
  assert.equal(invalidType.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const enabled = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(enabled.status, 400);
  assert.equal(enabled.body.error.message, "stream is unsupported for count_tokens");
  assert.equal(enabled.body.error.type, "invalid_request_error");
  assert.equal(enabled.body.error.code, "invalid_parameter");
  assert.equal(calls.length, 0);

  const disabled = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.input_tokens, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages/count_tokens?beta=true");
  assert.equal("stream" in calls[0].body, false);
});

test("Claude native count_tokens applies cloaking before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-count-cloaking-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ body: any }> = [];
  const restoreFetch = withMockedFetch(async (_input, init) => {
    calls.push({ body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ input_tokens: 42 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const config = {
    ...makeConfig(authDir),
    cloaking: {
      mode: "always",
      "strict-mode": false,
      "sensitive-words": [],
      "cache-user-id": true,
    },
  } as Config;
  const server = await startApp(config, manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: {
      Authorization: "Bearer test-key",
      "User-Agent": "openai-sdk-node",
    },
    body: {
      model: "claude-sonnet-4-6",
      system: "client system",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.input_tokens, 42);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.system[0].text, /^x-anthropic-billing-header: cc_version=/);
  assert.equal(calls[0].body.system[1].text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.deepEqual(calls[0].body.system[2], {
    type: "text",
    text: "client system",
    cache_control: { type: "ephemeral" },
  });
  assert.equal(typeof calls[0].body.metadata.user_id, "string");
  assert.match(calls[0].body.metadata.user_id, /^user_/);
});

test("Claude native passthrough top-level params must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-top-level-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    {
      body: { temperature: "0.7" },
      message: "temperature must be a number between 0 and 1",
    },
    {
      body: { top_p: 2 },
      message: "top_p must be a number between 0 and 1",
    },
    {
      body: { top_k: "10" },
      message: "top_k must be a positive integer",
    },
    {
      body: { stop_sequences: "stop" },
      message: "stop_sequences must be an array of strings",
    },
    {
      body: { metadata: "tenant" },
      message: "metadata must be an object",
    },
    {
      body: { tool_choice: "auto" },
      message: "tool_choice must be an object",
    },
    {
      body: { tool_choice: { type: "tool" } },
      message: "tool_choice.name must be a non-empty string",
    },
    {
      body: { thinking: { type: "enabled" } },
      message: "thinking.budget_tokens must be a positive integer",
    },
  ];

  for (const item of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/messages",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
        ...item.body,
      },
    });

    assert.equal(resp.status, 400, item.message);
    assert.equal(resp.body.error.message, item.message);
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  const invalidCountTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      stop_sequences: "stop",
    },
  });

  assert.equal(invalidCountTokens.status, 400);
  assert.equal(invalidCountTokens.body.error.message, "stop_sequences must be an array of strings");
  assert.equal(calls.length, 0);

  const valid = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["END"],
      metadata: { user_id: "user_42" },
      tool_choice: { type: "tool", name: "lookup_weather" },
      thinking: { type: "enabled", budget_tokens: 1024 },
    },
  });

  assert.equal(valid.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.temperature, 0.7);
  assert.deepEqual(calls[0].body.top_p, 0.9);
  assert.deepEqual(calls[0].body.top_k, 40);
  assert.deepEqual(calls[0].body.stop_sequences, ["END"]);
  assert.deepEqual(calls[0].body.metadata, { user_id: "user_42" });
  assert.deepEqual(calls[0].body.tool_choice, { type: "tool", name: "lookup_weather" });
  assert.deepEqual(calls[0].body.thinking, { type: "enabled", budget_tokens: 1024 });
});

test("Claude native passthrough tools must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-tools-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    {
      body: { tools: "lookup" },
      message: "tools must be an array",
    },
    {
      body: { tools: [null] },
      message: "tools[0] must be an object",
    },
    {
      body: { tools: [{}] },
      message: "tools[0].name or tools[0].type is required",
    },
    {
      body: { tools: [{ name: "", input_schema: {} }] },
      message: "tools[0].name must be a non-empty string",
    },
    {
      body: { tools: [{ name: "lookup_weather", input_schema: "schema" }] },
      message: "tools[0].input_schema must be an object",
    },
    {
      body: { tools: [{ type: "" }] },
      message: "tools[0].type must be a non-empty string",
    },
  ];

  for (const item of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/messages",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
        ...item.body,
      },
    });

    assert.equal(resp.status, 400, item.message);
    assert.equal(resp.body.error.message, item.message);
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  const invalidCountTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      tools: "lookup",
    },
  });

  assert.equal(invalidCountTokens.status, 400);
  assert.equal(invalidCountTokens.body.error.message, "tools must be an array");
  assert.equal(calls.length, 0);

  const validTools = [
    {
      name: "lookup_weather",
      description: "Lookup weather",
      input_schema: { type: "object", properties: {} },
    },
    {
      type: "web_search_20250305",
      name: "web_search",
    },
  ];
  const valid = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      tools: validTools,
    },
  });

  assert.equal(valid.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.tools, validTools);
});

test("Claude native passthrough system must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-system-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    {
      body: { system: 123 },
      message: "system must be a non-empty string or array",
    },
    {
      body: { system: "" },
      message: "system must be a non-empty string",
    },
    {
      body: { system: [] },
      message: "system must contain at least one text block",
    },
    {
      body: { system: [null] },
      message: "system[0] must be an object",
    },
    {
      body: { system: [{ type: "image", source: { type: "base64", data: "abc" } }] },
      message: "system[0].type must be text",
    },
    {
      body: { system: [{ type: "text" }] },
      message: "system[0].text must be a non-empty string",
    },
  ];

  for (const item of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/messages",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
        ...item.body,
      },
    });

    assert.equal(resp.status, 400, item.message);
    assert.equal(resp.body.error.message, item.message);
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  const invalidCountTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      system: 123,
    },
  });

  assert.equal(invalidCountTokens.status, 400);
  assert.equal(invalidCountTokens.body.error.message, "system must be a non-empty string or array");
  assert.equal(calls.length, 0);

  const systemBlocks = [
    {
      type: "text",
      text: "Answer tersely.",
      cache_control: { type: "ephemeral" },
    },
  ];

  const validString = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      system: "Be brief.",
    },
  });
  const validBlocks = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      system: systemBlocks,
    },
  });

  assert.equal(validString.status, 200);
  assert.equal(validBlocks.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.system, "Be brief.");
  assert.deepEqual(calls[1].body.system, systemBlocks);
});

test("Claude native passthrough context_management must be valid before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-context-management-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    {
      body: { context_management: [] },
      message: "context_management must be an object",
    },
    {
      body: { context_management: {} },
      message: "context_management.edits must be a non-empty array",
    },
    {
      body: { context_management: { edits: [null] } },
      message: "context_management.edits[0] must be an object",
    },
    {
      body: { context_management: { edits: [{ type: "memory" }] } },
      message: "context_management.edits[0].type must be compact_20260112",
    },
    {
      body: { context_management: { edits: [{ type: "compact_20260112", trigger: "auto" }] } },
      message: "context_management.edits[0].trigger must be an object",
    },
    {
      body: {
        context_management: {
          edits: [{ type: "compact_20260112", trigger: { type: "tokens", value: 50000 } }],
        },
      },
      message: "context_management.edits[0].trigger.type must be input_tokens",
    },
    {
      body: {
        context_management: {
          edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 49999 } }],
        },
      },
      message: "context_management.edits[0].trigger.value must be at least 50000",
    },
    {
      body: {
        context_management: {
          edits: [{ type: "compact_20260112", pause_after_compaction: "true" }],
        },
      },
      message: "context_management.edits[0].pause_after_compaction must be a boolean",
    },
    {
      body: { context_management: { edits: [{ type: "compact_20260112", instructions: 42 }] } },
      message: "context_management.edits[0].instructions must be a string",
    },
  ];

  for (const item of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/messages",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
        ...item.body,
      },
    });

    assert.equal(resp.status, 400, item.message);
    assert.equal(resp.body.error.message, item.message);
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  const invalidCountTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      context_management: [],
    },
  });

  assert.equal(invalidCountTokens.status, 400);
  assert.equal(invalidCountTokens.body.error.message, "context_management must be an object");
  assert.equal(calls.length, 0);

  const contextManagement = {
    edits: [
      {
        type: "compact_20260112",
        trigger: { type: "input_tokens", value: 150000 },
        pause_after_compaction: true,
        instructions: "Preserve tool decisions.",
      },
    ],
  };
  const valid = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      context_management: contextManagement,
    },
  });

  assert.equal(valid.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.context_management, contextManagement);
});

test("Claude upstream requests use configured Anthropic-Beta header", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-claude-beta-header-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const betaHeader = "custom-beta-20260617,prompt-caching-scope-2026-01-05";
  const config = {
    ...makeConfig(authDir),
    claude: {
      models: ["claude-sonnet-4-6"],
      "beta-header": betaHeader,
    },
  } as Config;
  const server = await startApp(config, manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const messages = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });
  const count = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(messages.status, 200);
  assert.equal(count.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(calls[1].url, "https://api.anthropic.com/v1/messages/count_tokens?beta=true");
  assert.equal(calls[0].headers["Anthropic-Beta"], betaHeader);
  assert.equal(calls[1].headers["Anthropic-Beta"], betaHeader);
});

test("Claude native passthrough upstream network errors return OpenAI-style JSON", async (t) => {
  const messagesAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-messages-network-"));
  const countAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-native-count-network-"));
  const messagesManager = makeManager(messagesAuthDir, [makeToken()]);
  const countManager = makeManager(countAuthDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async () => {
    throw new TypeError("fetch failed");
  });
  const messagesServer = await startApp(makeConfig(messagesAuthDir), messagesManager);
  const countServer = await startApp(makeConfig(countAuthDir), countManager);

  t.after(async () => {
    restoreFetch();
    await stopApp(messagesServer);
    await stopApp(countServer);
    fs.rmSync(messagesAuthDir, { recursive: true, force: true });
    fs.rmSync(countAuthDir, { recursive: true, force: true });
  });

  const messages = await requestJson({
    server: messagesServer,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(messages.status, 502);
  assert.equal(messages.body.error.message, "Upstream network error");
  assert.equal(messages.body.error.type, "api_error");
  assert.equal(messages.body.error.code, "upstream_network_error");

  const count = await requestJson({
    server: countServer,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(count.status, 502);
  assert.equal(count.body.error.message, "Upstream network error");
  assert.equal(count.body.error.type, "api_error");
  assert.equal(count.body.error.code, "upstream_network_error");
});

test("local /v1 rate limit is disabled by default", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-rate-limit-default-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, []);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const headers = { Authorization: "Bearer test-key" };
  for (let i = 0; i < 61; i++) {
    const resp = await requestJson({
      server,
      method: "GET",
      path: "/v1/models",
      headers,
    });
    assert.equal(resp.status, 200);
  }
});

test("local /v1 rate limit can be explicitly enabled", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-rate-limit-enabled-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, []);
  const server = await startApp(
    makeConfigWithRateLimit(authDir, {
      enabled: true,
      "window-ms": 60_000,
      "max-requests": 2,
    }),
    manager
  );

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const headers = { Authorization: "Bearer test-key" };

  assert.equal(
    (
      await requestJson({
        server,
        method: "GET",
        path: "/v1/models",
        headers,
      })
    ).status,
    200
  );
  assert.equal(
    (
      await requestJson({
        server,
        method: "GET",
        path: "/v1/models",
        headers,
      })
    ).status,
    200
  );

  const limited = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers,
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.message, "Too many requests");
  assert.equal(limited.body.error.type, "rate_limit_error");
  assert.equal(limited.body.error.code, "rate_limit_exceeded");
});

test("missing Codex auth only breaks Codex models and still allows Claude models", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-home-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer access-token");

    return new Response(
      JSON.stringify({
        id: "msg_claude_ok",
        content: [{ type: "text", text: "claude still works" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const server = await withHomeDir(tmpHome, () => startApp(makeConfig(authDir), manager));

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi codex" }],
      stream: false,
    },
  });

  assert.equal(codexResp.status, 503);
  assert.equal(codexResp.body.error.type, "api_error");
  assert.equal(codexResp.body.error.code, "codex_auth_unavailable");
  assert.match(codexResp.body.error.message, /Codex auth file not found/);

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi claude" }],
      stream: false,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(claudeResp.body.choices[0].message.content, "claude still works");
});

test("disabled Codex provider rejects Codex models without falling back to Claude", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called when Codex provider is disabled");
  });
  const server = await startApp(
    makeConfigWithCodex(authDir, {
      enabled: false,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4"],
    }),
    manager
  );

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "disabled codex" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 400);
  assert.equal(resp.body.error.message, "Unsupported model: gpt-5.4");
  assert.equal(resp.body.error.type, "invalid_request_error");
  assert.equal(resp.body.error.code, "unsupported_model");
});

test("Codex models not listed in config are rejected", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called for disallowed Codex models");
  });
  const server = await startApp(
    makeConfigWithCodex(authDir, {
      enabled: true,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4"],
    }),
    manager
  );

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "o3",
      input: [{ role: "user", content: "not configured" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 400);
  assert.equal(resp.body.error.message, "Unsupported model: o3");
  assert.equal(resp.body.error.type, "invalid_request_error");
  assert.equal(resp.body.error.code, "unsupported_model");
});

test("loads multiple Claude accounts and exposes each snapshot", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  saveToken(authDir, makeToken({ email: "first@example.com" }));
  saveToken(authDir, makeToken({ email: "second@example.com", accessToken: "second-access" }));

  const manager = new AccountManager(authDir);
  manager.load();

  assert.equal(manager.accountCount, 2);
  assert.deepEqual(
    manager.getSnapshots().map((account) => account.email),
    ["first@example.com", "second@example.com"]
  );
});
