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
      models: [
        "grok-4.6",
        "grok-4.5",
        "grok-4.3",
        "grok-build-0.1",
        "grok-imagine-image-2.0",
        "grok-imagine-image",
      ],
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

async function requestText(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
            body: data,
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

async function requestRaw(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body: string;
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
          "Content-Length": Buffer.byteLength(options.body).toString(),
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
    req.write(options.body);
    req.end();
  });
}

test("GrokProvider forwards Grok 4.6 chat completions with xhigh reasoning", async (t) => {
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
        model: "grok-4.6",
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
      model: "grok-4.6",
      messages: [{ role: "user", content: "Reply exactly: ok" }],
      reasoning_effort: "xhigh",
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.equal(calls[0].body.model, "grok-4.6");
  assert.equal(calls[0].body.reasoning_effort, "xhigh");
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "Reply exactly: ok" }]);
});

test("GrokProvider rejects non-boolean stream values on Chat before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-chat-stream-validation-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  let upstreamCalls = 0;
  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const server = await startHandler(provider.handleChatCompletions(), "/v1/chat/completions");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases = [
    { stream: "true" },
    { stream: 1, search_parameters: { mode: "off" } },
  ];
  for (const fields of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "grok-4.6",
        messages: [{ role: "user", content: "Do not forward this" }],
        ...fields,
      },
    });
    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.type, "invalid_request_error");
    assert.equal(resp.body.error.code, "invalid_parameter");
    assert.match(resp.body.error.message, /stream must be a boolean/);
  }
  assert.equal(upstreamCalls, 0);
});

test("GrokProvider passes through ordinary Chat SSE when legacy search is inactive", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-chat-stream-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; accept?: string; body: any }> = [];
  const sse =
    'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
    "data: [DONE]\n\n";
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(input),
      accept: headers?.Accept,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }) as typeof fetch;
  const server = await startHandler(provider.handleChatCompletions(), "/v1/chat/completions");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases = [
    {
      model: "grok-4.6",
      messages: [{ role: "user", content: "Stream without search" }],
      stream: true,
    },
    {
      model: "grok-4.6",
      messages: [{ role: "user", content: "Stream with search disabled" }],
      search_parameters: { mode: "off" },
      stream: true,
    },
  ];

  for (const body of cases) {
    const resp = await requestText({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      body,
    });
    assert.equal(resp.status, 200);
    assert.match(String(resp.headers["content-type"]), /^text\/event-stream/);
    assert.equal(resp.body, sse);
  }

  assert.deepEqual(calls, [
    {
      url: "https://api.x.ai/v1/chat/completions",
      accept: "text/event-stream",
      body: cases[0],
    },
    {
      url: "https://api.x.ai/v1/chat/completions",
      accept: "text/event-stream",
      body: {
        model: "grok-4.6",
        messages: [{ role: "user", content: "Stream with search disabled" }],
        stream: true,
      },
    },
  ]);
});

