import test from "node:test";
import assert from "node:assert/strict";

import { resolveProviderFromModel } from "../src/providers/router";

test("claude-sonnet-4-6 routes to claude", () => {
  assert.equal(resolveProviderFromModel("claude-sonnet-4-6"), "claude");
});

test("gpt-5.4 routes to codex", () => {
  assert.equal(resolveProviderFromModel("gpt-5.4"), "codex");
});

test("gpt-5.6 family routes to codex", () => {
  for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.equal(resolveProviderFromModel(model), "codex");
  }
});

test("gpt-5.4-mini routes to codex", () => {
  assert.equal(resolveProviderFromModel("gpt-5.4-mini"), "codex");
});

test("gpt-5.2 routes to codex", () => {
  assert.equal(resolveProviderFromModel("gpt-5.2"), "codex");
});

test("o4-mini routes to codex", () => {
  assert.equal(resolveProviderFromModel("o4-mini"), "codex");
});

test("grok-4.3 routes to grok", () => {
  assert.equal(resolveProviderFromModel("grok-4.3"), "grok");
});

test("grok-4.5 routes to grok", () => {
  assert.equal(resolveProviderFromModel("grok-4.5"), "grok");
});

test("invalid model input returns null instead of throwing", () => {
  assert.equal(resolveProviderFromModel(undefined as unknown as string), null);
  assert.equal(resolveProviderFromModel(null as unknown as string), null);
  assert.equal(resolveProviderFromModel({ trim: "nope" } as unknown as string), null);
});

test("unknown model returns null", () => {
  assert.equal(resolveProviderFromModel("not-a-real-model"), null);
});
