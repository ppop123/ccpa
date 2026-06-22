import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import express from "express";
import { CodexProvider } from "../src/providers/codex";
import { Config } from "../src/config";

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
  app.post("/v1/responses", handler);
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

async function requestText(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: string }> {
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

test("Codex responses handler sends bearer token and maps response", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-"));
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
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"created_at\":1711756800,\"status\":\"in_progress\",\"model\":\"gpt-5.4\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"hello from codex\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"created_at\":1711756800,\"status\":\"completed\",\"model\":\"gpt-5.4\",\"service_tier\":\"priority\",\"usage\":{\"input_tokens\":12,\"output_tokens\":8,\"total_tokens\":20}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      instructions: "You are concise.",
      input: [{ role: "user", content: "hello" }],
      background: false,
      reasoning: { effort: "high", summary: "concise", generate_summary: "detailed" },
      parallel_tool_calls: false,
      max_tool_calls: 3,
      service_tier: "priority",
      safety_identifier: "user-hash-42",
      user: "legacy-user-42",
      prompt_cache_key: "project:responses:user-42",
      prompt_cache_retention: "24h",
      truncation: "auto",
      previous_response_id: "resp_prev_123",
      context_management: [{ type: "compaction", compact_threshold: 2000 }],
      prompt: {
        id: "pmpt_123",
        version: "7",
        variables: {
          name: "Wy",
          avatar: { type: "input_image", image_url: "https://example.com/avatar.png", detail: "low" },
          brief: { type: "input_text", text: "Keep it concise." },
          spec: { type: "input_file", file_id: "file_123" },
        },
      },
      include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
      temperature: 1.7,
      top_logprobs: 5,
      top_p: 0.9,
      text: { verbosity: "high" },
      metadata: { tenant: "personal", workflow: "responses" },
    },
  });

  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(calls[0]?.auth, "Bearer codex-access-token");
  assert.equal(calls[0]?.accept, "text/event-stream");
  assert.equal(calls[0]?.body.model, "gpt-5.4");
  assert.equal(calls[0]?.body.instructions, "You are concise.");
  assert.equal(calls[0]?.body.background, false);
  assert.equal(calls[0]?.body.store, false);
  assert.equal(calls[0]?.body.stream, true);
  assert.deepEqual(calls[0]?.body.reasoning, { effort: "high", summary: "concise", generate_summary: "detailed" });
  assert.equal(calls[0]?.body.parallel_tool_calls, false);
  assert.equal(calls[0]?.body.max_tool_calls, 3);
  assert.equal(calls[0]?.body.service_tier, "priority");
  assert.equal(calls[0]?.body.safety_identifier, "user-hash-42");
  assert.equal(calls[0]?.body.user, "legacy-user-42");
  assert.equal(calls[0]?.body.prompt_cache_key, "project:responses:user-42");
  assert.equal(calls[0]?.body.prompt_cache_retention, "24h");
  assert.equal(calls[0]?.body.truncation, "auto");
  assert.equal(calls[0]?.body.previous_response_id, "resp_prev_123");
  assert.deepEqual(calls[0]?.body.context_management, [{ type: "compaction", compact_threshold: 2000 }]);
  assert.deepEqual(calls[0]?.body.prompt, {
    id: "pmpt_123",
    version: "7",
    variables: {
      name: "Wy",
      avatar: { type: "input_image", image_url: "https://example.com/avatar.png", detail: "low" },
      brief: { type: "input_text", text: "Keep it concise." },
      spec: { type: "input_file", file_id: "file_123" },
    },
  });
  assert.deepEqual(calls[0]?.body.include, ["reasoning.encrypted_content", "message.output_text.logprobs"]);
  assert.equal(calls[0]?.body.temperature, 1.7);
  assert.equal(calls[0]?.body.top_logprobs, 5);
  assert.equal(calls[0]?.body.top_p, 0.9);
  assert.deepEqual(calls[0]?.body.text, { verbosity: "high" });
  assert.deepEqual(calls[0]?.body.metadata, { tenant: "personal", workflow: "responses" });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "response");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.service_tier, "priority");
  assert.equal(resp.body.output[0].content[0].text, "hello from codex");
  assert.equal(resp.body.usage.total_tokens, 20);
});

test("Codex responses handler preserves response.output_text.done text without deltas", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-output-text-done-"));
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

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello",
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.output[0].content[0].text, "final text from done");
});

test("Codex responses handler passes stream_options for streaming clients", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-stream-options-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_stream_options\",\"object\":\"response\",\"created_at\":1711756800,\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestText({
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

  assert.equal(resp.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.stream_options, { include_obfuscation: false });
  assert.match(String(resp.body), /response\.completed/);
});