test("GrokProvider bridges non-stream legacy Live Search chat through Responses Agent Tools", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-bridge-"));
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
        id: "resp_grok_search",
        object: "response",
        created_at: 456,
        status: "completed",
        model: "grok-4.5",
        output: [
          { id: "search_1", type: "web_search_call", status: "completed" },
          {
            id: "msg_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "xAI released an update [[1]](https://x.ai/news/example).",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://x.ai/news/example",
                    title: "Example release",
                    start_index: 23,
                    end_index: 60,
                  },
                ],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 7,
          num_sources_used: 1,
          cost_in_usd_ticks: 123,
        },
        citations: [
          { url: "https://x.ai/news/example" },
          "https://x.ai/news/top-level",
        ],
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

  const messages = [
    { role: "system", content: "Answer with current sources." },
    { role: "user", content: "What did xAI release?" },
  ];
  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-4.5",
      messages,
      search_parameters: {
        mode: "auto",
        sources: [
          { type: "web", allowed_websites: ["x.ai"] },
          { type: "x", included_x_handles: ["xai"] },
        ],
        return_citations: true,
      },
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.id, "resp_grok_search");
  assert.equal(resp.body.created, 456);
  assert.equal(
    resp.body.choices[0].message.content,
    "xAI released an update [[1]](https://x.ai/news/example)."
  );
  assert.equal(resp.body.choices[0].finish_reason, "stop");
  assert.deepEqual(resp.body.citations, [
    "https://x.ai/news/example",
    "https://x.ai/news/top-level",
  ]);
  assert.deepEqual(resp.body.usage, {
    prompt_tokens: 10,
    completion_tokens: 7,
    total_tokens: 17,
    num_sources_used: 1,
    cost_in_usd_ticks: 123,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.deepEqual(calls[0].body, {
    model: "grok-4.5",
    input: messages,
    tools: [
      { type: "web_search", filters: { allowed_domains: ["x.ai"] } },
      {
        type: "x_search",
        allowed_x_handles: ["xai"],
      },
    ],
    tool_choice: "auto",
    stream: false,
  });
});

test("GrokProvider translates legacy dates when X is the sole search source", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-date-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: any[] = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    calls.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
    return new Response(
      JSON.stringify({
        id: "resp_grok_x_date",
        object: "response",
        created_at: 457,
        status: "completed",
        model: "grok-4.5",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "X result", annotations: [] }],
          },
        ],
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
    body: {
      model: "grok-4.5",
      messages: [{ role: "user", content: "Search X in this date range" }],
      search_parameters: {
        sources: [{ type: "x", included_x_handles: ["xai"] }],
        from_date: "2026-08-01",
        to_date: "2026-08-15",
      },
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(calls, [
    {
      model: "grok-4.5",
      input: [{ role: "user", content: "Search X in this date range" }],
      tools: [
        {
          type: "x_search",
          allowed_x_handles: ["xai"],
          from_date: "2026-08-01",
          to_date: "2026-08-15",
        },
      ],
      tool_choice: "auto",
      stream: false,
    },
  ]);
});

test("GrokProvider rejects legacy Live Search streaming and lossy parameters before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-validation-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  let upstreamCalls = 0;
  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const server = await startHandler(provider.handleChatCompletions(), "/v1/chat/completions");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const streaming = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    body: {
      model: "grok-4.5",
      messages: [{ role: "user", content: "Search the web" }],
      search_parameters: { mode: "auto" },
      stream: true,
    },
  });
  assert.equal(streaming.status, 400);
  assert.equal(streaming.body.error.type, "invalid_request_error");
  assert.equal(streaming.body.error.code, "legacy_live_search_streaming_unsupported");
  assert.match(streaming.body.error.message, /\/v1\/responses/);

  const lossy = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    body: {
      model: "grok-4.5",
      messages: [{ role: "user", content: "Search the web" }],
      search_parameters: { mode: "auto", max_search_results: 5 },
      stream: false,
    },
  });
  assert.equal(lossy.status, 400);
  assert.equal(lossy.body.error.type, "invalid_request_error");
  assert.equal(lossy.body.error.code, "unsupported_legacy_search_parameter");
  assert.match(lossy.body.error.message, /max_search_results/);
  assert.equal(upstreamCalls, 0);
});

