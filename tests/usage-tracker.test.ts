import test from "node:test";
import assert from "node:assert/strict";

import { UsageTracker, UsageRecord } from "../src/monitoring/usage";

function usageRecord(overrides: Partial<Omit<UsageRecord, "id" | "timestamp">> = {}): Omit<UsageRecord, "id" | "timestamp"> {
  return {
    provider: "claude",
    source: "node-client",
    clientIp: "127.0.0.1",
    userAgent: "node",
    endpoint: "POST /v1/chat/completions",
    model: "claude-sonnet-4-6",
    statusCode: 200,
    success: true,
    stream: false,
    latencyMs: 12,
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    failureContext: null,
    ...overrides,
  };
}

test("usage tracker groups trend buckets by local timezone", () => {
  const tracker = new UsageTracker(200, {
    now: () => new Date("2026-07-06T16:30:00.000Z"),
    timeZone: "Asia/Shanghai",
  });

  const record = tracker.record(usageRecord());
  const snapshot = tracker.snapshot();

  assert.equal(record.timestamp, "2026-07-06T16:30:00.000Z");
  assert.deepEqual(snapshot.requestsByDay, { "2026-07-07": 1 });
  assert.deepEqual(snapshot.requestsByHour, { "00": 1 });
});
