import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { AddressInfo } from "node:net";

const UPSTREAM_MATRIX_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-upstream-matrix.mjs");

function runMatrix(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [UPSTREAM_MATRIX_SCRIPT, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code:
          typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? Number((error as NodeJS.ErrnoException).code)
            : 0,
        stdout,
        stderr,
      });
    });
  });
}

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening on a TCP port");
  return address;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function writeConfig(tmpDir: string, apiKey = "test-key"): string {
  const configPath = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(configPath, ["host: 127.0.0.1", "port: 8317", "api-keys:", `  - ${apiKey}`, ""].join("\n"));
  return configPath;
}

async function startMatrixServer(
  options: { failPath?: string; apiKey?: string; chatText?: string; responseText?: string } = {}
): Promise<{ server: http.Server; requests: any[] }> {
  const requests: any[] = [];
  const apiKey = options.apiKey || "test-key";
  const server = http.createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.url === options.failPath) {
        sendJson(500, {
          error: {
            message: "upstream failed for private.user@example.com with sk-secret1234567890",
            type: "server_error",
            code: "upstream_failed",
          },
        });
        return;
      }

      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        sendJson(401, { error: { message: "bad key", type: "authentication_error", code: "invalid_api_key" } });
        return;
      }

      if (req.url === "/v1/chat/completions") {
        sendJson(200, {
          id: "chatcmpl_matrix",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: options.chatText || "ok" }, finish_reason: "stop" }],
        });
        return;
      }

      if (req.url === "/v1/responses") {
        sendJson(200, {
          id: "resp_matrix",
          object: "response",
          status: "completed",
          output_text: options.responseText || "ok",
        });
        return;
      }

      if (req.url === "/v1/images/generations") {
        sendJson(200, {
          created: 1711756800,
          data: [{ b64_json: Buffer.from("tiny-image").toString("base64") }],
        });
        return;
      }

      sendJson(404, { error: { message: "not found", type: "invalid_request_error", code: "not_found" } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests };
}

test("upstream matrix help documents dry-run default and quota-spending apply mode", async () => {
  const result = await runMatrix(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /upstream matrix/i);
  assert.match(result.stdout, /dry-run/i);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--include-image/);
  assert.match(result.stdout, /--codex-model/);
  assert.match(result.stdout, /--claude-model/);
  assert.match(result.stdout, /--image-model/);
  assert.match(result.stdout, /spends upstream quota/i);
});

test("upstream matrix defaults to dry-run and does not require config or network", async () => {
  const result = await runMatrix([]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /mode: dry-run/);
  assert.match(result.stdout, /quota_spending: no/);
  assert.match(result.stdout, /planned checks:/);
  assert.match(result.stdout, /codex chat completions/);
  assert.match(result.stdout, /claude responses string input/);
  assert.doesNotMatch(result.stdout, /images generations/);
});

test("upstream matrix dry-run accepts explicit model overrides", async () => {
  const result = await runMatrix([
    "--include-image",
    "--codex-model",
    "gpt-custom",
    "--claude-model",
    "claude-custom",
    "--image-model",
    "gpt-image-custom",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /mode: dry-run/);
  assert.match(result.stdout, /quota_spending: no/);
  assert.match(result.stdout, /codex chat completions: POST \/v1\/chat\/completions model=gpt-custom/);
  assert.match(result.stdout, /codex responses string input: POST \/v1\/responses model=gpt-custom/);
  assert.match(result.stdout, /claude chat completions: POST \/v1\/chat\/completions model=claude-custom/);
  assert.match(result.stdout, /claude responses string input: POST \/v1\/responses model=claude-custom/);
  assert.match(result.stdout, /codex images generations: POST \/v1\/images\/generations model=gpt-image-custom/);
});

test("upstream matrix apply runs text generation checks through local CCPA", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-upstream-matrix-apply-"));
  const { server, requests } = await startMatrixServer();
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runMatrix([
    "--apply",
    "--url",
    baseUrl,
    "--config",
    configPath,
    "--codex-model",
    "gpt-custom",
    "--claude-model",
    "claude-custom",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /mode: apply/);
  assert.match(result.stdout, /quota_spending: yes/);
  assert.match(result.stdout, /codex chat completions: ok/);
  assert.match(result.stdout, /codex responses string input: ok/);
  assert.match(result.stdout, /claude chat completions: ok/);
  assert.match(result.stdout, /claude responses string input: ok/);
  assert.match(result.stdout, /upstream_matrix: yes/);
  assert.equal(requests.length, 4);
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url} ${request.body.model}`),
    [
      "POST /v1/chat/completions gpt-custom",
      "POST /v1/responses gpt-custom",
      "POST /v1/chat/completions claude-custom",
      "POST /v1/responses claude-custom",
    ]
  );
  assert.ok(requests.every((request) => request.auth === "Bearer test-key"));
});

test("upstream matrix apply rejects text checks that do not return expected ok", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-upstream-matrix-text-"));
  const { server } = await startMatrixServer({ responseText: "not ok" });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runMatrix(["--apply", "--url", baseUrl, "--config", configPath]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /codex chat completions: ok/);
  assert.match(result.stdout, /codex responses string input: failed/);
  assert.match(result.stdout, /expected text "ok"/);
  assert.match(result.stdout, /upstream_matrix: no/);
});

test("upstream matrix includes image generation only when explicitly requested", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-upstream-matrix-image-"));
  const { server, requests } = await startMatrixServer();
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runMatrix(["--apply", "--include-image", "--url", baseUrl, "--config", configPath]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /codex images generations: ok/);
  assert.equal(requests.length, 5);
  assert.equal(requests[4].url, "/v1/images/generations");
  assert.equal(requests[4].body.model, "gpt-image-2");
});

test("upstream matrix failures are redacted", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-upstream-matrix-fail-"));
  const { server } = await startMatrixServer({ failPath: "/v1/responses", apiKey: "sk-secret1234567890" });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir, "sk-secret1234567890");

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runMatrix(["--apply", "--url", baseUrl, "--config", configPath, "--api-key", "sk-secret1234567890"]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /codex chat completions: ok/);
  assert.match(result.stdout, /codex responses string input: failed/);
  assert.match(result.stdout, /\[email:redacted\]/);
  assert.match(result.stdout, /\[api-key:redacted\]/);
  assert.match(result.stdout, /upstream_matrix: no/);
  assert.doesNotMatch(result.stdout, /private\.user@example\.com/);
  assert.doesNotMatch(result.stdout, /sk-secret1234567890/);
});
