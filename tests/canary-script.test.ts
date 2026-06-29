import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { execFile } from "node:child_process";

const CANARY_SCRIPT = path.join(process.cwd(), "scripts", "ccpa-canary.mjs");

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
}

type ProviderStatus = "ok" | "degraded" | "unavailable";

interface CanaryServerOptions {
  legacyHealth?: boolean;
  startedAt?: string;
  build?: unknown;
  providerStatus?: ProviderStatus;
  providers?: { total: number; available: number; unavailable: string[] };
  claude?: unknown;
  codex?: unknown;
}

async function startCanaryServer(options: CanaryServerOptions = {}): Promise<http.Server> {
  const providerStatus = options.providerStatus || "degraded";
  const providers = options.providers || { total: 2, available: 1, unavailable: ["codex"] };
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.url === "/health") {
      sendJson(
        200,
        options.legacyHealth
          ? { status: "ok" }
          : {
              status: "ok",
              service: "ccpa",
              version: "1.1.0",
              started_at: options.startedAt || "2026-06-18T00:00:00.000Z",
              uptime_ms: 1234,
              ...(options.build !== undefined ? { build: options.build } : {}),
            }
      );
      return;
    }

    if (auth !== "Bearer test-key") {
      sendJson(401, { error: { message: "Missing API key", type: "authentication_error" } });
      return;
    }

    if (req.url === "/admin/accounts") {
      sendJson(200, {
        server: {
          service: "ccpa",
          version: "1.1.0",
          started_at: "2026-06-18T00:00:00.000Z",
          uptime_ms: 1234,
          provider_status: providerStatus,
          providers,
        },
        claude: options.claude ?? { name: "claude", available: true },
        codex: options.codex ?? { name: "codex", available: false },
      });
      return;
    }

    if (req.url === "/v1/models") {
      sendJson(200, {
        object: "list",
        data: [{ id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" }],
      });
      return;
    }

    if (req.url === "/v1/embeddings") {
      sendJson(404, {
        error: {
          message: "Endpoint not implemented: POST /v1/embeddings",
          type: "invalid_request_error",
          code: "endpoint_not_implemented",
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
  fs.writeFileSync(
    configPath,
    [
      "host: 127.0.0.1",
      "port: 8317",
      "api-keys:",
      "  - test-key",
      "",
    ].join("\n")
  );
  return configPath;
}

function writeDistMarker(tmpDir: string, mtime: Date): string {
  const distPath = path.join(tmpDir, "dist", "index.js");
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.writeFileSync(distPath, "// dist marker\n");
  fs.utimesSync(distPath, mtime, mtime);
  return distPath;
}

function runCanary(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CANARY_SCRIPT, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
        stdout,
        stderr,
      });
    });
  });
}

