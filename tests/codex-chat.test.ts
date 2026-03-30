import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import express from "express";
import { Config } from "../src/config";
import { CodexProvider } from "../src/providers/codex";

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
      models: ["gpt-5.4"],
    },
    debug: "off",
  };
}

function writeAuth(filePath: string, accessToken: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      auth_mode: "oauth",
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh-token",
        account_id: "acct_123",
      },
      last_refresh: "2026-03-30T00:00:00.000Z",
    }, null, 2)
  );
}

async function startApp(handler: express.RequestHandler): Promise<http.Server> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/v1/chat/completions", handler);
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
          resolve({
            status: res.statusCode || 0,
            body: data ? JSON.parse(data) : null,
          });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("Codex chat completions sends bearer token upstream and canonicalizes chat messages", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; auth?: string; body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({
      url: String(input),
      auth: init?.headers && (init.headers as Record<string, string>).Authorization,
      body,
    });

    return new Response(
      JSON.stringify({
        id: "resp_123",
        object: "response",
        created_at: 1711756800,
        status: "completed",
        model: "gpt-5.4",
        output: [{
          type: "message",
          id: "msg_123",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "hello from codex", annotations: [] },
          ],
        }],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

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
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
  });

  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(calls[0]?.auth, "Bearer codex-access-token");
  assert.deepEqual(calls[0]?.body, {
    model: "gpt-5.4",
    input: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.choices[0].message.role, "assistant");
  assert.equal(resp.body.choices[0].message.content, "hello from codex");
  assert.equal(resp.body.usage.total_tokens, 20);
});

test("Codex chat completions returns controlled error when auth file is missing", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-missing-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("Upstream should not be called when auth is missing");
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

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
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 503);
  assert.match(String(resp.body.error.message), /auth/i);
});

test("Codex chat completions returns controlled error when auth file is malformed", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-malformed-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "oauth",
      tokens: {
        refresh_token: "refresh-token",
        account_id: "acct_123",
      },
    }, null, 2)
  );

  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
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
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 503);
  assert.match(String(resp.body.error.message), /access_token/i);
});
