import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { execFile } from "node:child_process";

const CONTRACT_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-contract-check.mjs");

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
}

interface ContractServerOptions {
  brokenUnauthenticatedModels?: boolean;
  leakApiKeyInBrokenResponse?: boolean;
}

async function startContractServer(options: ContractServerOptions = {}): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.url === "/health") {
      sendJson(200, {
        status: "ok",
        service: "auth2api",
        version: "1.1.0",
        started_at: "2026-06-18T00:00:00.000Z",
        uptime_ms: 1234,
      });
      return;
    }

    if (req.url === "/v1/models" && req.method === "GET" && !auth) {
      if (options.brokenUnauthenticatedModels) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(options.leakApiKeyInBrokenResponse ? "unexpected success for test-key" : "unexpected success");
        return;
      }
      sendJson(401, {
        error: {
          message: "Missing API key",
          type: "authentication_error",
          code: "missing_api_key",
        },
      });
      return;
    }

    if (auth !== "Bearer test-key") {
      sendJson(403, {
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      });
      return;
    }

    if (req.url === "/admin/accounts" && req.method === "GET") {
      sendJson(200, {
        server: {
          service: "auth2api",
          version: "1.1.0",
          started_at: "2026-06-18T00:00:00.000Z",
          uptime_ms: 1234,
          provider_status: "degraded",
          providers: { total: 2, available: 1, unavailable: ["codex"] },
        },
        claude: { name: "claude", available: true },
        codex: { name: "codex", available: false },
      });
      return;
    }

    if (req.url === "/admin/usage" && req.method === "GET") {
      sendJson(200, {
        totals: { requests: 0, success: 0, failure: 0, tokens: { input: 0, output: 0, total: 0 } },
      });
      return;
    }

    if (req.url === "/admin/usage/recent?limit=1" && req.method === "GET") {
      sendJson(200, { generatedAt: "2026-06-18T00:00:00.000Z", items: [] });
      return;
    }

    if (req.url === "/admin/not-real" && req.method === "GET") {
      sendJson(404, {
        error: {
          message: "Endpoint not implemented: GET /admin/not-real",
          type: "invalid_request_error",
          code: "endpoint_not_implemented",
        },
      });
      return;
    }

    if (req.url === "/v1/models" && req.method === "GET") {
      sendJson(200, {
        object: "list",
        data: [{ id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" }],
      });
      return;
    }

    if (req.url === "/v1/embeddings" && req.method === "POST") {
      sendJson(404, {
        error: {
          message: "Endpoint not implemented: POST /v1/embeddings",
          type: "invalid_request_error",
          code: "endpoint_not_implemented",
        },
      });
      return;
    }

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          JSON.parse(body || "{}");
        } catch {
          sendJson(400, {
            error: {
              message: "Invalid JSON body",
              type: "invalid_request_error",
              code: "invalid_json",
            },
          });
          return;
        }
        sendJson(400, {
          error: {
            message: "Unsupported model: not-a-real-model",
            type: "invalid_request_error",
            code: "unsupported_model",
          },
        });
      });
      return;
    }

    if (req.url === "/v1/responses" && req.method === "POST") {
      sendJson(400, {
        error: {
          message: "model is required",
          type: "invalid_request_error",
          code: "missing_required_parameter",
        },
      });
      return;
    }

    if (req.url === "/v1/images/generations" && req.method === "POST") {
      sendJson(400, {
        error: {
          message: "prompt is required",
          type: "invalid_request_error",
          code: "missing_required_parameter",
        },
      });
      return;
    }

    if (req.url === "/v1/messages" && req.method === "POST") {
      sendJson(400, {
        error: {
          message: "max_tokens is required",
          type: "invalid_request_error",
          code: "missing_required_parameter",
        },
      });
      return;
    }

    if (req.url === "/v1/messages/count_tokens" && req.method === "POST") {
      sendJson(400, {
        error: {
          message: "stream is unsupported for count_tokens",
          type: "invalid_request_error",
          code: "invalid_parameter",
        },
      });
      return;
    }

    sendJson(404, { error: { message: "not found" } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function writeConfig(tmpDir: string): string {
  const configPath = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(configPath, ["host: 127.0.0.1", "port: 8317", "api-keys:", "  - test-key", ""].join("\n"));
  return configPath;
}

function runContractCheck(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CONTRACT_SCRIPT, ...args], { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({
        code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
        stdout,
        stderr,
      });
    });
  });
}

test("contract check help documents no-upstream OpenAI compatibility checks", async () => {
  const result = await runContractCheck(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /no-upstream OpenAI-compatible contract checks/);
  assert.match(result.stdout, /GET \/v1\/models without auth/);
  assert.match(result.stdout, /invalid_json/);
  assert.match(result.stdout, /unsupported_model/);
});

test("contract check verifies low-cost protocol contracts without leaking API keys", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-contract-"));
  const server = await startContractServer();
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runContractCheck(["--url", baseUrl, "--config", configPath]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /health runtime identity: ok/);
  assert.match(result.stdout, /GET \/v1\/models without auth: missing_api_key/);
  assert.match(result.stdout, /GET \/admin\/usage with bad auth: invalid_api_key/);
  assert.match(result.stdout, /GET \/admin\/accounts: degraded/);
  assert.match(result.stdout, /GET \/admin\/usage\/recent: ok/);
  assert.match(result.stdout, /GET \/v1\/models: 1 model/);
  assert.match(result.stdout, /POST \/v1\/embeddings: endpoint_not_implemented/);
  assert.match(result.stdout, /POST \/v1\/chat\/completions malformed JSON: invalid_json/);
  assert.match(result.stdout, /POST \/v1\/chat\/completions unsupported model: unsupported_model/);
  assert.match(result.stdout, /POST \/v1\/responses missing model: missing_required_parameter/);
  assert.match(result.stdout, /POST \/v1\/images\/generations missing prompt: missing_required_parameter/);
  assert.match(result.stdout, /POST \/v1\/messages missing max_tokens: missing_required_parameter/);
  assert.match(result.stdout, /POST \/v1\/messages\/count_tokens streaming: invalid_parameter/);
  assert.match(result.stdout, /GET \/admin\/not-real: endpoint_not_implemented/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("contract check fails loudly and redacts API keys when a contract breaks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-contract-broken-"));
  const server = await startContractServer({ brokenUnauthenticatedModels: true, leakApiKeyInBrokenResponse: true });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runContractCheck(["--url", baseUrl, "--config", configPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GET \/v1\/models without auth expected HTTP 401 JSON missing_api_key/);
  assert.match(result.stderr, /\[REDACTED_API_KEY\]/);
  assert.doesNotMatch(result.stderr, /test-key/);
  assert.doesNotMatch(result.stdout, /test-key/);
});
