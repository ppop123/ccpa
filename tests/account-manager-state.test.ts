import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountManager } from "../src/accounts/manager";
import { loadAllTokens, saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";

function makeToken(overrides: Partial<TokenData> = {}): TokenData {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    email: "test@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function loadManager(authDir: string): AccountManager {
  const manager = new AccountManager(authDir);
  manager.load();
  return manager;
}

test("persists cooldown and counters across manager reloads", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-state-"));

  try {
    const token = makeToken();
    saveToken(authDir, token);

    const first = loadManager(authDir);
    first.recordAttempt(token.email);
    first.recordFailure(token.email, "rate_limit", "upstream 429");

    const beforeReload = first.getSnapshots()[0];
    assert.equal(beforeReload.totalRequests, 1);
    assert.equal(beforeReload.totalFailures, 1);
    assert.equal(beforeReload.failureCount, 1);
    assert.match(beforeReload.lastError ?? "", /rate_limit: upstream 429/);
    assert.ok(beforeReload.cooldownUntil > Date.now());

    const stateRaw = fs.readFileSync(path.join(authDir, "state.json"), "utf-8");
    assert.doesNotMatch(stateRaw, /access-token|refresh-token/);

    const second = loadManager(authDir);
    const afterReload = second.getSnapshots()[0];

    assert.equal(afterReload.totalRequests, 1);
    assert.equal(afterReload.totalFailures, 1);
    assert.equal(afterReload.failureCount, 1);
    assert.equal(afterReload.lastError, beforeReload.lastError);
    assert.equal(afterReload.lastFailureAt, beforeReload.lastFailureAt);
    assert.equal(afterReload.cooldownUntil, beforeReload.cooldownUntil);
    assert.deepEqual(second.getAvailability(), {
      state: "cooldown",
      email: token.email,
      cooldownUntil: beforeReload.cooldownUntil,
      lastError: beforeReload.lastError,
    });
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("exposes persisted refresh backoff in account snapshots", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-refresh-state-"));

  try {
    const token = makeToken();
    const nextRefreshAttemptAt = Date.now() + 120_000;
    saveToken(authDir, token);
    fs.writeFileSync(
      path.join(authDir, "state.json"),
      JSON.stringify({
        version: 1,
        accounts: {
          [token.email]: {
            refreshFailureCount: 2,
            nextRefreshAttemptAt,
          },
        },
      })
    );

    const manager = loadManager(authDir);
    const snapshot = manager.getSnapshots()[0];

    assert.equal(snapshot.refreshFailureCount, 2);
    assert.equal(snapshot.nextRefreshAttemptAt, nextRefreshAttemptAt);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("treats expired access tokens as unavailable until refresh succeeds", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-expired-"));

  try {
    const token = makeToken({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    saveToken(authDir, token);

    const manager = loadManager(authDir);
    const availability = manager.getAvailability();
    const snapshot = manager.getSnapshots()[0];

    assert.equal(manager.getNextAccount(), null);
    assert.equal((availability as any).state, "expired");
    assert.equal((availability as any).email, token.email);
    assert.equal((availability as any).expiresAt, token.expiresAt);
    assert.equal(snapshot.available, false);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("loads multiple token files and selects the first usable account", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-multi-"));

  try {
    const expired = makeToken({
      email: "aaa-expired@example.com",
      accessToken: "expired-access",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const usable = makeToken({
      email: "bbb-usable@example.com",
      accessToken: "usable-access",
    });
    const nextRefreshAttemptAt = Date.now() + 300_000;
    saveToken(authDir, expired);
    saveToken(authDir, usable);
    fs.writeFileSync(
      path.join(authDir, "state.json"),
      JSON.stringify({
        version: 1,
        accounts: {
          [usable.email]: {
            totalRequests: 7,
            totalSuccesses: 6,
            refreshFailureCount: 1,
            nextRefreshAttemptAt,
          },
        },
      })
    );

    const manager = loadManager(authDir);
    const snapshots = manager.getSnapshots();

    assert.equal(manager.accountCount, 2);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].email, expired.email);
    assert.equal(snapshots[0].available, false);
    assert.equal(snapshots[1].email, usable.email);
    assert.equal(snapshots[1].available, true);
    assert.equal(snapshots[1].totalRequests, 7);
    assert.equal(snapshots[1].totalSuccesses, 6);
    assert.equal(snapshots[1].refreshFailureCount, 1);
    assert.equal(snapshots[1].nextRefreshAttemptAt, nextRefreshAttemptAt);
    assert.equal(manager.getNextAccount()?.email, usable.email);
    assert.deepEqual(manager.getAvailability(), {
      state: "available",
      email: usable.email,
    });
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("reports the soonest account cooldown when no account is usable", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-cooldown-order-"));

  try {
    const slow = makeToken({
      email: "aaa-slow@example.com",
      accessToken: "slow-access",
    });
    const fast = makeToken({
      email: "bbb-fast@example.com",
      accessToken: "fast-access",
    });
    const slowCooldown = Date.now() + 120_000;
    const fastCooldown = Date.now() + 30_000;
    saveToken(authDir, slow);
    saveToken(authDir, fast);
    fs.writeFileSync(
      path.join(authDir, "state.json"),
      JSON.stringify({
        version: 1,
        accounts: {
          [slow.email]: {
            cooldownUntil: slowCooldown,
            lastError: "rate_limit: slow",
          },
          [fast.email]: {
            cooldownUntil: fastCooldown,
            lastError: "rate_limit: fast",
          },
        },
      })
    );

    const manager = loadManager(authDir);

    assert.equal(manager.getNextAccount(), null);
    assert.deepEqual(manager.getAvailability(), {
      state: "cooldown",
      email: fast.email,
      cooldownUntil: fastCooldown,
      lastError: "rate_limit: fast",
    });
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("reports the soonest refresh backoff when all accounts are expired", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-refresh-backoff-order-"));

  try {
    const slow = makeToken({
      email: "aaa-slow@example.com",
      accessToken: "slow-access",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fast = makeToken({
      email: "bbb-fast@example.com",
      accessToken: "fast-access",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const slowNextRefresh = Date.now() + 120_000;
    const fastNextRefresh = Date.now() + 30_000;
    saveToken(authDir, slow);
    saveToken(authDir, fast);
    fs.writeFileSync(
      path.join(authDir, "state.json"),
      JSON.stringify({
        version: 1,
        accounts: {
          [slow.email]: {
            refreshFailureCount: 2,
            nextRefreshAttemptAt: slowNextRefresh,
          },
          [fast.email]: {
            refreshFailureCount: 1,
            nextRefreshAttemptAt: fastNextRefresh,
          },
        },
      })
    );

    const manager = loadManager(authDir);

    assert.equal(manager.getNextAccount(), null);
    assert.deepEqual(manager.getAvailability(), {
      state: "expired",
      email: fast.email,
      expiresAt: fast.expiresAt,
      refreshFailureCount: 1,
      nextRefreshAttemptAt: fastNextRefresh,
    });
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("redacts account identifiers and API keys in runtime logs", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-log-redaction-"));
  const token = makeToken({
    email: "private.user@example.com",
    refreshToken: "refresh-token-for-redaction",
  });
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalFetch = globalThis.fetch;

  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  globalThis.fetch = async () =>
    new Response('{"error":"invalid_grant","hint":"private.user@example.com sk-secret1234567890"}', {
      status: 400,
    });

  saveToken(authDir, token);
  const manager = loadManager(authDir);

  manager.recordFailure(token.email, "rate_limit", "upstream 429");
  const refreshed = await manager.refreshAccount(token.email);

  assert.equal(refreshed, false);
  assert.equal(manager.getSnapshots()[0].email, token.email);
  const output = [...logs, ...errors].join("\n");
  assert.doesNotMatch(output, /private\.user@example\.com/);
  assert.doesNotMatch(output, /sk-secret1234567890/);
  assert.match(output, /\[email:redacted\]/);
  assert.match(output, /\[api-key:redacted\]/);
});

test("redacts account identifiers in token file load errors", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-token-log-redaction-"));
  const errors: string[] = [];
  const originalError = console.error;

  t.after(() => {
    console.error = originalError;
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  fs.writeFileSync(path.join(authDir, "claude-private.user@example.com.json"), "{not-json");

  const tokens = loadAllTokens(authDir);

  assert.deepEqual(tokens, []);
  const output = errors.join("\n");
  assert.doesNotMatch(output, /private\.user@example\.com/);
  assert.match(output, /\[email:redacted\]/);
});

test("adding another account keeps runtime state free of token secrets", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-account-add-multi-"));

  try {
    const manager = new AccountManager(authDir);
    manager.addAccount(makeToken({ email: "first.private@example.com", accessToken: "first-access" }));
    manager.addAccount(makeToken({ email: "second.private@example.com", accessToken: "second-access" }));

    assert.equal(manager.accountCount, 2);
    assert.deepEqual(
      manager.getSnapshots().map((account) => account.email),
      ["first.private@example.com", "second.private@example.com"]
    );

    const stateRaw = fs.readFileSync(path.join(authDir, "state.json"), "utf-8");
    assert.doesNotMatch(stateRaw, /first-access|second-access|refresh-token/);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
