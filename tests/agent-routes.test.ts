import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { AccountManager } from "../src/accounts/manager";
import { Config, defaultAgentsConfig } from "../src/config";
import { createServer } from "../src/server";

function makeConfig(authDir: string, fakeRunner: string, agentsEnabled: boolean): Config {
  const agents = defaultAgentsConfig();
  agents.enabled = agentsEnabled;
  agents["runs-dir"] = path.join(authDir, "agent-runs");
  agents["sync-wait-ms"] = 10_000;
  agents.runners["claude-code"].command = fakeRunner;

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
      models: [],
    },
    debug: "off",
    agents,
  };
}

function writeFakeRunner(dir: string): string {
  const runnerPath = path.join(dir, "fake-runner.js");
  fs.writeFileSync(
    runnerPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "fs.writeFileSync('answer.txt', 'agent output file\\n');",
      "console.log('agent ok');",
    ].join("\n")
  );
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

async function startApp(config: Config, manager: AccountManager): Promise<http.Server> {
  const app = createServer(config, manager);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function stopApp(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
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
}): Promise<{ status: number; body: any; rawBody: string; headers: http.IncomingHttpHeaders }> {
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
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let body: any = null;
          if (rawBody && String(res.headers["content-type"] || "").includes("application/json")) {
            body = JSON.parse(rawBody);
          }
          resolve({ status: res.statusCode || 0, body, rawBody, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("Agent Runs endpoint is disabled unless agents.enabled is true", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-route-disabled-"));
  const fakeRunner = writeFakeRunner(tmpDir);
  const config = makeConfig(tmpDir, fakeRunner, false);
  const manager = new AccountManager(tmpDir);
  const server = await startApp(config, manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/agent-runs",
    headers: { Authorization: "Bearer test-key" },
    body: { agent: "claude-code", prompt: "hello", files: [] },
  });

  assert.equal(resp.status, 503);
  assert.match(resp.rawBody, /Agent Runs is disabled/);
});

test("Agent Runs endpoint accepts uploaded files and returns a completed run", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-route-enabled-"));
  const fakeRunner = writeFakeRunner(tmpDir);
  const config = makeConfig(tmpDir, fakeRunner, true);
  const manager = new AccountManager(tmpDir);
  const server = await startApp(config, manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const createResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/agent-runs",
    headers: { Authorization: "Bearer test-key" },
    body: {
      agent: "claude-code",
      prompt: "write answer",
      mode: "workspace-write",
      wait: true,
      files: [{ path: "input.txt", content: "hello\n", encoding: "utf8" }],
    },
  });

  assert.equal(createResp.status, 200);
  assert.equal(createResp.body.status, "completed");
  assert.match(createResp.body.output_text, /agent ok/);
  assert.deepEqual(createResp.body.changed_files, ["answer.txt"]);
  assert.match(createResp.body.artifacts_url, /^\/v1\/agent-runs\/run_[^/]+\/artifacts$/);

  const statusResp = await requestJson({
    server,
    method: "GET",
    path: `/v1/agent-runs/${createResp.body.id}`,
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(statusResp.status, 200);
  assert.equal(statusResp.body.id, createResp.body.id);

  const artifactResp = await requestJson({
    server,
    method: "GET",
    path: createResp.body.artifacts_url,
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(artifactResp.status, 200);
  assert.match(String(artifactResp.headers["content-type"] || ""), /gzip|octet-stream/);
  assert.ok(artifactResp.rawBody.length > 0);
});

test("admin accounts response exposes Agent Runs readiness without file contents", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-agent-route-admin-"));
  const fakeRunner = writeFakeRunner(tmpDir);
  const config = makeConfig(tmpDir, fakeRunner, true);
  const manager = new AccountManager(tmpDir);
  const server = await startApp(config, manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.agents.enabled, true);
  assert.equal(resp.body.agents["runs-dir"], config.agents?.["runs-dir"]);
  assert.equal(resp.body.agents.runners["claude-code"].enabled, true);
  assert.equal(resp.rawBody.includes("write answer"), false);
});