test("GrokProvider strips disabled legacy search and treats null stream as non-stream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-off-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; accept?: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(input),
      accept: headers?.Accept,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(
      JSON.stringify({
        id: "chatcmpl_search_off",
        object: "chat.completion",
        model: "grok-4.5",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
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
    body: {
      model: "grok-4.5",
      messages: [{ role: "user", content: "Do not search" }],
      search_parameters: { mode: "off" },
      temperature: 0.2,
      stream: null,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(calls[0].accept, "application/json");
  assert.deepEqual(calls[0].body, {
    model: "grok-4.5",
    messages: [{ role: "user", content: "Do not search" }],
    temperature: 0.2,
    stream: null,
  });
});

test("GrokProvider maps required default search tools and suppresses legacy citations", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-required-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(
      JSON.stringify({
        id: "resp_required_search",
        object: "response",
        created_at: 789,
        status: "completed",
        model: "grok-4.6",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Search result",
                annotations: [{ type: "url_citation", url: "https://example.com/private" }],
              },
            ],
          },
        ],
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
    body: {
      model: "grok-4.6",
      messages: [{ role: "user", content: "Search now" }],
      reasoning_effort: "xhigh",
      max_completion_tokens: 2048,
      search_parameters: { mode: "on", return_citations: false },
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "Search result");
  assert.equal("citations" in resp.body, false);
  assert.deepEqual(calls, [
    {
      url: "https://api.x.ai/v1/responses",
      body: {
        model: "grok-4.6",
        input: [{ role: "user", content: "Search now" }],
        tools: [{ type: "web_search" }, { type: "x_search" }],
        tool_choice: "required",
        stream: false,
        max_output_tokens: 2048,
        reasoning: { effort: "xhigh" },
        include: ["no_inline_citations"],
      },
    },
  ]);
});

test("GrokProvider fails closed for legacy search fields that cannot be translated", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-lossy-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  let upstreamCalls = 0;
  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  const server = await startHandler(provider.handleChatCompletions(), "/v1/chat/completions");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const cases = [
    {
      name: "news source",
      body: { search_parameters: { sources: [{ type: "news" }] } },
      code: "unsupported_legacy_search_parameter",
      message: /news/,
    },
    {
      name: "web country",
      body: { search_parameters: { sources: [{ type: "web", country: "US" }] } },
      code: "unsupported_legacy_search_parameter",
      message: /country/,
    },
    {
      name: "Chat function tools",
      body: {
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        search_parameters: {},
      },
      code: "unsupported_legacy_search_parameter",
      message: /Chat field tools/,
    },
    {
      name: "date without X source",
      body: {
        search_parameters: {
          sources: [{ type: "web" }],
          from_date: "2026-08-01",
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /X search source/,
    },
    {
      name: "date with default web and X sources",
      body: { search_parameters: { from_date: "2026-08-01" } },
      code: "unsupported_legacy_search_parameter",
      message: /sole X search source/,
    },
    {
      name: "date with explicit web and X sources",
      body: {
        search_parameters: {
          sources: [{ type: "web" }, { type: "x" }],
          to_date: "2026-08-15",
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /sole X search source/,
    },
    {
      name: "invalid mode",
      body: { search_parameters: { mode: "always" } },
      code: "invalid_parameter",
      message: /mode/,
    },
    {
      name: "non-boolean stream",
      body: { search_parameters: {}, stream: "true" },
      code: "invalid_parameter",
      message: /stream must be a boolean/,
    },
    {
      name: "numeric stream while search is disabled",
      body: { search_parameters: { mode: "off" }, stream: 1 },
      code: "invalid_parameter",
      message: /stream must be a boolean/,
    },
    {
      name: "non-object search parameters",
      body: { search_parameters: [] },
      code: "invalid_parameter",
      message: /search_parameters must be an object/,
    },
    {
      name: "duplicate source types",
      body: { search_parameters: { sources: [{ type: "x" }, { type: "x" }] } },
      code: "unsupported_legacy_search_parameter",
      message: /Duplicate x search sources/,
    },
    {
      name: "web allow and exclude conflict",
      body: {
        search_parameters: {
          sources: [
            {
              type: "web",
              allowed_websites: ["x.ai"],
              excluded_websites: ["example.com"],
            },
          ],
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /allowed_websites and web.excluded_websites cannot both/,
    },
    {
      name: "X include and exclude conflict",
      body: {
        search_parameters: {
          sources: [
            {
              type: "x",
              included_x_handles: ["xai"],
              excluded_x_handles: ["spam"],
            },
          ],
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /included and excluded X handles cannot both/,
    },
    {
      name: "X engagement filter",
      body: {
        search_parameters: {
          sources: [{ type: "x", post_view_count: 100 }],
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /X engagement filters/,
    },
    {
      name: "unknown per-source field",
      body: {
        search_parameters: {
          sources: [{ type: "web", unsupported_filter: true }],
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /web source field unsupported_filter/,
    },
    {
      name: "unknown X source field",
      body: {
        search_parameters: {
          sources: [{ type: "x", unsupported_filter: true }],
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /x source field unsupported_filter/,
    },
    {
      name: "conflicting X include aliases",
      body: {
        search_parameters: {
          sources: [
            {
              type: "x",
              included_x_handles: ["xai"],
              x_handles: ["grok"],
            },
          ],
        },
      },
      code: "unsupported_legacy_search_parameter",
      message: /only one of included_x_handles or x_handles/,
    },
    {
      name: "multiple Chat choices",
      body: { search_parameters: {}, n: 2 },
      code: "unsupported_legacy_search_parameter",
      message: /n values other than 1/,
    },
    {
      name: "conflicting token limits",
      body: { search_parameters: {}, max_tokens: 100, max_completion_tokens: 200 },
      code: "unsupported_legacy_search_parameter",
      message: /Conflicting max_tokens and max_completion_tokens/,
    },
    {
      name: "non-boolean citation control",
      body: { search_parameters: { return_citations: "yes" } },
      code: "invalid_parameter",
      message: /return_citations must be a boolean/,
    },
    {
      name: "conflicting reasoning fields",
      body: {
        search_parameters: {},
        reasoning_effort: "high",
        reasoning: { effort: "low" },
      },
      code: "unsupported_legacy_search_parameter",
      message: /only one of reasoning_effort or reasoning/,
    },
    {
      name: "non-array messages",
      body: { messages: "Search the web", search_parameters: {} },
      code: "invalid_parameter",
      message: /messages must be a non-empty array/,
    },
    {
      name: "multimodal Chat content",
      body: {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/input.png" } }],
          },
        ],
        search_parameters: {},
      },
      code: "unsupported_legacy_search_parameter",
      message: /simple text messages/,
    },
    {
      name: "string token limit",
      body: { search_parameters: {}, max_completion_tokens: "2048" },
      code: "invalid_parameter",
      message: /max_completion_tokens must be a positive integer/,
    },
    {
      name: "zero token limit",
      body: { search_parameters: {}, max_tokens: 0 },
      code: "invalid_parameter",
      message: /max_tokens must be a positive integer/,
    },
  ];

  for (const item of cases) {
    const resp = await requestJson({
      server,
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "grok-4.5",
        messages: [{ role: "user", content: item.name }],
        stream: false,
        ...item.body,
      },
    });
    assert.equal(resp.status, 400, item.name);
    assert.equal(resp.body.error.type, "invalid_request_error", item.name);
    assert.equal(resp.body.error.code, item.code, item.name);
    assert.match(resp.body.error.message, item.message, item.name);
  }
  assert.equal(upstreamCalls, 0);
});

test("GrokProvider maps incomplete legacy search responses with and without output text", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-incomplete-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const upstreamResponses = [
    {
      id: "resp_incomplete_with_text",
      object: "response",
      created_at: 901,
      status: "incomplete",
      model: "grok-4.5",
      output_text: "Partial search result",
      incomplete_details: { reason: "content_filter" },
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: 7,
        num_sources_used: 1,
      },
    },
    {
      id: "resp_incomplete_without_text",
      object: "response",
      created_at: 902,
      status: "incomplete",
      model: "grok-4.5",
      output: [{ id: "search_1", type: "web_search_call", status: "completed" }],
      incomplete_details: { reason: "max_output_tokens" },
      usage: {
        input_tokens: 8,
        output_tokens: 0,
        total_tokens: 8,
        num_sources_used: 2,
      },
    },
  ];
  let calls = 0;
  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    const response = upstreamResponses[calls];
    calls += 1;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const server = await startHandler(provider.handleChatCompletions(), "/v1/chat/completions");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const requestBody = {
    model: "grok-4.5",
    messages: [{ role: "user", content: "Search within a small output limit" }],
    search_parameters: { mode: "auto" },
    stream: false,
  };
  const withText = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    body: requestBody,
  });
  assert.equal(withText.status, 200);
  assert.equal(withText.body.choices[0].message.content, "Partial search result");
  assert.equal(withText.body.choices[0].finish_reason, "content_filter");
  assert.deepEqual(withText.body.usage, {
    prompt_tokens: 5,
    completion_tokens: 2,
    total_tokens: 7,
    num_sources_used: 1,
  });

  const withoutText = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    body: requestBody,
  });
  assert.equal(withoutText.status, 200);
  assert.equal(withoutText.body.choices[0].message.content, "");
  assert.equal(withoutText.body.choices[0].finish_reason, "length");
  assert.deepEqual(withoutText.body.usage, {
    prompt_tokens: 8,
    completion_tokens: 0,
    total_tokens: 8,
    num_sources_used: 2,
  });
  assert.equal(calls, 2);
});

test("GrokProvider preserves bridge upstream errors and rejects malformed success responses", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-upstream-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const upstreamError = {
    error: {
      message: "Agent Tools quota exceeded",
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    },
  };
  let calls = 0;
  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify(upstreamError), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    const response =
      calls === 2
        ? { id: "resp_missing_output", status: "completed" }
        : { id: "resp_failed", status: "failed", error: { message: "Search failed" } };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const server = await startHandler(provider.handleChatCompletions(), "/v1/chat/completions");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const requestBody = {
    model: "grok-4.5",
    messages: [{ role: "user", content: "Search safely" }],
    search_parameters: { mode: "auto" },
    stream: false,
  };
  const error = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    body: requestBody,
  });
  assert.equal(error.status, 429);
  assert.deepEqual(error.body, upstreamError);

  const malformed = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    body: requestBody,
  });
  assert.equal(malformed.status, 502);
  assert.equal(malformed.body.error.type, "api_error");
  assert.equal(malformed.body.error.code, "grok_upstream_invalid_response");

  const failed = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    body: requestBody,
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.type, "api_error");
  assert.equal(failed.body.error.code, "grok_upstream_invalid_response");
  assert.match(failed.body.error.message, /Search failed/);
  assert.equal(calls, 3);
});

