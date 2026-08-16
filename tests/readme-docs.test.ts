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

function extractMarkdownSection(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
    } else if (!inFence && line === marker) {
      start = index;
      break;
    }
  }
  assert.notEqual(start, -1, `${marker} not found`);

  inFence = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
    } else if (!inFence && /^##\s+/.test(line)) {
      return lines.slice(start + 1, index).join("\n");
    }
  }
  return lines.slice(start + 1).join("\n");
}

function extractParagraphContaining(markdown: string, needle: string, label: string): string {
  const matches = markdown
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.includes(needle));
  assert.equal(matches.length, 1, `${label} should appear in exactly one paragraph`);
  return matches[0];
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

test("repository entrypoints link to the agent usage guide", () => {
  const agents = readRepoFile("AGENTS.md");
  const englishReadme = readRepoFile("README.md");
  const chineseReadme = readRepoFile("README_CN.md");
  const docsReadme = readRepoFile("docs/README.md");
  const agentGuide = readRepoFile("docs/AGENT_GUIDE.md");

  assert.match(agents, /docs\/AGENT_GUIDE\.md/);
  assert.match(englishReadme, /\[Agent guide\]\(docs\/AGENT_GUIDE\.md\)/);
  assert.match(chineseReadme, /\[Agent 使用指南\]\(docs\/AGENT_GUIDE\.md\)/);
  assert.match(docsReadme, /\[Agent Guide\]\(AGENT_GUIDE\.md\)/);
  assert.match(agentGuide, /GET \/v1\/models/);
  assert.match(agentGuide, /POST \/v1\/agent-runs/);
});

test("stable harness docs contain project-specific guidance", () => {
  for (const fileName of ["ARCHITECTURE.md", "docs/QUALITY.md"]) {
    const body = readRepoFile(fileName);
    assert.doesNotMatch(body, /Document the app shell|Capture the high-value|Record what/);
  }
});

test("operations guide documents the actual empty-host binding", () => {
  const operationsGuide = readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md");

  assert.match(operationsGuide, /`host: ""` resolves to `127\.0\.0\.1`/);
  assert.doesNotMatch(operationsGuide, /`host: ""` listens on all interfaces/);
});

test("agent docs state Agent Runs discovery and retention limits precisely", () => {
  const agentGuide = readRepoFile("docs/AGENT_GUIDE.md");
  const architecture = readRepoFile("ARCHITECTURE.md");

  assert.doesNotMatch(agentGuide, /runner readiness/i);
  assert.match(agentGuide, /does not probe\s+whether a runner command exists/i);
  assert.match(agentGuide, /only the selected limits\s+exposed by `GET \/admin\/accounts`/i);
  assert.match(agentGuide, /internal `\.\.` segments may normalize away/i);
  assert.match(architecture, /does not scan run directories left by an earlier\s+process/i);
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
  assert.ok(englishModels.includes("grok-4.6"));
  assert.ok(englishModels.includes("grok-4.5"));
  assert.ok(englishModels.includes("grok-imagine-image-2.0"));
  assert.ok(englishModels.every((model) => configuredModels.has(model)));
});

test("image docs cover Grok Image 2.0 generation and JSON-only editing", () => {
  const docs = [
    readRepoFile("README.md"),
    readRepoFile("README_CN.md"),
    readRepoFile("docs/AGENT_GUIDE.md"),
    readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md"),
  ];

  for (const body of docs) {
    assert.match(body, /grok-imagine-image-2\.0/);
    assert.match(body, /POST \/v1\/images\/generations/);
    assert.match(body, /POST \/v1\/images\/edits/);
    assert.match(body, /application\/json/);
    assert.match(body, /multipart\/form-data/);
    assert.match(body, /415 unsupported_media_type/);
  }
});

test("Grok search docs prefer Responses Agent Tools and state legacy bridge limits", () => {
  const docs = [
    readRepoFile("README.md"),
    readRepoFile("README_CN.md"),
    readRepoFile("docs/AGENT_GUIDE.md"),
    readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md"),
  ];

  for (const body of docs) {
    assert.match(body, /POST \/v1\/responses/);
    assert.match(body, /"type":\s*"web_search"/);
    assert.match(body, /"type":\s*"x_search"/);
    assert.match(body, /search_parameters/);
    assert.match(body, /max_search_results/);
    assert.match(body, /return_citations/);
    assert.match(body, /no_inline_citations/);
    assert.match(body, /stream:\s*true/);
    assert.match(body, /HTTP 400|400/);
  }

  const agentGuide = docs[2];
  assert.match(agentGuide, /return_citations/);
  assert.match(agentGuide, /news/);
  assert.match(agentGuide, /rss/);
  assert.match(agentGuide, /safe_search/);
  assert.match(agentGuide, /legacy_live_search_streaming_unsupported/);
  assert.match(agentGuide, /unsupported_legacy_search_parameter/);
});

