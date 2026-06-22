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

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

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
      models: ["gpt-image-2"],
      store: false,
    },
    debug: "off",
  };
}

function writeAuth(filePath: string, accessToken = "codex-access-token"): void {
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
      last_refresh: "2026-06-17T00:00:00.000Z",
    })
  );
}

async function startApp(handler: express.RequestHandler): Promise<http.Server> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/v1/images/generations", handler);
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

test("Codex image generations validates OpenAI image parameters before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-images-validation-"));
  const authFile = path.join(authDir, "missing-auth.json");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const server = await startApp(provider.handleImageGenerations());
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called for invalid image generation parameters");
  });

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
      body: { size: "1000x1000" },
      message:
        "size must be auto or WIDTHxHEIGHT with dimensions divisible by 16, aspect ratio between 1:3 and 3:1, and no more than 3840x2160 pixels",
    },
    {
      body: { quality: "hd" },
      message: "quality must be one of auto, low, medium, high",
    },
    {
      body: { output_format: "gif" },
      message: "output_format must be one of png, jpeg, webp",
    },
    {
      body: { output_format: "webp", output_compression: 101 },
      message: "output_compression must be an integer between 0 and 100",
    },
    {
      body: { output_format: "png", output_compression: 80 },
      message: "output_compression is only supported for jpeg or webp output_format",
    },
    {
      body: { background: "transparent" },
      message: "background transparent is unsupported for gpt-image-2",
    },
    {
      body: { moderation: "strict" },
      message: "moderation must be one of auto, low",
    },
    {
      body: { stream: true },
      message: "stream is unsupported for /v1/images/generations",
    },
    {
      body: { partial_images: 1 },
      message: "partial_images is unsupported for /v1/images/generations",
    },
    {
      body: { style: "vivid" },
      message: "style is unsupported for gpt-image-2",
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
      body: {
        prompt: "A small product icon",
        ...item.body,
      },
    });

    assert.equal(resp.status, 400, item.message);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.message, item.message);
  }
});

test("Codex image generations maps supported image parameters to the image_generation tool", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-images-mapping-"));
  const authFile = path.join(authDir, "codex-auth.json");
  writeAuth(authFile);
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; body: any; auth?: string; accept?: string }> = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")),
      auth: headers.Authorization,
      accept: headers.Accept,
    });

    return makeSseResponse([
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":1,\"item\":{\"id\":\"ig_1\",\"type\":\"image_generation_call\",\"status\":\"in_progress\"},\"output_index\":0}\n\n",
      "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"sequence_number\":2,\"item_id\":\"ig_1\",\"output_format\":\"webp\",\"partial_image_b64\":\"abc123\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_img\",\"model\":\"gpt-image-2\",\"status\":\"completed\"}}\n\n",
    ]);
  });
  const server = await startApp(provider.handleImageGenerations());

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    body: {
      model: "gpt-image-2",
      prompt: "A small product icon",
      size: "1536x864",
      quality: "medium",
      background: "opaque",
      output_format: "webp",
      output_compression: 80,
      moderation: "low",
      response_format: "url",
      user: "end-user-42",
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
    input: [{ role: "user", content: "A small product icon" }],
    tools: [
      {
        type: "image_generation",
        size: "1536x864",
        quality: "medium",
        background: "opaque",
        output_format: "webp",
        output_compression: 80,
        moderation: "low",
      },
    ],
    stream: true,
    user: "end-user-42",
  });
  assert.deepEqual(resp.body.data, [{ url: "data:image/webp;base64,abc123", revised_prompt: "A small product icon" }]);
});

test("Codex image generations returns upstream timeout when upstream fetch times out", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-images-timeout-"));
  const authFile = path.join(authDir, "codex-auth.json");
  writeAuth(authFile);
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = withMockedFetch(async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });
  const server = await startApp(provider.handleImageGenerations());

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    body: {
      model: "gpt-image-2",
      prompt: "A small product icon",
    },
  });

  assert.equal(resp.status, 504);
  assert.equal(resp.body.error.message, "Codex upstream request timed out");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_timeout");
});

test("Codex image generations returns upstream network error when upstream fetch fails", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-images-network-"));
  const authFile = path.join(authDir, "codex-auth.json");
  writeAuth(authFile);
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  let calls = 0;

  const restoreFetch = withMockedFetch(async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  });
  const server = await startApp(provider.handleImageGenerations());

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    body: {
      model: "gpt-image-2",
      prompt: "A small product icon",
    },
  });

  assert.equal(calls, 2);
  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Codex upstream network error");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_network_error");
});

test("Codex image generations returns upstream network error when upstream SSE is truncated", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-images-truncated-sse-"));
  const authFile = path.join(authDir, "codex-auth.json");
  writeAuth(authFile);
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = withMockedFetch(async () => {
    return makeSseResponse([
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":1,\"item\":{\"id\":\"ig_truncated\",\"type\":\"image_generation_call\",\"status\":\"in_progress\"},\"output_index\":0}\n\n",
      "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"sequence_number\":2,\"item_id\":\"ig_truncated\",\"output_format\":\"png\",\"partial_image_b64\":\"abc123\"}\n\n",
    ]);
  });
  const server = await startApp(provider.handleImageGenerations());

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    body: {
      model: "gpt-image-2",
      prompt: "A small product icon",
      response_format: "b64_json",
    },
  });

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream stream ended before completion");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_network_error");
});

test("Codex image generations preserves upstream SSE error events", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-images-sse-error-"));
  const authFile = path.join(authDir, "codex-auth.json");
  writeAuth(authFile);
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = withMockedFetch(async () => {
    return makeSseResponse([
      "event: error\ndata: {\"type\":\"error\",\"code\":\"rate_limit_exceeded\",\"message\":\"Upstream quota exhausted\",\"param\":null,\"sequence_number\":1}\n\n",
    ]);
  });
  const server = await startApp(provider.handleImageGenerations());

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    body: {
      model: "gpt-image-2",
      prompt: "A small product icon",
      response_format: "b64_json",
    },
  });

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream quota exhausted");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "rate_limit_exceeded");
});