test("Codex responses handler normalizes string input to a user message", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-string-"));
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

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello as a string",
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.input, [{ role: "user", content: "hello as a string" }]);
});

test("Codex responses handler validates instructions before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-instructions-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid instructions");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const instructions of [42, { text: "hello" }, null]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        instructions,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "instructions must be a string");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates background before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-background-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid background");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const background of ["true", null]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        background,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "background must be a boolean");
  }

  const unsupported = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
      background: true,
    },
  });

  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.type, "invalid_request_error");
  assert.equal(unsupported.body.error.code, "invalid_parameter");
  assert.equal(unsupported.body.error.message, "background true is unsupported for Codex responses models");
  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates context_management before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-context-management-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid context_management");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { context_management: {}, message: "context_management must be an array" },
    { context_management: [null], message: "context_management[0] must be an object" },
    { context_management: [{ type: "memory" }], message: "context_management[0].type must be compaction" },
    {
      context_management: [{ type: "compaction", compact_threshold: "1000" }],
      message: "context_management[0].compact_threshold must be a number",
    },
    {
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
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        context_management: invalid.context_management,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates prompt before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-prompt-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid prompt");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { prompt: "pmpt_123", message: "prompt must be an object" },
    { prompt: null, message: "prompt must be an object" },
    { prompt: { version: "1" }, message: "prompt.id must be a string" },
    { prompt: { id: "pmpt_123", version: 1 }, message: "prompt.version must be a string" },
    { prompt: { id: "pmpt_123", variables: [] }, message: "prompt.variables must be an object" },
    {
      prompt: { id: "pmpt_123", variables: { count: 3 } },
      message: "prompt.variables.count must be a string or response input object",
    },
    {
      prompt: { id: "pmpt_123", variables: { brief: { type: "input_text" } } },
      message: "prompt.variables.brief.text is required",
    },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        prompt: invalid.prompt,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates max_tool_calls before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-max-tool-calls-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid max_tool_calls");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = ["2", null, true];

  for (const maxToolCalls of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        max_tool_calls: maxToolCalls,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "max_tool_calls must be a number");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates safety_identifier before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-safety-id-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid safety_identifier");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { safety_identifier: 42, message: "safety_identifier must be a string" },
    { safety_identifier: null, message: "safety_identifier must be a string" },
    { safety_identifier: "u".repeat(65), message: "safety_identifier must be at most 64 characters" },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        safety_identifier: invalid.safety_identifier,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates user before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-user-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid user");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const user of [42, null]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        user,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "user must be a string");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler uses configured default store", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-store-"));
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

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.store, true);
});

test("Codex responses handler preserves explicit store from client request", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-explicit-store-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile, false));
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

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
      store: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.store, true);
});

test("Codex responses handler validates store before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-store-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid store");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const store of ["false", 1, null]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        store,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "store must be a boolean");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler retries once with refreshed auth after upstream 401", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-401-refresh-"));
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
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"created_at\":1711756800,\"status\":\"in_progress\",\"model\":\"gpt-5.4\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"recovered\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"created_at\":1711756800,\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls.map((call) => call.auth), [
    "Bearer stale-token",
    "Bearer fresh-token",
  ]);
  assert.equal(resp.body.output[0].content[0].text, "recovered");
});

test("Codex responses handler converts system input role to developer", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-system-"));
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

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: [
        { role: "system", content: "be precise" },
        { role: "user", content: "hello" },
      ],
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.store, false);
  assert.equal(calls[0]?.body.stream, true);
  assert.equal(calls[0]?.body.input[0].role, "developer");
  assert.equal(calls[0]?.body.input[1].role, "user");
});

