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

function makeConfig(authDir: string, codexAuthFile: string, codexStore = false): Config {
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
      store: codexStore,
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

function withHomeDir<T>(homeDir: string, fn: () => T): T {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    return fn();
  } finally {
    process.env.HOME = originalHome;
  }
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

test("Codex chat completions sends bearer token upstream and canonicalizes chat messages", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-"));
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
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"hello from codex\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"service_tier\":\"flex\",\"usage\":{\"input_tokens\":12,\"output_tokens\":8,\"total_tokens\":20}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());
  const answerSchema = {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
    additionalProperties: false,
  };

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
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/cat.png", detail: "low" },
          },
        ],
      }],
      max_completion_tokens: 128,
      reasoning_effort: "low",
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0,
      frequency_penalty: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          description: "Answer payload",
          schema: answerSchema,
          strict: true,
        },
      },
      verbosity: "low",
      stop: ["END"],
      parallel_tool_calls: false,
      service_tier: "flex",
      prompt_cache_key: "project:chat:user-42",
      prompt_cache_retention: "in_memory",
      safety_identifier: "user-hash-42",
      user: "legacy-user-42",
      metadata: { workflow: "smoke", tenant: "personal" },
      stream: false,
    },
  });

  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(calls[0]?.auth, "Bearer codex-access-token");
  assert.equal(calls[0]?.accept, "text/event-stream");
  assert.deepEqual(calls[0]?.body, {
    model: "gpt-5.4",
    instructions: "",
    store: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "hello" },
        { type: "input_image", image_url: "https://example.com/cat.png", detail: "low" },
      ],
    }],
    max_output_tokens: 128,
    reasoning: { effort: "low" },
    temperature: 0.7,
    top_p: 0.9,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        description: "Answer payload",
        schema: answerSchema,
        strict: true,
      },
      verbosity: "low",
    },
    stop: ["END"],
    parallel_tool_calls: false,
    service_tier: "flex",
    prompt_cache_key: "project:chat:user-42",
    prompt_cache_retention: "in-memory",
    safety_identifier: "user-hash-42",
    user: "legacy-user-42",
    metadata: { workflow: "smoke", tenant: "personal" },
    stream: true,
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.choices[0].message.role, "assistant");
  assert.equal(resp.body.choices[0].message.content, "hello from codex");
  assert.equal(resp.body.service_tier, "flex");
  assert.equal(resp.body.usage.total_tokens, 20);
});

test("Codex chat completions preserves response.output_text.done text without deltas", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-output-text-done-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_output_text_done\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
      "event: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"sequence_number\":2,\"text\":\"final text from done\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_output_text_done\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
    ]);
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

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "final text from done");
});

test("Codex chat completions adds image tool for explicit image_generation tool_choice", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-image-choice-"));
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
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":2,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":3}\n\n",
    ]);
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
      tool_choice: { type: "image_generation" },
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.tools, [{ type: "image_generation" }]);
  assert.deepEqual(calls[0]?.body.tool_choice, { type: "image_generation" });
});

test("Codex chat completions does not auto-enable image tool when response_format requests text", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-response-format-no-image-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ body });

    return makeStreamResponse([
      "event: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"sequence_number\":1,\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"text\":\"{\\\"ok\\\":true}\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":2,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":3}\n\n",
    ]);
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
      messages: [{
        role: "user",
        content: "请返回 JSON，总结这段话：不要生成图片，也不要画一张图。",
      }],
      response_format: { type: "json_object" },
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.tools, undefined);
  assert.equal(calls[0]?.body.tool_choice, undefined);
  assert.deepEqual(calls[0]?.body.text?.format, { type: "json_object" });
});

test("Codex chat completions applies configured stream timeout to upstream fetch", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-timeout-config-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const config = makeConfig(authDir, authFile);
  config.timeouts["stream-messages-ms"] = 1234;
  const provider = new CodexProvider(config);

  const controller = new AbortController();
  const restoreFetch = global.fetch;
  const restoreTimeout = AbortSignal.timeout;
  let seenTimeoutMs: number | undefined;
  (AbortSignal as typeof AbortSignal & { timeout: (milliseconds: number) => AbortSignal }).timeout =
    (milliseconds: number): AbortSignal => {
      seenTimeoutMs = milliseconds;
      return controller.signal;
    };
  global.fetch = (async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"timeout aware\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\"}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
    (AbortSignal as typeof AbortSignal & { timeout: typeof restoreTimeout }).timeout = restoreTimeout;
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

  assert.equal(resp.status, 200);
  assert.equal(seenTimeoutMs, 1234);
  assert.equal(resp.body.choices[0].message.content, "timeout aware");
});

