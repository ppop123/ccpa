import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GrokAuthStore } from "../src/providers/grok-auth";

const ENTRY_KEY = "https://auth.x.ai::client-id";

function writeAuthFile(filePath: string, opts: { key?: string; refreshToken?: string | null; expiresInMs?: number } = {}): void {
  const entry: Record<string, unknown> = {
    key: opts.key ?? "old-access-token",
    auth_mode: "oidc",
    expires_at: new Date(Date.now() + (opts.expiresInMs ?? 60 * 60 * 1000)).toISOString(),
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "client-id",
    email: "person@example.com",
  };
  if (opts.refreshToken !== null) {
    entry.refresh_token = opts.refreshToken ?? "refresh-token-1";
  }
  fs.writeFileSync(filePath, JSON.stringify({ [ENTRY_KEY]: entry }, null, 2));
}

function tempAuthPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-refresh-test-"));
  return path.join(dir, "auth.json");
}

function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    count += 1;
    return responder(String(input), init);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls: () => count,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: "new-access-token",
      refresh_token: "refresh-token-2",
      expires_in: 21600,
      token_type: "Bearer",
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("needsRefresh: fresh token → false;临近过期/已过期 → true;无 refresh_token → false", () => {
  const authPath = tempAuthPath();

  writeAuthFile(authPath, { expiresInMs: 2 * 60 * 60 * 1000 });
  let store = new GrokAuthStore(authPath);
  assert.equal(store.needsRefresh(store.load()), false);

  writeAuthFile(authPath, { expiresInMs: 5 * 60 * 1000 });
  store = new GrokAuthStore(authPath);
  assert.equal(store.needsRefresh(store.load()), true);

  writeAuthFile(authPath, { expiresInMs: -1000 });
  store = new GrokAuthStore(authPath);
  assert.equal(store.needsRefresh(store.load()), true);

  writeAuthFile(authPath, { refreshToken: null, expiresInMs: -1000 });
  store = new GrokAuthStore(authPath);
  assert.equal(store.needsRefresh(store.load()), false);
});

test("refresh 成功:回写轮换后的 access/refresh token 与新 expires_at,原子无残留", async () => {
  const authPath = tempAuthPath();
  writeAuthFile(authPath, { expiresInMs: -1000 });
  const store = new GrokAuthStore(authPath);
  const previous = store.load();

  const fetchStub = stubFetch((url, init) => {
    assert.equal(url, "https://auth.x.ai/oauth2/token");
    const body = String(init?.body);
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=refresh-token-1/);
    assert.match(body, /client_id=client-id/);
    return tokenResponse();
  });
  try {
    const refreshed = await store.refresh(previous);
    assert.ok(refreshed, "refresh 应返回新快照");
    assert.equal(refreshed.accessToken, "new-access-token");
    assert.equal(refreshed.refreshToken, "refresh-token-2");
    assert.equal(refreshed.expired, false);

    const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    assert.equal(raw[ENTRY_KEY].key, "new-access-token");
    assert.equal(raw[ENTRY_KEY].refresh_token, "refresh-token-2");
    assert.equal(raw[ENTRY_KEY].email, "person@example.com", "无关字段应保留");
    assert.ok(Date.parse(raw[ENTRY_KEY].expires_at) > Date.now() + 5 * 60 * 60 * 1000);

    const leftovers = fs.readdirSync(path.dirname(authPath)).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, [], "不应留 tmp 文件");
  } finally {
    fetchStub.restore();
  }
});

test("单飞:并发 refresh 只打一次 token 端点", async () => {
  const authPath = tempAuthPath();
  writeAuthFile(authPath, { expiresInMs: -1000 });
  const store = new GrokAuthStore(authPath);
  const previous = store.load();

  const fetchStub = stubFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return tokenResponse();
  });
  try {
    const [a, b] = await Promise.all([store.refresh(previous), store.refresh(previous)]);
    assert.equal(fetchStub.calls(), 1);
    assert.equal(a?.accessToken, "new-access-token");
    assert.equal(b?.accessToken, "new-access-token");
  } finally {
    fetchStub.restore();
  }
});

test("先重读:文件已被外部(grok CLI)续过时直接采用,不打端点", async () => {
  const authPath = tempAuthPath();
  writeAuthFile(authPath, { expiresInMs: -1000 });
  const store = new GrokAuthStore(authPath);
  const previous = store.load();

  writeAuthFile(authPath, { key: "cli-refreshed-token", refreshToken: "refresh-token-9", expiresInMs: 2 * 60 * 60 * 1000 });

  const fetchStub = stubFetch(() => {
    throw new Error("不应发起网络请求");
  });
  try {
    const refreshed = await store.refresh(previous);
    assert.equal(refreshed?.accessToken, "cli-refreshed-token");
    assert.equal(fetchStub.calls(), 0);
  } finally {
    fetchStub.restore();
  }
});

test("refresh 失败(端点 4xx):返回 null,文件不动", async () => {
  const authPath = tempAuthPath();
  writeAuthFile(authPath, { expiresInMs: -1000 });
  const store = new GrokAuthStore(authPath);
  const previous = store.load();
  const before = fs.readFileSync(authPath, "utf-8");

  const fetchStub = stubFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
  try {
    const refreshed = await store.refresh(previous);
    assert.equal(refreshed, null);
    assert.equal(fs.readFileSync(authPath, "utf-8"), before);
  } finally {
    fetchStub.restore();
  }
});
