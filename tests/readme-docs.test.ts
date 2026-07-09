import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

function readRepoFile(fileName: string): string {
  return fs.readFileSync(path.join(process.cwd(), fileName), "utf8");
}

function collectTrackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
}

function isTextFile(fileName: string): boolean {
  const buffer = fs.readFileSync(path.join(process.cwd(), fileName));
  return !buffer.includes(0);
}

function extractReadmeGrokModels(readme: string): string[] {
  const grokBlock = readme.match(/\ngrok:\n[\s\S]*?\n\nagents:/)?.[0] || "";
  return Array.from(grokBlock.matchAll(/-\s+"(grok-[^"]+)"/g), (match) => match[1]);
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

test("README files point to the documentation map", () => {
  const englishReadme = readRepoFile("README.md");
  const chineseReadme = readRepoFile("README_CN.md");
  const docsReadme = readRepoFile("docs/README.md");

  assert.match(englishReadme, /\[Documentation map\]\(docs\/README\.md\)/);
  assert.match(chineseReadme, /\[文档地图\]\(docs\/README\.md\)/);
  assert.match(docsReadme, /\[Operations Guide\]\(CCPA_OPERATIONS_GUIDE\.md\)/);
  assert.match(docsReadme, /\[Plan archive\]\(plans\/README\.md\)/);
});

test("README Grok model examples stay aligned with the example config", () => {
  const exampleConfig = yaml.load(readRepoFile("config.example.yaml")) as any;
  const englishReadme = readRepoFile("README.md");
  const chineseReadme = readRepoFile("README_CN.md");
  const configuredModels = new Set(exampleConfig.grok.models);
  const englishModels = extractReadmeGrokModels(englishReadme);
  const chineseModels = extractReadmeGrokModels(chineseReadme);

  assert.deepEqual(englishModels, chineseModels);
  assert.ok(englishModels.includes("grok-4.5"));
  assert.ok(englishModels.every((model) => configuredModels.has(model)));
});

test("tracked text files do not expose the legacy project name", () => {
  const legacyProjectName = ["auth2", "api"].join("");
  const legacyVariants = [
    legacyProjectName,
    ["Auth2", "API"].join(""),
    legacyProjectName.toUpperCase(),
  ];

  const offenders = collectTrackedFiles().flatMap((fileName) => {
    if (!isTextFile(fileName)) return [];
    const body = readRepoFile(fileName);
    return legacyVariants.some((variant) => body.includes(variant))
      ? [fileName]
      : [];
  });

  assert.deepEqual(offenders, []);
});
