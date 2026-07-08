# Agent Runs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build CCPA Agent Runs P1 so clients can upload files through the API, run Claude/Codex/Grok CLI agents in temporary workspaces, and retrieve output, diff, and artifacts.

**Architecture:** Add a new `src/agents/` subsystem instead of extending the provider interface. The server wires `/v1/agent-runs` endpoints behind the existing API-key middleware and delegates validation, workspace setup, process execution, status, cancel, and artifact download to an `AgentRunManager`.

**Tech Stack:** TypeScript, Express, Node `fs/path/os/child_process`, existing test runner `tsx --test`, no new runtime dependency for P1.

### Task 1: Config

**Files:**
- Modify: `src/config.ts`
- Test: `tests/agent-config.test.ts`

**Steps:**
1. Add `AgentRunnerConfig`, `AgentsConfig`, and defaults.
2. Normalize `agents.enabled`, `runs-dir`, concurrency, runtime, wait, count, and byte limits.
3. Add tests for disabled default and parsed enabled config.

### Task 2: Bundle Validation

**Files:**
- Create: `src/agents/bundle.ts`
- Test: `tests/agent-bundle.test.ts`

**Steps:**
1. Write failing tests for safe relative paths, path traversal rejection, base64 decoding, per-file limit, total limit.
2. Implement parser returning decoded file specs.
3. Verify focused tests pass.

### Task 3: Run Manager

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/manager.ts`
- Test: `tests/agent-run-manager.test.ts`

**Steps:**
1. Test successful fake runner run with changed file and diff.
2. Test timeout/cancel path.
3. Implement workspace creation, baseline git init/commit, runner invocation, diff, artifacts archive, and in-memory run store.

### Task 4: CLI Runners

**Files:**
- Create: `src/agents/runners.ts`
- Test: `tests/agent-runners.test.ts`

**Steps:**
1. Test command template generation for Claude, Codex, and Grok.
2. Test unsupported agent/mode errors.
3. Implement fixed templates with no caller-provided arbitrary flags.

### Task 5: HTTP Routes

**Files:**
- Create: `src/agents/routes.ts`
- Modify: `src/server.ts`
- Test: `tests/agent-routes.test.ts`

**Steps:**
1. Test disabled config returns 404 or 503 without running.
2. Test API-key protected POST creates a fake-runner result.
3. Test GET status and artifacts.
4. Wire routes under `/v1/agent-runs`.

### Task 6: Docs and Verification

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `docs/CCPA_OPERATIONS_GUIDE.md`
- Modify: `config.example.yaml`
- Modify: `package.json`

**Steps:**
1. Document config and API examples.
2. Add agent tests to `npm run test:unit`.
3. Run focused tests, typecheck, and unit suite.
4. Run a local fake-runner/manual smoke command.

## Implementation Notes

P1 is implemented as a separate `src/agents/` subsystem and wired under
`/v1/agent-runs`. It uses JSON uploads, temporary per-run workspaces, fixed CLI
templates, baseline git commits, unified diffs, bounded metadata, cancel,
timeout, retention cleanup, and downloadable artifacts.

The live runner templates were verified against local CLIs on 2026-07-08:

- Claude Code uses `--safe-mode`, `--no-session-persistence`, and explicit
  `--allowedTools` lists. P1 does not expose Claude Bash because no OS sandbox
  boundary has been verified for that runner; use only with trusted clients.
- Codex CLI uses `codex exec --cd <workspace> --sandbox <mode> --ephemeral --`.
- Grok CLI uses `--permission-mode bypassPermissions`, `--always-approve`,
  explicit `--tools` allowlists, and Grok's built-in `read-only` or `workspace`
  sandbox profiles.

Completed live smoke runs:

- `claude-code`: `run_mrbxgkn2_04571e186ace`
- `codex-cli`: `run_mrbxgrwc_359fee0003dd`
- `grok-cli`: `run_mrbxhhog_7af4e6c30cc3`