test("createServer routes and tracks the legacy Grok search bridge", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-search-server-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const manager = new AccountManager(authDir);
  manager.load();
  const config = makeConfig(authDir, authFile);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(
      JSON.stringify({
        id: "resp_tracked_search",
        object: "response",
        created_at: 900,
        status: "completed",
        model: "grok-4.5",
        output_text: "tracked search result",
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  const server = await startApp(config, manager);

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const search = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-4.5",
      messages: [{ role: "user", content: "Search the web" }],
      search_parameters: { mode: "auto" },
      stream: false,
    },
  });
  assert.equal(search.status, 200);
  assert.equal(search.body.choices[0].message.content, "tracked search result");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses");

  const successRecent = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent?limit=1",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(successRecent.status, 200);
  assert.equal(successRecent.body.items[0].endpoint, "POST /v1/chat/completions");
  assert.equal(successRecent.body.items[0].provider, "grok");
  assert.equal(successRecent.body.items[0].model, "grok-4.5");
  assert.equal(successRecent.body.items[0].inputTokens, 3);
  assert.equal(successRecent.body.items[0].outputTokens, 4);
  assert.equal(successRecent.body.items[0].success, true);

  const streaming = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-4.5",
      messages: [{ role: "user", content: "Search the web" }],
      search_parameters: { mode: "auto" },
      stream: true,
    },
  });
  assert.equal(streaming.status, 400);
  assert.equal(calls.length, 1);

  const failureRecent = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent?limit=1",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(failureRecent.body.items[0].success, false);
  assert.equal(failureRecent.body.items[0].failureContext.stage, "validation");
  assert.equal(
    failureRecent.body.items[0].failureContext.kind,
    "legacy_live_search_streaming_unsupported"
  );
});

