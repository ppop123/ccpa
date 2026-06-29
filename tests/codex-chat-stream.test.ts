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

async function requestRaw(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
            headers: res.headers,
            body: data,
          });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeStreamResponse(chunks: string[]): Response {
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

test("Codex chat completions streams upstream SSE events as OpenAI chat chunks", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-stream-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; auth?: string; accept?: string; body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(input),
      auth: headers?.Authorization,
      accept: headers?.Accept,
      body,
    });

    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"hello\"}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":3,\"delta\":\" world\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":4,\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":8}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":5}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestRaw({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    },
  });

  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(calls[0]?.auth, "Bearer codex-access-token");
  assert.equal(calls[0]?.accept, "text/event-stream");
  assert.equal(calls[0]?.body.stream, true);
  assert.equal(resp.status, 200);
  assert.match(String(resp.headers["content-type"]), /text\/event-stream/);
  assert.match(resp.body, /"object":"chat\.completion\.chunk"/);
  assert.match(resp.body, /"content":"hello"/);
  assert.match(resp.body, /"content":" world"/);
  assert.match(resp.body, /"finish_reason":"stop"/);
  assert.match(resp.body, /"usage":\{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20\}/);
  assert.match(resp.body, /data: \[DONE\]/);
});

test("Codex chat completions honors stream_options include_usage", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-stream-options-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ body });

    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"hello\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":7,\"total_tokens\":12}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestRaw({
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

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.stream_options, { include_obfuscation: false });

  const chunks = resp.body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
  assert.ok(chunks.some((chunk) => chunk.usage === null));
  const usageChunk = chunks.find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
  assert.ok(usageChunk, "expected a usage-only chunk before [DONE]");
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 5,
    completion_tokens: 7,
    total_tokens: 12,
  });
  assert.match(resp.body, /data: \[DONE\]/);
});

test("Codex chat completions streams custom tool calls as OpenAI chat deltas", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-stream-custom-tool-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => makeStreamResponse([
    "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
    "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"sequence_number\":2,\"item\":{\"type\":\"custom_tool_call\",\"call_id\":\"call_custom_1\",\"name\":\"render_markdown\",\"input\":\"**hello**\"},\"output_index\":0}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4,\"total_tokens\":7}}}\n\n",
    "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
  ])) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestRaw({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "render this markdown" }],
      tools: [{ type: "custom", custom: { name: "render_markdown", format: { type: "text" } } }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /"tool_calls":\[\{"index":0,"id":"call_custom_1","type":"custom","custom":\{"name":"render_markdown","input":"\*\*hello\*\*"\}\}\]/);
  assert.match(resp.body, /"finish_reason":"tool_calls"/);
  assert.match(resp.body, /data: \[DONE\]/);
});

test("Codex chat completions streams legacy function_call deltas for legacy functions requests", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-stream-legacy-function-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => makeStreamResponse([
    "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
    "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"sequence_number\":2,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_weather_1\",\"name\":\"lookup_weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"},\"output_index\":0}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4,\"total_tokens\":7}}}\n\n",
    "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
  ])) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestRaw({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "weather in Paris?" }],
      functions: [{
        name: "lookup_weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.match(resp.body, /"function_call":\{"name":"lookup_weather","arguments":"\{\\\"city\\\":\\\"Paris\\\"\}"\}/);
  assert.doesNotMatch(resp.body, /"tool_calls"/);
  assert.match(resp.body, /"finish_reason":"function_call"/);
  assert.match(resp.body, /data: \[DONE\]/);
});

test("Codex chat completions streams image partials as markdown content chunks", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-stream-image-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ body });

    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":2,\"item\":{\"id\":\"ig_1\",\"type\":\"image_generation_call\",\"status\":\"in_progress\"},\"output_index\":0}\n\n",
      "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"sequence_number\":3,\"item_id\":\"ig_1\",\"output_format\":\"png\",\"partial_image_b64\":\"abc123\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":4,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4,\"total_tokens\":7}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":5}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestRaw({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "画一只猫" }],
      stream: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.stream, true);
  assert.deepEqual(calls[0]?.body.tools, [{ type: "image_generation" }]);
  assert.deepEqual(calls[0]?.body.tool_choice, { type: "image_generation" });
  assert.match(resp.body, /"content":"!\[generated image\]\(data:image\/png;base64,abc123\)"/);
  assert.match(resp.body, /"finish_reason":"stop"/);
  assert.match(resp.body, /data: \[DONE\]/);
});
