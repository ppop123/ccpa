import test from "node:test";
import assert from "node:assert/strict";

import { decodeAgentFiles } from "../src/agents/bundle";

const limits = {
  maxFiles: 3,
  maxFileBytes: 8,
  maxTotalBytes: 12,
};

test("decodeAgentFiles accepts safe utf8 and base64 relative files", () => {
  const files = decodeAgentFiles(
    [
      { path: "src/index.ts", content: "hello", encoding: "utf8" },
      { path: "README.md", content: Buffer.from("world").toString("base64"), encoding: "base64" },
    ],
    limits
  );

  assert.deepEqual(
    files.map((file) => ({ path: file.path, text: file.content.toString("utf8") })),
    [
      { path: "src/index.ts", text: "hello" },
      { path: "README.md", text: "world" },
    ]
  );
});
test("decodeAgentFiles rejects traversal and absolute paths", () => {
  assert.throws(
    () => decodeAgentFiles([{ path: "../secret.txt", content: "x", encoding: "utf8" }], limits),
    /unsafe file path/i
  );
  assert.throws(
    () => decodeAgentFiles([{ path: "/tmp/secret.txt", content: "x", encoding: "utf8" }], limits),
    /unsafe file path/i
  );
});

test("decodeAgentFiles enforces file count and byte limits", () => {
  assert.throws(
    () =>
      decodeAgentFiles(
        [
          { path: "a.txt", content: "a", encoding: "utf8" },
          { path: "b.txt", content: "b", encoding: "utf8" },
          { path: "c.txt", content: "c", encoding: "utf8" },
          { path: "d.txt", content: "d", encoding: "utf8" },
        ],
        limits
      ),
    /too many files/i
  );
  assert.throws(
    () => decodeAgentFiles([{ path: "big.txt", content: "123456789", encoding: "utf8" }], limits),
    /file too large/i
  );
  assert.throws(
    () =>
      decodeAgentFiles(
        [
          { path: "a.txt", content: "1234567", encoding: "utf8" },
          { path: "b.txt", content: "1234567", encoding: "utf8" },
        ],
        limits
      ),
    /bundle too large/i
  );
});