test("GrokProvider forwards Grok 4.6 responses requests with xhigh reasoning", async (t) => {
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
        model: "grok-4.6",
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

  const requestBody = {
    model: "grok-4.6",
    input: "Reply exactly: ok",
    reasoning: { effort: "xhigh" },
    tools: [{ type: "web_search" }, { type: "x_search", allowed_x_handles: ["xai"] }],
    stream: false,
  };
  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: requestBody,
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.output_text, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.deepEqual(calls[0].body, requestBody);
});

test("GrokProvider leaves native Responses stream validation to upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-responses-stream-validation-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; accept?: string; body: any }> = [];
  const upstreamError = {
    error: {
      message: "stream must be a boolean",
      type: "invalid_request_error",
      code: "invalid_parameter",
    },
  };
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(input),
      accept: headers?.Accept,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(upstreamError), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const server = await startHandler(provider.handleResponses(), "/v1/responses");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const requestBody = {
    model: "grok-4.6",
    input: "Let upstream validate this field",
    stream: "invalid",
  };
  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    body: requestBody,
  });

  assert.equal(resp.status, 422);
  assert.deepEqual(resp.body, upstreamError);
  assert.deepEqual(calls, [
    {
      url: "https://api.x.ai/v1/responses",
      accept: "application/json",
      body: requestBody,
    },
  ]);
});