test("ccpa canary checks low-cost operational endpoints without leaking API keys", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-"));
  const server = await startCanaryServer();
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);
  const distPath = writeDistMarker(tmpDir, new Date("2026-06-17T23:59:00.000Z"));

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary(["--url", baseUrl, "--config", configPath, "--dist", distPath]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /health: ok/);
  assert.match(result.stdout, /dist: fresh/);
  assert.match(result.stdout, /admin\/accounts: degraded/);
  assert.match(result.stdout, /v1\/models: 1 model/);
  assert.match(result.stdout, /v1\/embeddings: endpoint_not_implemented/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("ccpa canary fails when live health is from an old build", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-old-health-"));
  const server = await startCanaryServer({ legacyHealth: true });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary(["--url", baseUrl, "--config", configPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /health missing runtime identity/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("ccpa canary fails when the live process started before the local dist build", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-stale-dist-"));
  const server = await startCanaryServer({ startedAt: "2026-06-18T00:00:00.000Z" });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);
  const distPath = writeDistMarker(tmpDir, new Date("2026-06-18T00:01:00.000Z"));

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary(["--url", baseUrl, "--config", configPath, "--dist", distPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /live process started before local dist build/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("ccpa canary fails by default when no provider is available", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-no-provider-"));
  const server = await startCanaryServer({
    providerStatus: "unavailable",
    providers: { total: 2, available: 0, unavailable: ["claude", "codex"] },
  });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);
  const distPath = writeDistMarker(tmpDir, new Date("2026-06-17T23:59:00.000Z"));

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary(["--url", baseUrl, "--config", configPath, "--dist", distPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /provider readiness unavailable does not satisfy required degraded/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("ccpa canary can require all providers to be available", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-provider-ok-"));
  const server = await startCanaryServer();
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);
  const distPath = writeDistMarker(tmpDir, new Date("2026-06-17T23:59:00.000Z"));

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary([
    "--url",
    baseUrl,
    "--config",
    configPath,
    "--dist",
    distPath,
    "--require-provider-status",
    "ok",
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /provider readiness degraded does not satisfy required ok/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("ccpa canary prints Claude recovery hint without leaking account identity", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-claude-hint-"));
  const server = await startCanaryServer({
    providerStatus: "degraded",
    providers: { total: 2, available: 1, unavailable: ["claude"] },
    claude: {
      name: "claude",
      available: false,
      details: {
        accounts: [
          {
            email: "private.user@example.com",
            available: false,
            expiresAt: "2000-01-01T00:00:00.000Z",
            refreshFailureCount: 6,
            nextRefreshAttemptAt: Date.UTC(2026, 5, 20, 14, 0, 0),
          },
        ],
      },
    },
    codex: { name: "codex", available: true },
  });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);
  const distPath = writeDistMarker(tmpDir, new Date("2026-06-17T23:59:00.000Z"));

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary(["--url", baseUrl, "--config", configPath, "--dist", distPath]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /admin\/accounts: degraded \(1\/2 providers available; unavailable: claude\)/);
  assert.match(result.stdout, /provider_hint: claude unavailable/);
  assert.match(result.stdout, /reason=token_expired/);
  assert.match(result.stdout, /refresh_failures=6/);
  assert.match(result.stdout, /node dist\/index\.js --config=.*config\.yaml --login --manual/);
  assert.doesNotMatch(result.stdout, /private\.user@example\.com/);
  assert.doesNotMatch(result.stderr, /private\.user@example\.com/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("ccpa canary passes strict provider readiness when all providers are available", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-provider-strict-ok-"));
  const server = await startCanaryServer({
    providerStatus: "ok",
    providers: { total: 2, available: 2, unavailable: [] },
  });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);
  const distPath = writeDistMarker(tmpDir, new Date("2026-06-17T23:59:00.000Z"));

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary([
    "--url",
    baseUrl,
    "--config",
    configPath,
    "--dist",
    distPath,
    "--require-provider-status",
    "ok",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /admin\/accounts: ok \(2\/2 providers available\)/);
  assert.doesNotMatch(result.stdout, /test-key/);
  assert.doesNotMatch(result.stderr, /test-key/);
});

test("ccpa canary can require a specific runtime build commit", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-canary-build-"));
  const server = await startCanaryServer({
    build: {
      git_commit: "abc1234",
      git_branch: "codex/runtime-build",
      git_dirty: false,
      built_at: "2026-06-22T00:00:00.000Z",
    },
  });
  const baseUrl = `http://127.0.0.1:${serverAddress(server).port}`;
  const configPath = writeConfig(tmpDir);
  const distPath = writeDistMarker(tmpDir, new Date("2026-06-17T23:59:00.000Z"));

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await runCanary([
    "--url",
    baseUrl,
    "--config",
    configPath,
    "--dist",
    distPath,
    "--require-build-commit",
    "abc1234",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /build: git_commit=abc1234 git_branch=codex\/runtime-build git_dirty=false/);

  const mismatch = await runCanary([
    "--url",
    baseUrl,
    "--config",
    configPath,
    "--dist",
    distPath,
    "--require-build-commit",
    "def5678",
  ]);

  assert.notEqual(mismatch.code, 0);
  assert.match(mismatch.stderr, /runtime build commit abc1234 does not match required def5678/);
});