test("Grok OAuth docs explain login verification and reload boundaries", () => {
  const englishReadme = readRepoFile("README.md");
  const chineseReadme = readRepoFile("README_CN.md");
  const detailedDocs = [
    readRepoFile("docs/AGENT_GUIDE.md"),
    readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md"),
  ];

  for (const body of [englishReadme, chineseReadme, ...detailedDocs]) {
    assert.match(body, /grok login --oauth/);
    assert.match(body, /grok models/);
    assert.match(body, /\/admin\/accounts/);
    assert.match(body, /grok\.available/);
    assert.match(body, /\/v1\/models/);
    assert.match(body, /server\.provider_status/);
    assert.match(body, /--require-provider-status degraded/);
  }

  assert.match(englishReadme, /re-reads the OAuth file.*without a restart/is);
  assert.match(chineseReadme, /重新读取 OAuth 文件.*无需重启/is);

  for (const body of detailedDocs) {
    assert.match(body, /grok\.enabled/);
    assert.match(body, /grok\.models/);
    assert.match(body, /restart/i);
  }
});

test("quick setup covers Grok-only configuration", () => {
  const englishQuickSetup = extractMarkdownSection(readRepoFile("README.md"), "5-minute setup");
  const chineseQuickSetup = extractMarkdownSection(readRepoFile("README_CN.md"), "5 分钟跑起来");
  const operationsConfiguration = extractMarkdownSection(
    readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md"),
    "Configuration"
  );

  assert.match(englishQuickSetup, /Enable[^\n]*providers[\s\S]{0,100}`codex\.models` \/ `grok\.models`/i);
  assert.match(chineseQuickSetup, /启用需要的 provider[\s\S]{0,100}`codex\.models` \/ `grok\.models`/);
  assert.match(operationsConfiguration, /grok:\s+enabled:\s+false/is);
  assert.match(operationsConfiguration, /grok-4\.6/);

  const decoy = extractMarkdownSection(
    ["## Target details", "grok-4.6", "", "## Target", "expected", "", "## Old Reference", "grok-4.6"].join("\n"),
    "Target"
  );
  assert.match(decoy, /expected/);
  assert.doesNotMatch(decoy, /grok-4\.6/);
});

test("Grok docs distinguish auth readiness from configured model exposure", () => {
  const englishSections = [
    extractMarkdownSection(readRepoFile("README.md"), "Login"),
    extractMarkdownSection(readRepoFile("docs/AGENT_GUIDE.md"), "First-Time Setup"),
    extractMarkdownSection(readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md"), "Provider Setup"),
  ];
  const chineseSection = extractMarkdownSection(readRepoFile("README_CN.md"), "登录");

  for (const section of englishSections) {
    const paragraph = extractParagraphContaining(
      section,
      "reports `grok.available: true`",
      "English Grok readiness paragraph"
    );
    assert.match(paragraph, /grok\.auth-file/);
    assert.match(paragraph, /same\s+file/is);
    assert.match(paragraph, /`(?:GET )?\/v1\/models`/);
    assert.match(paragraph, /configured model exposure only/);
    assert.match(paragraph, /auth\s+check/);
    assert.match(section, /--require-provider-status degraded/);
    assert.doesNotMatch(paragraph, /npm run canary -- --require-provider-status ok/);
    assert.match(section, /can still pass[\s\S]{0,100}Grok\s+is\s+down/);
  }

  const chineseParagraph = extractParagraphContaining(
    chineseSection,
    "`/admin/accounts` 返回 `grok.available: true`",
    "Chinese Grok readiness paragraph"
  );
  assert.match(chineseParagraph, /grok\.auth-file/);
  assert.match(chineseParagraph, /同一文件/is);
  assert.match(chineseParagraph, /`\/v1\/models` 只表示配置后暴露的/);
  assert.match(chineseParagraph, /不能把它当作认证检查/);
  assert.match(chineseSection, /--require-provider-status degraded/);
  assert.doesNotMatch(chineseParagraph, /npm run canary -- --require-provider-status ok/);
  assert.match(chineseSection, /Grok\s+异常[\s\S]{0,80}仍可能通过/);
});

test("Grok docs turn the deprecated Live Search 410 into migration guidance", () => {
  const docs = [
    readRepoFile("README.md"),
    readRepoFile("README_CN.md"),
    readRepoFile("docs/AGENT_GUIDE.md"),
    readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md"),
  ];

  for (const body of docs) {
    assert.match(body, /Live search is deprecated, switch to Agent Tools API/);
    assert.match(body, /POST \/v1\/responses/);
    assert.match(body, /search_parameters/);
    assert.match(body, /\/health\.build\.git_commit/);
    assert.match(body, /git rev-parse HEAD/);
    assert.match(body, /build metadata|构建元数据|built deployment|构建部署/i);
  }
});

test("Grok legacy bridge docs name both validation error codes", () => {
  const sections = [
    extractMarkdownSection(readRepoFile("README.md"), "Call it from scripts"),
    extractMarkdownSection(readRepoFile("README_CN.md"), "给脚本调用"),
    extractMarkdownSection(readRepoFile("docs/AGENT_GUIDE.md"), "OpenAI-Compatible Calls"),
    extractMarkdownSection(readRepoFile("docs/CCPA_OPERATIONS_GUIDE.md"), "Grok Search And Images"),
  ];

  for (const section of sections) {
    assert.match(section, /invalid_parameter/);
    assert.match(section, /unsupported_legacy_search_parameter/);
    assert.match(section, /message arrays or roles|message 数组或 role/);
    assert.match(section, /extra message fields|name` 等额外字段/);
  }
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