test("Codex responses handler validates max_output_tokens before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-max-output-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid max_output_tokens");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const maxOutputTokens of ["32", 0]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        max_output_tokens: maxOutputTokens,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "max_output_tokens must be a positive integer");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates reasoning fields before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-reasoning-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid reasoning effort");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { reasoning: "low", message: "reasoning must be an object" },
    {
      reasoning: { effort: "mega" },
      message: "reasoning.effort must be one of none, minimal, low, medium, high, xhigh",
    },
    {
      reasoning: { effort: 1 },
      message: "reasoning.effort must be one of none, minimal, low, medium, high, xhigh",
    },
    {
      reasoning: { summary: "verbose" },
      message: "reasoning.summary must be one of auto, concise, detailed",
    },
    {
      reasoning: { summary: 1 },
      message: "reasoning.summary must be one of auto, concise, detailed",
    },
    {
      reasoning: { generate_summary: "short" },
      message: "reasoning.generate_summary must be one of auto, concise, detailed",
    },
    {
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
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        reasoning: invalid.reasoning,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates sampling parameters before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-sampling-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid sampling parameters");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { body: { temperature: "0.7" }, message: "temperature must be a number between 0 and 2" },
    { body: { temperature: 3 }, message: "temperature must be a number between 0 and 2" },
    { body: { top_p: -0.1 }, message: "top_p must be a number between 0 and 1" },
    { body: { top_p: 2 }, message: "top_p must be a number between 0 and 1" },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates top_logprobs before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-top-logprobs-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid top_logprobs");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = ["3", 1.5, -1, 21];

  for (const topLogprobs of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        top_logprobs: topLogprobs,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "top_logprobs must be an integer between 0 and 20");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates parallel_tool_calls before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-parallel-tools-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid parallel_tool_calls");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const parallelToolCalls of ["false", 1]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        parallel_tool_calls: parallelToolCalls,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "parallel_tool_calls must be a boolean");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler passes custom tools and custom tool calls to upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-custom-tools-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_custom_tool\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"output\":[{\"type\":\"custom_tool_call\",\"call_id\":\"call_custom_2\",\"name\":\"render_markdown\",\"input\":\"**bye**\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
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

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.input, [
    { type: "custom_tool_call", call_id: "call_custom_1", name: "render_markdown", input: "**hello**" },
    { type: "custom_tool_call_output", call_id: "call_custom_1", output: "<strong>hello</strong>" },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(calls[0]?.body.tools, [{
    type: "custom",
    name: "render_markdown",
    description: "Render markdown text",
    format: { type: "text" },
  }]);
  assert.deepEqual(calls[0]?.body.tool_choice, { type: "custom", name: "render_markdown" });
  assert.deepEqual(resp.body.output, [{
    type: "custom_tool_call",
    call_id: "call_custom_2",
    name: "render_markdown",
    input: "**bye**",
  }]);
});

test("Codex responses handler passes allowed_tools tool_choice to upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-allowed-tools-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    return makeStreamResponse([
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_allowed_tools\",\"model\":\"gpt-5.4\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":2}\n\n",
    ]);
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
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

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: "use one of the allowed tools",
      tools: [
        {
          type: "function",
          name: "lookup_weather",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "custom",
          name: "render_markdown",
          format: { type: "text" },
        },
        { type: "image_generation" },
      ],
      tool_choice: toolChoice,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls[0]?.body.tool_choice, toolChoice);
});

