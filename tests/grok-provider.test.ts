import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import express from "express";
import { AccountManager } from "../src/accounts/manager";
import { Config } from "../src/config";
import { createServer } from "../src/server";
import { canStartServer } from "../src/startup";
import { GrokProvider } from "../src/providers/grok";

function makeConfig(authDir: string, grokAuthFile: string, grokEnabled = true): Config {
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
      enabled: false,
      "auth-file": path.join(authDir, "codex-auth.json"),
      store: false,
      models: [],
    },
    grok: {
      enabled: grokEnabled,
      "auth-file": grokAuthFile,
      "base-url": "https://api.x.ai/v1",
      models: ["grok-4.3", "grok-build-0.1", "grok-imagine-image"],
    },
    debug: "off",
  };
}

function writeGrokAuth(filePath: string, accessToken = "grok-access-token"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      "https://auth.x.ai::client-id": {
        key: accessToken,
        auth_mode: "oidc",
        refresh_token: "grok-refresh-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "client-id",
        email: "person@example.com",
      },
    }, null, 2)
  );
}

async function startHandler(handler: express.RequestHandler, route: string): Promise<http.Server> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post(route, handler);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
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
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const address = serverAddress(options.server);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

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
          resolve({
            status: res.statusCode || 0,
            body: data ? JSON.parse(data) : null,
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

test("GrokProvider forwards chat completions with the stored OAuth bearer token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-chat-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; auth?: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), auth: headers?.Authorization, body });
    return new Response(
      JSON.stringify({
        id: "chatcmpl_grok",
        object: "chat.completion",
        created: 123,
        model: "grok-4.3",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  const server = await startHandler(provider.handleChatCompletions(), "/v1/chat/completions");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-4.3",
      messages: [{ role: "user", content: "Reply exactly: ok" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.equal(calls[0].body.model, "grok-4.3");
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "Reply exactly: ok" }]);
});

test("GrokProvider forwards responses requests with the stored OAuth bearer token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-responses-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; auth?: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), auth: headers?.Authorization, body });
    return new Response(
      JSON.stringify({
        id: "resp_grok",
        object: "response",
        status: "completed",
        model: "grok-4.3",
        output_text: "ok",
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  const server = await startHandler(provider.handleResponses(), "/v1/responses");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-4.3",
      input: "Reply exactly: ok",
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.output_text, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.equal(calls[0].body.input, "Reply exactly: ok");
});

test("GrokProvider forwards image generation requests with the stored OAuth bearer token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-images-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; auth?: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), auth: headers?.Authorization, body });
    return new Response(
      JSON.stringify({
        created: 123,
        data: [{ b64_json: "aW1hZ2U=" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  const server = await startHandler(provider.handleImageGenerations(), "/v1/images/generations");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-imagine-image",
      prompt: "A tiny blue icon",
      response_format: "b64_json",
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.data[0].b64_json, "aW1hZ2U=");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/images/generations");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.equal(calls[0].body.prompt, "A tiny blue icon");
});

test("createServer exposes Grok models, routes grok chat, and reports Grok admin status", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-server-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const manager = new AccountManager(authDir);
  manager.load();
  const config = makeConfig(authDir, authFile);
  const restoreFetch = global.fetch;
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl_grok",
        object: "chat.completion",
        model: "grok-4.3",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;
  const server = await startApp(config, manager);

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const models = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(models.status, 200);
  assert.ok(models.body.data.some((model: any) => model.id === "grok-4.3" && model.owned_by === "xai"));

  const admin = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.grok.available, true);
  assert.equal(admin.body.server.provider_status, "degraded");
  assert.equal(admin.body.server.providers.total, 3);
  assert.equal(admin.body.server.providers.available, 1);
  assert.deepEqual(admin.body.server.providers.unavailable, ["claude", "codex"]);

  const chat = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-4.3",
      messages: [{ role: "user", content: "Reply exactly: ok" }],
    },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.choices[0].message.content, "ok");
});

test("Grok OAuth provider alone can satisfy startup readiness", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-startup-"));
  const authFile = path.join(authDir, ".grok", "auth.json");

  try {
    writeGrokAuth(authFile);
    const manager = new AccountManager(authDir);
    manager.load();

    assert.equal(canStartServer(makeConfig(authDir, authFile), manager), true);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
