import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentCommand } from "../src/agents/runners";
import { defaultAgentsConfig } from "../src/config";

test("buildAgentCommand creates fixed command templates for each CLI agent", () => {
  const config = defaultAgentsConfig();

  const claude = buildAgentCommand(config, {
    agent: "claude-code",
    mode: "workspace-write",
    prompt: "fix it",
    workspace: "/tmp/work",
  });
  assert.equal(claude.command, "claude");
  assert.equal(claude.cwd, "/tmp/work");
  assert.deepEqual(claude.args.slice(0, 4), ["-p", "fix it", "--output-format", "json"]);
  assert.equal(claude.args.includes("--safe-mode"), true);
  assert.deepEqual(
    claude.args.slice(claude.args.indexOf("--allowedTools"), claude.args.indexOf("--allowedTools") + 2),
    ["--allowedTools", "Read,Write,Edit,Bash"]
  );

  const codex = buildAgentCommand(config, {
    agent: "codex-cli",
    mode: "read-only",
    prompt: "inspect",
    workspace: "/tmp/work",
  });
  assert.equal(codex.command, "codex");
  assert.deepEqual(codex.args, ["exec", "--cd", "/tmp/work", "--sandbox", "read-only", "--ephemeral", "inspect"]);

  const grok = buildAgentCommand(config, {
    agent: "grok-cli",
    mode: "workspace-write",
    prompt: "edit",
    workspace: "/tmp/work",
  });
  assert.equal(grok.command, "grok");
  assert.deepEqual(grok.args.slice(0, 5), ["-p", "edit", "--cwd", "/tmp/work", "--output-format"]);
  assert.equal(grok.args.includes("--no-memory"), true);
  assert.equal(grok.args.includes("--no-subagents"), true);
  assert.equal(grok.args.includes("--disable-web-search"), true);
  assert.equal(grok.args.includes("--always-approve"), true);
  assert.deepEqual(
    grok.args.slice(grok.args.indexOf("--permission-mode"), grok.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "bypassPermissions"]
  );
  assert.deepEqual(
    grok.args.slice(grok.args.indexOf("--tools"), grok.args.indexOf("--tools") + 2),
    ["--tools", "read_file,search_replace,grep_search,list_dir,bash"]
  );
  assert.deepEqual(
    grok.args.slice(grok.args.indexOf("--sandbox"), grok.args.indexOf("--sandbox") + 2),
    ["--sandbox", "workspace"]
  );

  const grokReadOnly = buildAgentCommand(config, {
    agent: "grok-cli",
    mode: "read-only",
    prompt: "inspect",
    workspace: "/tmp/work",
  });
  assert.deepEqual(
    grokReadOnly.args.slice(
      grokReadOnly.args.indexOf("--permission-mode"),
      grokReadOnly.args.indexOf("--permission-mode") + 2
    ),
    ["--permission-mode", "bypassPermissions"]
  );
  assert.deepEqual(
    grokReadOnly.args.slice(grokReadOnly.args.indexOf("--tools"), grokReadOnly.args.indexOf("--tools") + 2),
    ["--tools", "read_file,grep_search,list_dir"]
  );
  assert.deepEqual(
    grokReadOnly.args.slice(grokReadOnly.args.indexOf("--sandbox"), grokReadOnly.args.indexOf("--sandbox") + 2),
    ["--sandbox", "read-only"]
  );
});

test("buildAgentCommand rejects disabled runners and unsupported modes", () => {
  const config = defaultAgentsConfig();
  config.runners["grok-cli"].enabled = false;

  assert.throws(
    () =>
      buildAgentCommand(config, {
        agent: "grok-cli",
        mode: "read-only",
        prompt: "inspect",
        workspace: "/tmp/work",
      }),
    /disabled/i
  );

  assert.throws(
    () =>
      buildAgentCommand(config, {
        agent: "claude-code",
        mode: "danger-full-access" as never,
        prompt: "inspect",
        workspace: "/tmp/work",
      }),
    /unsupported mode/i
  );
});
