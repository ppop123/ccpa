import test from "node:test";
import assert from "node:assert/strict";

import { refreshTokensWithRetry } from "../src/auth/oauth";

test("refreshTokensWithRetry does not retry permanent OAuth 4xx failures", async () => {
  const restoreFetch = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => refreshTokensWithRetry("stale-refresh-token", 3),
      /Token refresh failed \(400\)/
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = restoreFetch;
  }
});