test("Codex responses handler rejects unsupported hosted tool_choice before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-hosted-tool-choice-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for unsupported hosted tool_choice");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
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

  for (const tool_choice of choices) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: "use a hosted tool",
        tool_choice,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(
      resp.body.error.message,
      `tool_choice ${tool_choice.type} is unsupported for Codex responses models`
    );
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler rejects unsupported hosted tools before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-hosted-tools-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for unsupported hosted tools");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
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

  for (const tool of tools) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: "use a hosted tool",
        tools: [tool],
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.message, "tools[0].type is unsupported for Codex responses models");
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates service_tier before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-service-tier-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid service_tier");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const serviceTier of ["express", 1]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        service_tier: serviceTier,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "service_tier must be one of auto, default, flex, scale, priority");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates prompt cache parameters before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-prompt-cache-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid prompt cache parameters");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { body: { prompt_cache_key: 42 }, message: "prompt_cache_key must be a string" },
    { body: { prompt_cache_retention: "1h" }, message: "prompt_cache_retention must be one of in-memory, 24h" },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates truncation before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-truncation-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid truncation");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const truncation of ["left", 1]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        truncation,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "truncation must be one of auto, disabled");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates previous_response_id before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-previous-response-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid previous_response_id");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const previous_response_id of [42, { id: "resp_prev" }]) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        previous_response_id,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, "previous_response_id must be a string");
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates conversation before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-conversation-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid conversation");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { body: { conversation: 42 }, message: "conversation must be a string or object with an id string" },
    { body: { conversation: {} }, message: "conversation must be a string or object with an id string" },
    { body: { conversation: { id: 42 } }, message: "conversation must be a string or object with an id string" },
    {
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
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates include before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-include-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid include");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const includeValueError =
    "include values must be one of file_search_call.results, web_search_call.results, web_search_call.action.sources, message.input_image.image_url, computer_call_output.output.image_url, code_interpreter_call.outputs, reasoning.encrypted_content, message.output_text.logprobs";
  const invalids = [
    { include: "reasoning.encrypted_content", message: "include must be an array" },
    { include: [42], message: includeValueError },
    { include: ["unknown.include"], message: includeValueError },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        include: invalid.include,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates stream_options before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-stream-options-invalid-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid stream_options");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { body: { stream: true, stream_options: "none" }, message: "stream_options must be an object" },
    { body: { stream: true, stream_options: [] }, message: "stream_options must be an object" },
    { body: { stream_options: {} }, message: "stream_options can only be set when stream is true" },
    { body: { stream: false, stream_options: {} }, message: "stream_options can only be set when stream is true" },
    {
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
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        ...invalid.body,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates metadata before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-metadata-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid metadata");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { metadata: "tenant", message: "metadata must be an object" },
    {
      metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key_${index}`, "value"])),
      message: "metadata must contain at most 16 key-value pairs",
    },
    { metadata: { ["k".repeat(65)]: "value" }, message: "metadata keys must be at most 64 characters" },
    { metadata: { tenant: 42 }, message: "metadata values must be strings" },
    { metadata: { tenant: "v".repeat(513) }, message: "metadata values must be at most 512 characters" },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        metadata: invalid.metadata,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler validates text format before auth and upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-text-format-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  let upstreamCalls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls++;
    throw new Error("Upstream should not be called for invalid text format");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const invalids = [
    { text: "json", message: "text must be an object" },
    { text: { format: "json_object" }, message: "text.format must be an object" },
    {
      text: { format: { type: "xml" } },
      message: "text.format.type must be one of text, json_object, json_schema",
    },
    { text: { format: { type: "json_schema" } }, message: "text.format.name is required" },
    { text: { format: { type: "json_schema", name: "answer" } }, message: "text.format.schema is required" },
    {
      text: { format: { type: "json_schema", name: "answer", schema: "object" } },
      message: "text.format.schema must be an object",
    },
    { text: { verbosity: "quiet" }, message: "text.verbosity must be one of low, medium, high" },
    { text: { verbosity: 1 }, message: "text.verbosity must be one of low, medium, high" },
  ];

  for (const invalid of invalids) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
        text: invalid.text,
      },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.equal(resp.body.error.message, invalid.message);
  }

  assert.equal(upstreamCalls, 0);
});

test("Codex responses handler returns upstream timeout when upstream fetch times out", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-timeout-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello",
    },
  });

  assert.equal(resp.status, 504);
  assert.equal(resp.body.error.message, "Codex upstream request timed out");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_timeout");
});

test("Codex responses handler returns upstream network error when upstream fetch fails", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-network-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  let calls = 0;

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello",
    },
  });

  assert.equal(calls, 2);
  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Codex upstream network error");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_network_error");
});

test("Codex responses handler returns upstream network error when upstream SSE is truncated", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-truncated-sse-"));
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

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello",
      stream: false,
    },
  });

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream stream ended before completion");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "upstream_network_error");
});

test("Codex responses handler preserves upstream SSE error events", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-sse-error-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return makeStreamResponse([
      "event: error\ndata: {\"type\":\"error\",\"code\":\"rate_limit_exceeded\",\"message\":\"Upstream quota exhausted\",\"param\":null,\"sequence_number\":1}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello",
      stream: false,
    },
  });

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Upstream quota exhausted");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "rate_limit_exceeded");
});

test("Codex responses handler treats response.incomplete as terminal", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-incomplete-sse-"));
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

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello",
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.status, "incomplete");
  assert.equal(resp.body.output[0].content[0].text, "partial");
});

test("Codex responses handler preserves response.failed details", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-failed-sse-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    return makeStreamResponse([
      "event: response.failed\ndata: {\"type\":\"response.failed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_failed\",\"model\":\"gpt-5.4\",\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"Model execution failed\"}}}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

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
      model: "gpt-5.4",
      input: "hello",
      stream: false,
    },
  });

  assert.equal(resp.status, 502);
  assert.equal(resp.body.error.message, "Model execution failed");
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "server_error");
});

test("Codex responses handler returns controlled error when auth file is missing", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-missing-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
  const authFile = path.join(authDir, ".codex", "auth.json");

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("Upstream should not be called when auth is missing");
  }) as typeof fetch;

  const server = await withHomeDir(tmpHome, async () => {
    const provider = new CodexProvider(makeConfig(authDir, authFile));
    return startApp(provider.handleResponses());
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
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "codex_auth_unavailable");
  assert.match(String(resp.body.error.message), /auth/i);
});

test("Codex responses handler returns controlled error when auth file is malformed", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-malformed-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-home-"));
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
    return startApp(provider.handleResponses());
  });

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(resp.body.error.type, "api_error");
  assert.equal(resp.body.error.code, "codex_auth_unavailable");
  assert.match(String(resp.body.error.message), /access_token/i);
});
