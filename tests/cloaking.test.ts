import assert from "node:assert/strict";
import test from "node:test";
import { CloakingConfig } from "../src/config";
import { applyCloaking } from "../src/proxy/cloaking";

const CLOAKING_CONFIG: CloakingConfig = {
  mode: "always",
  "strict-mode": false,
  "sensitive-words": [],
  "cache-user-id": true,
  "billing-build-hash": "000",
};

function extractBillingHeader(body: any): string {
  const entry = body?.system?.[0];
  assert.equal(entry?.type, "text");
  assert.equal(typeof entry.text, "string");
  return entry.text;
}

test("cloaking billing header keeps a stable build hash within the process", () => {
  const buildHashes = new Set<string>();
  const contentHashes = new Set<string>();

  for (let i = 0; i < 12; i += 1) {
    const body = applyCloaking(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: `hello ${i}` }],
      },
      CLOAKING_CONFIG,
      "openai-sdk-node",
      "sk-test"
    );
    const header = extractBillingHeader(body);
    const match = header.match(/cc_version=2\.1\.63\.([0-9a-f]{3}); cc_entrypoint=cli; cch=([0-9a-f]{5});/);
    assert.ok(match, `unexpected billing header: ${header}`);
    buildHashes.add(match[1]);
    contentHashes.add(match[2]);
  }

  assert.equal(buildHashes.size, 1);
  assert.ok(contentHashes.size > 1);
});

test("cloaking billing header uses configured build hash", () => {
  const body = applyCloaking(
    {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello configured hash" }],
    },
    {
      ...CLOAKING_CONFIG,
      "billing-build-hash": "abc",
    },
    "openai-sdk-node",
    "sk-test"
  );

  assert.match(extractBillingHeader(body), /cc_version=2\.1\.63\.abc;/);
});