test("GrokProvider reports image edit capability from enabled configured models", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-image-capability-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  t.after(() => fs.rmSync(authDir, { recursive: true, force: true }));

  const enabled = new GrokProvider(makeConfig(authDir, authFile));
  assert.equal(enabled.supportsImageEdits("grok-imagine-image-2.0"), true);
  assert.equal(enabled.supportsImageEdits("grok-imagine-image"), false);
  assert.equal((enabled as any).supportsImageEdits(42), false);

  const unconfiguredConfig = makeConfig(authDir, authFile);
  unconfiguredConfig.grok!.models = unconfiguredConfig.grok!.models.filter(
    (model) => model !== "grok-imagine-image-2.0"
  );
  const unconfigured = new GrokProvider(unconfiguredConfig);
  assert.equal(unconfigured.supportsImageEdits("grok-imagine-image-2.0"), false);

  const disabled = new GrokProvider(makeConfig(authDir, authFile, false));
  assert.equal(disabled.supportsImageEdits("grok-imagine-image-2.0"), false);
});

test("GrokProvider forwards Grok Image 2.0 generation fields without changing them", async (t) => {
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

  const requestBody = {
    model: "grok-imagine-image-2.0",
    prompt: "A tiny blue icon",
    n: 2,
    aspect_ratio: "16:9",
    resolution: "2k",
    quality: "medium",
    response_format: "b64_json",
    storage_options: { mode: "retained" },
    user: "ccpa-test-user",
  };
  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    headers: { Authorization: "Bearer test-key" },
    body: requestBody,
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.data[0].b64_json, "aW1hZ2U=");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/images/generations");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.deepEqual(calls[0].body, requestBody);
});

