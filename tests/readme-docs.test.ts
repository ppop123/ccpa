import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readRepoFile(fileName: string): string {
  return fs.readFileSync(path.join(process.cwd(), fileName), "utf8");
}

test("Chinese README documents strict external healthcheck log-path contract", () => {
  const englishReadme = readRepoFile("README.md");
  const chineseReadme = readRepoFile("README_CN.md");

  assert.match(englishReadme, /--require-external-healthcheck-dir/);
  assert.match(englishReadme, /CCPA_LOG_PATHS/);
  assert.match(englishReadme, /\$HOME\/ccpa\/logs\/launchd\.\{stdout,stderr\}\.log/);

  assert.match(chineseReadme, /--require-external-healthcheck-dir/);
  assert.match(chineseReadme, /CCPA_HEALTHCHECK_MAINTAIN_LOGS/);
  assert.match(chineseReadme, /CCPA_LOG_PATHS/);
  assert.match(chineseReadme, /\/tmp\/ccpa\.\*/);
  assert.match(chineseReadme, /\$HOME\/ccpa\/logs\/launchd\.\{stdout,stderr\}\.log/);
});
