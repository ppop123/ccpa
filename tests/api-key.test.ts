import test from "node:test";
import assert from "node:assert/strict";

import { extractApiKey } from "../src/api-key";

test("extractApiKey accepts case-insensitive bearer auth with flexible whitespace", () => {
  assert.equal(extractApiKey({ authorization: "bearer test-key" }), "test-key");
  assert.equal(extractApiKey({ authorization: "BEARER   test-key  " }), "test-key");
});