test("GrokProvider forwards Grok Image 2.0 single-image JSON edits without changing fields", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-image-edit-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const provider = new GrokProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; auth?: string; contentType?: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({
      url: String(input),
      auth: headers?.Authorization,
      contentType: headers?.["Content-Type"],
      body,
    });
    return new Response(
      JSON.stringify({
        created: 456,
        data: [{ b64_json: "ZWRpdGVk" }],
        usage: { num_input_images: 1, num_output_images: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  const server = await startHandler(provider.handleImageEdits(), "/v1/images/edits");

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const requestBody = {
    model: "grok-imagine-image-2.0",
    prompt: "Add a small red balloon",
    image: { type: "image_url", url: "https://example.com/input.png" },
    n: 1,
    aspect_ratio: "1:1",
    resolution: "1k",
    response_format: "b64_json",
    storage_options: { mode: "retained" },
    user: "ccpa-test-user",
  };
  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: requestBody,
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.data[0].b64_json, "ZWRpdGVk");
  assert.equal(resp.body.usage.num_input_images, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/images/edits");
  assert.equal(calls[0].auth, "Bearer grok-access-token");
  assert.equal(calls[0].contentType, "application/json");
  assert.deepEqual(calls[0].body, requestBody);
});

test("createServer routes Grok Image 2.0 generations and multi-image JSON edits", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-image-server-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const manager = new AccountManager(authDir);
  manager.load();
  const config = makeConfig(authDir, authFile);
  const calls: Array<{ url: string; body: any }> = [];
  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), body });
    return new Response(
      JSON.stringify({ created: 789, data: [{ url: "https://example.com/output.png" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
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
  assert.ok(models.body.data.some((model: any) => model.id === "grok-imagine-image-2.0"));

  const generationBody = {
    model: "grok-imagine-image-2.0",
    prompt: "A glass greenhouse at sunrise",
    quality: "low",
    resolution: "1k",
  };
  const generation = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    headers: { Authorization: "Bearer test-key" },
    body: generationBody,
  });
  assert.equal(generation.status, 200);

  const editBody = {
    model: "grok-imagine-image-2.0",
    prompt: "Combine these references into one scene",
    images: [
      { type: "image_url", url: "https://example.com/one.png" },
      { type: "file_id", file_id: "file_xai_123" },
    ],
    aspect_ratio: "3:2",
    resolution: "2k",
    response_format: "url",
  };
  const edit = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: editBody,
  });
  assert.equal(edit.status, 200);
  assert.deepEqual(edit.body, {
    created: 789,
    data: [{ url: "https://example.com/output.png" }],
  });

  assert.deepEqual(calls, [
    { url: "https://api.x.ai/v1/images/generations", body: generationBody },
    { url: "https://api.x.ai/v1/images/edits", body: editBody },
  ]);

  const recent = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent?limit=1",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(recent.status, 200);
  assert.equal(recent.body.items[0].endpoint, "POST /v1/images/edits");
  assert.equal(recent.body.items[0].provider, "grok");
  assert.equal(recent.body.items[0].model, "grok-imagine-image-2.0");
  assert.equal(recent.body.items[0].statusCode, 200);
  assert.equal(recent.body.items[0].success, true);

  const unsupported = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-imagine-image-unknown",
      prompt: "Do not forward this",
      image: { type: "image_url", url: "https://example.com/input.png" },
    },
  });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.type, "invalid_request_error");
  assert.equal(unsupported.body.error.code, "unsupported_model");
  assert.equal(calls.length, 2);
});

