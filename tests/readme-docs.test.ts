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

function extractReadmeProviderModels(readme: string, provider: string, nextBlock: string, prefix: string): string[] {
  const blockPattern = new RegExp(`\\n${provider}:\\n[\\s\\S]*?\\n\\n${nextBlock}:`);
  const providerBlock = readme.match(blockPattern)?.[0] || "";
  const modelPattern = new RegExp(`-\\s+"(${prefix}[^"]+)"`, "g");
  return Array.from(providerBlock.matchAll(modelPattern), (match) => match[1]);
}

function matchRequired(text: string, pattern: RegExp, label: string): RegExpMatchArray {
  const match = text.match(pattern);
  assert.ok(match, `${label} not found`);
  return match;
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
  const englishModels = extractReadmeProviderModels(englishReadme, "grok", "agents", "grok-");
  const chineseModels = extractReadmeProviderModels(chineseReadme, "grok", "agents", "grok-");

  assert.ok(englishModels.length > 0);
  assert.ok(chineseModels.length > 0);
  assert.deepEqual(englishModels, chineseModels);
  assert.ok(englishModels.includes("grok-4.5"));
  assert.ok(englishModels.every((model) => configuredModels.has(model)));
});

test("README Codex model examples stay aligned with the example config", () => {
  const exampleConfig = yaml.load(readRepoFile("config.example.yaml")) as any;
  const englishReadme = readRepoFile("README.md");
  const chineseReadme = readRepoFile("README_CN.md");
  const configuredModels = new Set(exampleConfig.codex.models);
  const englishModels = extractReadmeProviderModels(englishReadme, "codex", "grok", "gpt-");
  const chineseModels = extractReadmeProviderModels(chineseReadme, "codex", "grok", "gpt-");

  assert.ok(englishModels.length > 0);
  assert.ok(chineseModels.length > 0);
  assert.deepEqual(englishModels, chineseModels);
  for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.ok(englishModels.includes(model));
  }
  assert.ok(englishModels.every((model) => configuredModels.has(model)));
});

test("Codex smoke defaults stay aligned with the example config", () => {
  const exampleConfig = yaml.load(readRepoFile("config.example.yaml")) as any;
  const configuredModels = new Set(exampleConfig.codex.models);
  const englishReadme = readRepoFile("README.md");
  const chineseReadme = readRepoFile("README_CN.md");
  const operationsGuide = readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md");
  const callHelper = readRepoFile("scripts/call_ccpa.sh");
  const upstreamMatrix = readRepoFile("scripts/ccpa-upstream-matrix.mjs");

  const defaults = [
    matchRequired(callHelper, /MODEL="\$\{1:-(gpt-[^"}]+)\}"/, "call_ccpa.sh model default")[1],
    matchRequired(upstreamMatrix, /const DEFAULT_CODEX_MODEL = "(gpt-[^"]+)";/, "upstream matrix Codex default")[1],
    matchRequired(englishReadme, /"model": "(gpt-[^"]+)"/, "English README curl model")[1],
    matchRequired(chineseReadme, /"model": "(gpt-[^"]+)"/, "Chinese README curl model")[1],
    matchRequired(operationsGuide, /models:\n\s+- "(gpt-[^"]+)"/, "operations guide Codex model")[1],
  ];

  assert.deepEqual(defaults, Array(defaults.length).fill(defaults[0]));
  assert.ok(defaults.every((model) => configuredModels.has(model)));
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