test("Codex chat completions converts system messages to developer role", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-system-"));
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
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":2,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":3}\n\n",
    ]);
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
      messages: [
        { role: "system", content: "be precise" },
        { role: "user", content: "hello" },
      ],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.instructions, "");
  assert.equal(calls[0]?.body.store, false);
  assert.equal(calls[0]?.body.stream, true);
  assert.equal(calls[0]?.body.input[0].role, "developer");
  assert.equal(calls[0]?.body.input[1].role, "user");
});

test("Codex chat completions uses configured default store", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-store-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile, true));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ body });

    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":2,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":3}\n\n",
    ]);
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

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.store, true);
});

test("Codex chat completions returns OpenAI-style validation errors", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-validation-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for local validation errors");
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
      stream: false,
    },
  });

  assert.equal(resp.status, 400);
  assert.equal(resp.body.error.type, "invalid_request_error");
  assert.equal(resp.body.error.code, "missing_required_parameter");
  assert.match(resp.body.error.message, /messages is required/);
  assert.equal(upstreamCalls, 0);

  const invalidMaxTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: "32",
      stream: false,
    },
  });

  assert.equal(invalidMaxTokens.status, 400);
  assert.equal(invalidMaxTokens.body.error.type, "invalid_request_error");
  assert.equal(invalidMaxTokens.body.error.code, "invalid_parameter");
  assert.equal(invalidMaxTokens.body.error.message, "max_tokens must be a positive integer");
  assert.equal(upstreamCalls, 0);

  const invalidMaxCompletionTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: "32",
      stream: false,
    },
  });

  assert.equal(invalidMaxCompletionTokens.status, 400);
  assert.equal(invalidMaxCompletionTokens.body.error.type, "invalid_request_error");
  assert.equal(invalidMaxCompletionTokens.body.error.code, "invalid_parameter");
  assert.equal(invalidMaxCompletionTokens.body.error.message, "max_completion_tokens must be a positive integer");
  assert.equal(upstreamCalls, 0);

  const conflictingMaxTokens = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32,
      max_completion_tokens: 64,
      stream: false,
    },
  });

  assert.equal(conflictingMaxTokens.status, 400);
  assert.equal(conflictingMaxTokens.body.error.type, "invalid_request_error");
  assert.equal(conflictingMaxTokens.body.error.code, "invalid_parameter");
  assert.equal(
    conflictingMaxTokens.body.error.message,
    "max_tokens and max_completion_tokens must match when both are provided"
  );
  assert.equal(upstreamCalls, 0);

  const invalidReasoningEffort = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "mega",
      stream: false,
    },
  });

  assert.equal(invalidReasoningEffort.status, 400);
  assert.equal(invalidReasoningEffort.body.error.type, "invalid_request_error");
  assert.equal(invalidReasoningEffort.body.error.code, "invalid_parameter");
  assert.equal(
    invalidReasoningEffort.body.error.message,
    "reasoning_effort must be one of none, minimal, low, medium, high, xhigh"
  );
  assert.equal(upstreamCalls, 0);

  const invalidVerbosity = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      verbosity: "quiet",
      stream: false,
    },
  });

  assert.equal(invalidVerbosity.status, 400);
  assert.equal(invalidVerbosity.body.error.type, "invalid_request_error");
  assert.equal(invalidVerbosity.body.error.code, "invalid_parameter");
  assert.equal(invalidVerbosity.body.error.message, "verbosity must be one of low, medium, high");
  assert.equal(upstreamCalls, 0);

  const invalidParallelToolCalls = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      parallel_tool_calls: "false",
      stream: false,
    },
  });

  assert.equal(invalidParallelToolCalls.status, 400);
  assert.equal(invalidParallelToolCalls.body.error.type, "invalid_request_error");
  assert.equal(invalidParallelToolCalls.body.error.code, "invalid_parameter");
  assert.equal(invalidParallelToolCalls.body.error.message, "parallel_tool_calls must be a boolean");
  assert.equal(upstreamCalls, 0);

  const invalidServiceTier = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      service_tier: "express",
      stream: false,
    },
  });

  assert.equal(invalidServiceTier.status, 400);
  assert.equal(invalidServiceTier.body.error.type, "invalid_request_error");
  assert.equal(invalidServiceTier.body.error.code, "invalid_parameter");
  assert.equal(invalidServiceTier.body.error.message, "service_tier must be one of auto, default, flex, scale, priority");
  assert.equal(upstreamCalls, 0);

  const invalidPromptCacheKey = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      prompt_cache_key: 42,
      stream: false,
    },
  });

  assert.equal(invalidPromptCacheKey.status, 400);
  assert.equal(invalidPromptCacheKey.body.error.type, "invalid_request_error");
  assert.equal(invalidPromptCacheKey.body.error.code, "invalid_parameter");
  assert.equal(invalidPromptCacheKey.body.error.message, "prompt_cache_key must be a string");
  assert.equal(upstreamCalls, 0);

  const invalidPromptCacheRetention = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      prompt_cache_retention: "1h",
      stream: false,
    },
  });

  assert.equal(invalidPromptCacheRetention.status, 400);
  assert.equal(invalidPromptCacheRetention.body.error.type, "invalid_request_error");
  assert.equal(invalidPromptCacheRetention.body.error.code, "invalid_parameter");
  assert.equal(invalidPromptCacheRetention.body.error.message, "prompt_cache_retention must be one of in_memory, 24h");
  assert.equal(upstreamCalls, 0);

  const invalidSafetyIdentifierType = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      safety_identifier: 42,
      stream: false,
    },
  });

  assert.equal(invalidSafetyIdentifierType.status, 400);
  assert.equal(invalidSafetyIdentifierType.body.error.type, "invalid_request_error");
  assert.equal(invalidSafetyIdentifierType.body.error.code, "invalid_parameter");
  assert.equal(invalidSafetyIdentifierType.body.error.message, "safety_identifier must be a string");
  assert.equal(upstreamCalls, 0);

  const invalidSafetyIdentifierLength = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      safety_identifier: "u".repeat(65),
      stream: false,
    },
  });

  assert.equal(invalidSafetyIdentifierLength.status, 400);
  assert.equal(invalidSafetyIdentifierLength.body.error.type, "invalid_request_error");
  assert.equal(invalidSafetyIdentifierLength.body.error.code, "invalid_parameter");
  assert.equal(invalidSafetyIdentifierLength.body.error.message, "safety_identifier must be at most 64 characters");
  assert.equal(upstreamCalls, 0);

  const invalidUser = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      user: 42,
      stream: false,
    },
  });

  assert.equal(invalidUser.status, 400);
  assert.equal(invalidUser.body.error.type, "invalid_request_error");
  assert.equal(invalidUser.body.error.code, "invalid_parameter");
  assert.equal(invalidUser.body.error.message, "user must be a string");
  assert.equal(upstreamCalls, 0);

  const invalidSeedType = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      seed: "42",
      stream: false,
    },
  });

  assert.equal(invalidSeedType.status, 400);
  assert.equal(invalidSeedType.body.error.type, "invalid_request_error");
  assert.equal(invalidSeedType.body.error.code, "invalid_parameter");
  assert.equal(
    invalidSeedType.body.error.message,
    "seed must be a number between -9223372036854776000 and 9223372036854776000"
  );
  assert.equal(upstreamCalls, 0);

  const invalidSeedRange = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      seed: 1e20,
      stream: false,
    },
  });

  assert.equal(invalidSeedRange.status, 400);
  assert.equal(invalidSeedRange.body.error.type, "invalid_request_error");
  assert.equal(invalidSeedRange.body.error.code, "invalid_parameter");
  assert.equal(
    invalidSeedRange.body.error.message,
    "seed must be a number between -9223372036854776000 and 9223372036854776000"
  );
  assert.equal(upstreamCalls, 0);

  const unsupportedSeed = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      seed: 42,
      stream: false,
    },
  });

  assert.equal(unsupportedSeed.status, 400);
  assert.equal(unsupportedSeed.body.error.type, "invalid_request_error");
  assert.equal(unsupportedSeed.body.error.code, "invalid_parameter");
  assert.equal(unsupportedSeed.body.error.message, "seed is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidStore = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      store: "false",
      stream: false,
    },
  });

  assert.equal(invalidStore.status, 400);
  assert.equal(invalidStore.body.error.type, "invalid_request_error");
  assert.equal(invalidStore.body.error.code, "invalid_parameter");
  assert.equal(invalidStore.body.error.message, "store must be a boolean");
  assert.equal(upstreamCalls, 0);

  const invalidWebSearchShape = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      web_search_options: "enabled",
      stream: false,
    },
  });

  assert.equal(invalidWebSearchShape.status, 400);
  assert.equal(invalidWebSearchShape.body.error.type, "invalid_request_error");
  assert.equal(invalidWebSearchShape.body.error.code, "invalid_parameter");
  assert.equal(invalidWebSearchShape.body.error.message, "web_search_options must be an object");
  assert.equal(upstreamCalls, 0);

  const invalidWebSearchContextSize = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      web_search_options: { search_context_size: "huge" },
      stream: false,
    },
  });

  assert.equal(invalidWebSearchContextSize.status, 400);
  assert.equal(invalidWebSearchContextSize.body.error.type, "invalid_request_error");
  assert.equal(invalidWebSearchContextSize.body.error.code, "invalid_parameter");
  assert.equal(
    invalidWebSearchContextSize.body.error.message,
    "web_search_options.search_context_size must be one of low, medium, high"
  );
  assert.equal(upstreamCalls, 0);

  const unsupportedWebSearch = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      web_search_options: {
        search_context_size: "low",
        user_location: {
          type: "approximate",
          approximate: { country: "US" },
        },
      },
      stream: false,
    },
  });

  assert.equal(unsupportedWebSearch.status, 400);
  assert.equal(unsupportedWebSearch.body.error.type, "invalid_request_error");
  assert.equal(unsupportedWebSearch.body.error.code, "invalid_parameter");
  assert.equal(unsupportedWebSearch.body.error.message, "web_search_options is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidMetadataShape = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      metadata: "tenant",
      stream: false,
    },
  });

  assert.equal(invalidMetadataShape.status, 400);
  assert.equal(invalidMetadataShape.body.error.type, "invalid_request_error");
  assert.equal(invalidMetadataShape.body.error.code, "invalid_parameter");
  assert.equal(invalidMetadataShape.body.error.message, "metadata must be an object");
  assert.equal(upstreamCalls, 0);

  const invalidMetadataCount = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key_${index}`, "value"])),
      stream: false,
    },
  });

  assert.equal(invalidMetadataCount.status, 400);
  assert.equal(invalidMetadataCount.body.error.type, "invalid_request_error");
  assert.equal(invalidMetadataCount.body.error.code, "invalid_parameter");
  assert.equal(invalidMetadataCount.body.error.message, "metadata must contain at most 16 key-value pairs");
  assert.equal(upstreamCalls, 0);

  const invalidMetadataKey = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      metadata: { ["k".repeat(65)]: "value" },
      stream: false,
    },
  });

  assert.equal(invalidMetadataKey.status, 400);
  assert.equal(invalidMetadataKey.body.error.type, "invalid_request_error");
  assert.equal(invalidMetadataKey.body.error.code, "invalid_parameter");
  assert.equal(invalidMetadataKey.body.error.message, "metadata keys must be at most 64 characters");
  assert.equal(upstreamCalls, 0);

  const invalidMetadataValueType = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      metadata: { tenant: 42 },
      stream: false,
    },
  });

  assert.equal(invalidMetadataValueType.status, 400);
  assert.equal(invalidMetadataValueType.body.error.type, "invalid_request_error");
  assert.equal(invalidMetadataValueType.body.error.code, "invalid_parameter");
  assert.equal(invalidMetadataValueType.body.error.message, "metadata values must be strings");
  assert.equal(upstreamCalls, 0);

  const invalidMetadataValueLength = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      metadata: { tenant: "v".repeat(513) },
      stream: false,
    },
  });

  assert.equal(invalidMetadataValueLength.status, 400);
  assert.equal(invalidMetadataValueLength.body.error.type, "invalid_request_error");
  assert.equal(invalidMetadataValueLength.body.error.code, "invalid_parameter");
  assert.equal(invalidMetadataValueLength.body.error.message, "metadata values must be at most 512 characters");
  assert.equal(upstreamCalls, 0);

  const invalidModalities = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      modalities: "audio",
      stream: false,
    },
  });

  assert.equal(invalidModalities.status, 400);
  assert.equal(invalidModalities.body.error.type, "invalid_request_error");
  assert.equal(invalidModalities.body.error.code, "invalid_parameter");
  assert.equal(invalidModalities.body.error.message, "modalities must be an array");
  assert.equal(upstreamCalls, 0);

  const unsupportedAudioModality = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      modalities: ["text", "audio"],
      audio: { format: "mp3", voice: "alloy" },
      stream: false,
    },
  });

  assert.equal(unsupportedAudioModality.status, 400);
  assert.equal(unsupportedAudioModality.body.error.type, "invalid_request_error");
  assert.equal(unsupportedAudioModality.body.error.code, "invalid_parameter");
  assert.equal(unsupportedAudioModality.body.error.message, "audio output is unsupported");
  assert.equal(upstreamCalls, 0);

  const unsupportedAudioConfig = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      audio: { format: "mp3", voice: "alloy" },
      stream: false,
    },
  });

  assert.equal(unsupportedAudioConfig.status, 400);
  assert.equal(unsupportedAudioConfig.body.error.type, "invalid_request_error");
  assert.equal(unsupportedAudioConfig.body.error.code, "invalid_parameter");
  assert.equal(unsupportedAudioConfig.body.error.message, "audio output is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidContentPart = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: [{ type: "text" }] }],
      stream: false,
    },
  });

  assert.equal(invalidContentPart.status, 400);
  assert.equal(invalidContentPart.body.error.type, "invalid_request_error");
  assert.equal(invalidContentPart.body.error.code, "invalid_parameter");
  assert.equal(invalidContentPart.body.error.message, "messages[0].content[0].text is required");
  assert.equal(upstreamCalls, 0);

  const unsupportedContentPart = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "...", format: "mp3" } }] }],
      stream: false,
    },
  });

  assert.equal(unsupportedContentPart.status, 400);
  assert.equal(unsupportedContentPart.body.error.type, "invalid_request_error");
  assert.equal(unsupportedContentPart.body.error.code, "invalid_parameter");
  assert.equal(unsupportedContentPart.body.error.message, "messages[0].content[0].type is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidTemperature = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      temperature: "0.7",
      stream: false,
    },
  });

  assert.equal(invalidTemperature.status, 400);
  assert.equal(invalidTemperature.body.error.type, "invalid_request_error");
  assert.equal(invalidTemperature.body.error.code, "invalid_parameter");
  assert.equal(invalidTemperature.body.error.message, "temperature must be a number between 0 and 2");
  assert.equal(upstreamCalls, 0);

  const invalidTopP = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      top_p: 2,
      stream: false,
    },
  });

  assert.equal(invalidTopP.status, 400);
  assert.equal(invalidTopP.body.error.type, "invalid_request_error");
  assert.equal(invalidTopP.body.error.code, "invalid_parameter");
  assert.equal(invalidTopP.body.error.message, "top_p must be a number between 0 and 1");
  assert.equal(upstreamCalls, 0);

  const invalidLogprobs = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      logprobs: "true",
      stream: false,
    },
  });

  assert.equal(invalidLogprobs.status, 400);
  assert.equal(invalidLogprobs.body.error.type, "invalid_request_error");
  assert.equal(invalidLogprobs.body.error.code, "invalid_parameter");
  assert.equal(invalidLogprobs.body.error.message, "logprobs must be a boolean");
  assert.equal(upstreamCalls, 0);

  const unsupportedLogprobs = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      logprobs: true,
      stream: false,
    },
  });

  assert.equal(unsupportedLogprobs.status, 400);
  assert.equal(unsupportedLogprobs.body.error.type, "invalid_request_error");
  assert.equal(unsupportedLogprobs.body.error.code, "invalid_parameter");
  assert.equal(unsupportedLogprobs.body.error.message, "logprobs is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidTopLogprobs = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      top_logprobs: 21,
      stream: false,
    },
  });

  assert.equal(invalidTopLogprobs.status, 400);
  assert.equal(invalidTopLogprobs.body.error.type, "invalid_request_error");
  assert.equal(invalidTopLogprobs.body.error.code, "invalid_parameter");
  assert.equal(invalidTopLogprobs.body.error.message, "top_logprobs must be an integer between 0 and 20");
  assert.equal(upstreamCalls, 0);

  const unsupportedTopLogprobs = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      top_logprobs: 3,
      stream: false,
    },
  });

  assert.equal(unsupportedTopLogprobs.status, 400);
  assert.equal(unsupportedTopLogprobs.body.error.type, "invalid_request_error");
  assert.equal(unsupportedTopLogprobs.body.error.code, "invalid_parameter");
  assert.equal(unsupportedTopLogprobs.body.error.message, "top_logprobs is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidPresencePenalty = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      presence_penalty: "0.5",
      stream: false,
    },
  });

  assert.equal(invalidPresencePenalty.status, 400);
  assert.equal(invalidPresencePenalty.body.error.type, "invalid_request_error");
  assert.equal(invalidPresencePenalty.body.error.code, "invalid_parameter");
  assert.equal(invalidPresencePenalty.body.error.message, "presence_penalty must be a number between -2 and 2");
  assert.equal(upstreamCalls, 0);

  const unsupportedPresencePenalty = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      presence_penalty: 1,
      stream: false,
    },
  });

  assert.equal(unsupportedPresencePenalty.status, 400);
  assert.equal(unsupportedPresencePenalty.body.error.type, "invalid_request_error");
  assert.equal(unsupportedPresencePenalty.body.error.code, "invalid_parameter");
  assert.equal(unsupportedPresencePenalty.body.error.message, "presence_penalty is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidFrequencyPenalty = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      frequency_penalty: -3,
      stream: false,
    },
  });

  assert.equal(invalidFrequencyPenalty.status, 400);
  assert.equal(invalidFrequencyPenalty.body.error.type, "invalid_request_error");
  assert.equal(invalidFrequencyPenalty.body.error.code, "invalid_parameter");
  assert.equal(invalidFrequencyPenalty.body.error.message, "frequency_penalty must be a number between -2 and 2");
  assert.equal(upstreamCalls, 0);

  const unsupportedFrequencyPenalty = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      frequency_penalty: 0.5,
      stream: false,
    },
  });

  assert.equal(unsupportedFrequencyPenalty.status, 400);
  assert.equal(unsupportedFrequencyPenalty.body.error.type, "invalid_request_error");
  assert.equal(unsupportedFrequencyPenalty.body.error.code, "invalid_parameter");
  assert.equal(unsupportedFrequencyPenalty.body.error.message, "frequency_penalty is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidResponseFormat = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response_format: "json_object",
      stream: false,
    },
  });

  assert.equal(invalidResponseFormat.status, 400);
  assert.equal(invalidResponseFormat.body.error.type, "invalid_request_error");
  assert.equal(invalidResponseFormat.body.error.code, "invalid_parameter");
  assert.equal(invalidResponseFormat.body.error.message, "response_format must be an object");
  assert.equal(upstreamCalls, 0);

  const invalidResponseFormatType = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "xml" },
      stream: false,
    },
  });

  assert.equal(invalidResponseFormatType.status, 400);
  assert.equal(invalidResponseFormatType.body.error.type, "invalid_request_error");
  assert.equal(invalidResponseFormatType.body.error.code, "invalid_parameter");
  assert.equal(
    invalidResponseFormatType.body.error.message,
    "response_format.type must be one of text, json_object, json_schema"
  );
  assert.equal(upstreamCalls, 0);

  const invalidJsonSchema = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_schema" },
      stream: false,
    },
  });

  assert.equal(invalidJsonSchema.status, 400);
  assert.equal(invalidJsonSchema.body.error.type, "invalid_request_error");
  assert.equal(invalidJsonSchema.body.error.code, "invalid_parameter");
  assert.equal(invalidJsonSchema.body.error.message, "response_format.json_schema is required");
  assert.equal(upstreamCalls, 0);

  const invalidJsonSchemaSchema = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema: "object" },
      },
      stream: false,
    },
  });

  assert.equal(invalidJsonSchemaSchema.status, 400);
  assert.equal(invalidJsonSchemaSchema.body.error.type, "invalid_request_error");
  assert.equal(invalidJsonSchemaSchema.body.error.code, "invalid_parameter");
  assert.equal(invalidJsonSchemaSchema.body.error.message, "response_format.json_schema.schema must be an object");
  assert.equal(upstreamCalls, 0);

  const invalidPredictionShape = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      prediction: "hello",
      stream: false,
    },
  });

  assert.equal(invalidPredictionShape.status, 400);
  assert.equal(invalidPredictionShape.body.error.type, "invalid_request_error");
  assert.equal(invalidPredictionShape.body.error.code, "invalid_parameter");
  assert.equal(invalidPredictionShape.body.error.message, "prediction must be an object");
  assert.equal(upstreamCalls, 0);

  const invalidPredictionType = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      prediction: { type: "static", content: "hello" },
      stream: false,
    },
  });

  assert.equal(invalidPredictionType.status, 400);
  assert.equal(invalidPredictionType.body.error.type, "invalid_request_error");
  assert.equal(invalidPredictionType.body.error.code, "invalid_parameter");
  assert.equal(invalidPredictionType.body.error.message, "prediction.type must be content");
  assert.equal(upstreamCalls, 0);

  const invalidPredictionContent = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      prediction: { type: "content", content: [{ type: "text" }] },
      stream: false,
    },
  });

  assert.equal(invalidPredictionContent.status, 400);
  assert.equal(invalidPredictionContent.body.error.type, "invalid_request_error");
  assert.equal(invalidPredictionContent.body.error.code, "invalid_parameter");
  assert.equal(invalidPredictionContent.body.error.message, "prediction.content[0].text is required");
  assert.equal(upstreamCalls, 0);

  const unsupportedPrediction = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      prediction: { type: "content", content: "hello" },
      stream: false,
    },
  });

  assert.equal(unsupportedPrediction.status, 400);
  assert.equal(unsupportedPrediction.body.error.type, "invalid_request_error");
  assert.equal(unsupportedPrediction.body.error.code, "invalid_parameter");
  assert.equal(unsupportedPrediction.body.error.message, "prediction is unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidN = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      n: 2,
      stream: false,
    },
  });

  assert.equal(invalidN.status, 400);
  assert.equal(invalidN.body.error.type, "invalid_request_error");
  assert.equal(invalidN.body.error.code, "invalid_parameter");
  assert.equal(invalidN.body.error.message, "n must be 1; multiple choices are unsupported");
  assert.equal(upstreamCalls, 0);

  const invalidStop = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      stop: ["END", 123],
      stream: false,
    },
  });

  assert.equal(invalidStop.status, 400);
  assert.equal(invalidStop.body.error.type, "invalid_request_error");
  assert.equal(invalidStop.body.error.code, "invalid_parameter");
  assert.equal(invalidStop.body.error.message, "stop must be a string or array of strings");
  assert.equal(upstreamCalls, 0);

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

  for (const invalid of invalidTools) {
    const invalidToolsResp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
        tools: invalid.tools,
        stream: false,
      },
    });

    assert.equal(invalidToolsResp.status, 400);
    assert.equal(invalidToolsResp.body.error.type, "invalid_request_error");
    assert.equal(invalidToolsResp.body.error.code, "invalid_parameter");
    assert.equal(invalidToolsResp.body.error.message, invalid.message);
    assert.equal(upstreamCalls, 0);
  }
});

test("Codex chat completions rejects invalid tool_choice before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-tool-choice-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid tool_choice");
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
      tool_choice: "sometimes",
      stream: false,
    },
  });

  assert.equal(resp.status, 400);
  assert.equal(resp.body.error.type, "invalid_request_error");
  assert.equal(resp.body.error.code, "invalid_parameter");
  assert.equal(
    resp.body.error.message,
    "tool_choice must be one of auto, none, required, a function tool choice, a custom tool choice, or an image_generation tool choice"
  );
  assert.equal(upstreamCalls, 0);
});

test("Codex chat completions maps custom tools and tool_choice to Responses", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-custom-tools-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
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

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.tools, [{
    type: "custom",
    name: "render_markdown",
    description: "Render markdown text",
    format: { type: "text" },
  }]);
  assert.deepEqual(calls[0]?.body.tool_choice, { type: "custom", name: "render_markdown" });
});

test("Codex chat completions maps legacy functions and function_call to Responses", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-legacy-functions-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const parameters = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  };
  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "weather in Paris?" }],
      functions: [{
        name: "lookup_weather",
        description: "Look up weather",
        parameters,
      }],
      function_call: { name: "lookup_weather" },
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.tools, [{
    type: "function",
    name: "lookup_weather",
    description: "Look up weather",
    parameters,
    strict: false,
  }]);
  assert.deepEqual(calls[0]?.body.tool_choice, { type: "function", name: "lookup_weather" });
});

test("Codex chat completions returns legacy function_call for legacy functions requests", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-legacy-function-response-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => makeStreamResponse([
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_weather_1\",\"name\":\"lookup_weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
    "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
  ])) as typeof fetch;

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
      messages: [{ role: "user", content: "weather in Paris?" }],
      functions: [{
        name: "lookup_weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(resp.body.choices[0].message.function_call, {
    name: "lookup_weather",
    arguments: "{\"city\":\"Paris\"}",
  });
  assert.equal(resp.body.choices[0].message.tool_calls, undefined);
  assert.equal(resp.body.choices[0].finish_reason, "function_call");
});

test("Codex chat completions maps legacy function call messages to Responses", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-legacy-function-messages-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
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
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: null,
          function_call: { name: "lookup_weather", arguments: "{\"city\":\"Paris\"}" },
        },
        { role: "function", name: "lookup_weather", content: "sunny" },
        { role: "user", content: "thanks" },
      ],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.input, [
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

test("Codex chat completions maps allowed_tools tool_choice to Responses", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-allowed-tools-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
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
      tools: [{
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          strict: true,
        },
      }],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [{ type: "function", function: { name: "lookup_weather" } }],
        },
      },
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.tools, [{
    type: "function",
    name: "lookup_weather",
    description: "Look up weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    strict: true,
  }]);
  assert.deepEqual(calls[0]?.body.tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: "lookup_weather" }],
  });
});

test("Codex chat completions round-trips custom tool calls through Responses", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-custom-roundtrip-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"output\":[{\"type\":\"custom_tool_call\",\"call_id\":\"call_custom_2\",\"name\":\"render_markdown\",\"input\":\"**bye**\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
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
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_custom_1",
            type: "custom",
            custom: { name: "render_markdown", input: "**hello**" },
          }],
        },
        { role: "tool", tool_call_id: "call_custom_1", content: "<strong>hello</strong>" },
        { role: "user", content: "continue" },
      ],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.input, [
    { type: "custom_tool_call", call_id: "call_custom_1", name: "render_markdown", input: "**hello**" },
    { type: "custom_tool_call_output", call_id: "call_custom_1", output: "<strong>hello</strong>" },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(resp.body.choices[0].message.tool_calls, [{
    id: "call_custom_2",
    type: "custom",
    custom: { name: "render_markdown", input: "**bye**" },
  }]);
  assert.equal(resp.body.choices[0].finish_reason, "tool_calls");
});

test("Codex chat completions retries once with refreshed auth after upstream 401", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-401-refresh-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "stale-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ auth?: string }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ auth: headers?.Authorization });

    if (calls.length === 1) {
      writeAuth(authFile, "fresh-token");
      return new Response("unauthorized", { status: 401 });
    }

    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"recovered\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
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

  assert.equal(resp.status, 200);
  assert.deepEqual(calls.map((call) => call.auth), [
    "Bearer stale-token",
    "Bearer fresh-token",
  ]);
  assert.equal(resp.body.choices[0].message.content, "recovered");
});

test("Codex chat completions returns upstream invalid response for invalid JSON", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-invalid-json-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream returned invalid JSON");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_invalid_response");
});

test("Codex chat completions returns upstream network error when upstream SSE is truncated", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-truncated-sse-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_truncated\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"partial\"}\n\n",
    ]);
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

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream stream ended before completion");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_network_error");
});

test("Codex chat completions preserves upstream SSE error events", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-sse-error-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return makeStreamResponse([
      "event: error\ndata: {\"type\":\"error\",\"code\":\"rate_limit_exceeded\",\"message\":\"Upstream quota exhausted\",\"param\":null,\"sequence_number\":1}\n\n",
    ]);
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

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream quota exhausted");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "rate_limit_exceeded");
});

test("Codex chat completions treats response.incomplete as a terminal length finish", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-incomplete-sse-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_incomplete\",\"model\":\"gpt-5.4\",\"status\":\"in_progress\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"partial\"}\n\n",
      "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"sequence_number\":3,\"response\":{\"id\":\"resp_incomplete\",\"model\":\"gpt-5.4\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
    ]);
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

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "partial");
  assert.equal(resp.body.choices[0].finish_reason, "length");
});

test("Codex chat completions preserves response.failed details", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-failed-sse-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return makeStreamResponse([
      "event: response.failed\ndata: {\"type\":\"response.failed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_failed\",\"model\":\"gpt-5.4\",\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"Model execution failed\"}}}\n\n",
    ]);
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

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Model execution failed");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "server_error");
});

test("Codex chat completions returns upstream timeout when upstream fetch times out", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-timeout-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
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

  assert.equal(resp.status, 504);
  assert.equal(resp.body.error.message, "Codex upstream request timed out");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_timeout");
});

test("Codex chat completions returns upstream network error when upstream fetch fails", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-network-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  let calls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    throw new TypeError("fetch failed");
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

  assert.equal(calls, 2);
  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Codex upstream network error");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_network_error");
});

test("Codex chat completions returns controlled error when auth file is missing", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-missing-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("Upstream should not be called when auth is missing");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleChatCompletions());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
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
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "codex_auth_unavailable");
  assert.match(String(resp.body.error.message), /auth/i);
});

test("Codex chat completions returns controlled error when auth file is malformed", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-malformed-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-chat-home-"));
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

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleChatCompletions());
  });

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
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
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "codex_auth_unavailable");
  assert.match(String(resp.body.error.message), /access_token/i);
});