test("createServer rejects invalid Grok image edit routing and media types before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-image-validation-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const manager = new AccountManager(authDir);
  manager.load();
  const config = makeConfig(authDir, authFile);
  let upstreamCalls = 0;
  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const server = await startApp(config, manager);

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const missingModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: { prompt: "Do not forward this" },
  });
  assert.equal(missingModel.status, 400);
  assert.equal(missingModel.body.error.code, "missing_required_parameter");

  const configuredTextModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-4.6",
      prompt: "Do not forward this",
      image: { type: "image_url", url: "https://example.com/input.png" },
    },
  });
  assert.equal(configuredTextModel.status, 400);
  assert.equal(configuredTextModel.body.error.code, "unsupported_model");

  const legacyGenerationOnlyModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-imagine-image",
      prompt: "Do not forward this",
      image: { type: "image_url", url: "https://example.com/input.png" },
    },
  });
  assert.equal(legacyGenerationOnlyModel.status, 400);
  assert.equal(legacyGenerationOnlyModel.body.error.type, "invalid_request_error");
  assert.equal(legacyGenerationOnlyModel.body.error.code, "unsupported_model");

  const codexImageModel = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-image-2",
      prompt: "Do not forward this",
      image: { type: "image_url", url: "https://example.com/input.png" },
    },
  });
  assert.equal(codexImageModel.status, 400);
  assert.equal(codexImageModel.body.error.code, "unsupported_model");

  const codexRecent = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent?limit=1",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(codexRecent.status, 200);
  assert.equal(codexRecent.body.items[0].provider, "codex");
  assert.equal(codexRecent.body.items[0].model, "gpt-image-2");
  assert.equal(codexRecent.body.items[0].failureContext.kind, "unsupported_model");

  const boundary = "ccpa-image-edit-boundary";
  const multipartBody = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="model"',
    "",
    "grok-imagine-image-2.0",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const multipart = await requestRaw({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartBody,
  });
  assert.equal(multipart.status, 415);
  assert.equal(multipart.body.error.type, "invalid_request_error");
  assert.equal(multipart.body.error.code, "unsupported_media_type");
  assert.equal(upstreamCalls, 0);
});

test("createServer rejects Grok Image 2.0 edits while Grok is disabled before upstream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-image-disabled-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const manager = new AccountManager(authDir);
  manager.load();
  const config = makeConfig(authDir, authFile, false);
  let upstreamCalls = 0;
  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const server = await startApp(config, manager);

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const edit = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-imagine-image-2.0",
      prompt: "Do not forward this",
      image: { type: "image_url", url: "https://example.com/input.png" },
    },
  });
  assert.equal(edit.status, 400);
  assert.equal(edit.body.error.type, "invalid_request_error");
  assert.equal(edit.body.error.code, "unsupported_model");
  assert.equal(upstreamCalls, 0);
});

test("createServer preserves Grok Image 2.0 edit errors and usage failure context", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-grok-image-error-"));
  const authFile = path.join(authDir, ".grok", "auth.json");
  writeGrokAuth(authFile);
  const manager = new AccountManager(authDir);
  manager.load();
  const config = makeConfig(authDir, authFile);
  const restoreFetch = global.fetch;
  const upstreamError = {
    error: {
      message: "Image edit quota exceeded",
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    },
  };
  global.fetch = (async () =>
    new Response(JSON.stringify(upstreamError), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const server = await startApp(config, manager);

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const edit = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "grok-imagine-image-2.0",
      prompt: "Add a red balloon",
      image: { type: "image_url", url: "https://example.com/input.png" },
    },
  });
  assert.equal(edit.status, 429);
  assert.deepEqual(edit.body, upstreamError);

  const recent = await requestJson({
    server,
    method: "GET",
    path: "/admin/usage/recent?limit=1",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(recent.status, 200);
  assert.equal(recent.body.items[0].endpoint, "POST /v1/images/edits");
  assert.equal(recent.body.items[0].provider, "grok");
  assert.equal(recent.body.items[0].model, "grok-imagine-image-2.0");
  assert.equal(recent.body.items[0].statusCode, 429);
  assert.equal(recent.body.items[0].success, false);
  assert.equal(recent.body.items[0].failureContext.stage, "upstream");
  assert.equal(recent.body.items[0].failureContext.kind, "grok_upstream_http_error");
  assert.equal(recent.body.items[0].failureContext.upstreamStatus, 429);
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
        model: "grok-4.6",
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
  assert.ok(models.body.data.some((model: any) => model.id === "grok-4.6" && model.owned_by === "xai"));
  assert.ok(models.body.data.some((model: any) => model.id === "grok-4.5" && model.owned_by === "xai"));
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
      model: "grok-4.6",
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
