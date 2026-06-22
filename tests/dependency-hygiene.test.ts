import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("runtime dependencies avoid uuid package for generated ids", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.dependencies?.uuid, undefined);
  assert.equal(packageJson.devDependencies?.["@types/uuid"], undefined);
});
