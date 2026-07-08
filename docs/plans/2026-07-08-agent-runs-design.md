# CCPA Agent Runs Design

## Goal

Add a private Agent Runs subsystem to CCPA so trusted local/LAN clients can submit a prompt plus a file bundle over HTTP, run Claude Code, Codex CLI, or Grok CLI in an isolated temporary workspace, and retrieve the final answer, logs, changed-file list, unified diff, and artifacts.

This is intentionally separate from the existing OpenAI-compatible model proxy. The current provider layer forwards stateless model requests. Agent Runs executes local CLI agents that can inspect files and use tools, so it needs a different security model, lifecycle, and observability surface.

## Non-Goals

- No arbitrary remote shell.
- No caller-provided host paths.
- No arbitrary CLI flag passthrough.
- No multi-tenant public service.
- No direct modification of NAS or Mac project directories.
- No production-grade distributed queue in P1.

## Architecture

```text
Client / NAS service
  -> POST /v1/agent-runs
     - agent, prompt, mode, timeout, files[]
  -> CCPA Agent Runs API
     - authenticate with existing API key
     - validate bundle and limits
     - create ~/.ccpa/agent-runs/<run_id>/workspace
     - write uploaded files
     - create baseline git commit
     - run fixed CLI command template
     - collect output, logs, diff, artifacts
  <- JSON result or 202 run id
```

The caller owns applying any patch. CCPA only operates on an ephemeral copy of the uploaded files.

## P1 API

### `POST /v1/agent-runs`

P1 accepts JSON to avoid introducing multipart dependencies:

```json
{
  "agent": "claude-code",
  "prompt": "Read these files and fix the failing test.",
  "mode": "workspace-write",
  "wait": true,
  "timeout_ms": 600000,
  "files": [
    {
      "path": "package.json",
      "content": "{\"scripts\":{\"test\":\"node test.js\"}}",
      "encoding": "utf8"
    },
    {
      "path": "src/index.ts",
      "content": "ZXhwb3J0IGNvbnN0IHggPSAxOwo=",
      "encoding": "base64"
    }
  ]
}
```

Response for completed synchronous runs:

```json
{
  "id": "run_...",
  "status": "completed",
  "agent": "claude-code",
  "mode": "workspace-write",
  "exit_code": 0,
  "duration_ms": 12034,
  "output_text": "...",
  "error_text": "",
  "changed_files": ["src/index.ts"],
  "diff": "diff --git ...",
  "artifacts_url": "/v1/agent-runs/run_.../artifacts"
}
```

If `wait` is false, or if a run is still executing when the synchronous wait budget expires, CCPA returns `202` with the run id.

### `GET /v1/agent-runs/:id`

Returns run metadata and, after completion, the result summary and diff.

### `GET /v1/agent-runs/:id/artifacts`

Downloads an archive containing the final workspace, result metadata, stdout, stderr, and diff.

### `POST /v1/agent-runs/:id/cancel`

Kills the running process and marks the run as canceled.

## P1 Configuration

```yaml
agents:
  enabled: false
  runs-dir: "~/.ccpa/agent-runs"
  max-concurrency: 1
  max-runtime-ms: 600000
  sync-wait-ms: 30000
  max-files: 200
  max-file-bytes: 1048576
  max-total-bytes: 10485760
  keep-runs: 50
  runners:
    claude-code:
      enabled: true
      command: "claude"
      modes:
        read-only: ["-p", "{prompt}", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob,LS"]
        workspace-write: ["-p", "{prompt}", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--permission-mode", "dontAsk", "--allowedTools", "Read,Write,Edit"]
    codex-cli:
      enabled: true
      command: "codex"
      modes:
        read-only: ["exec", "--cd", "{workspace}", "--sandbox", "read-only", "--ephemeral", "--", "{prompt}"]
        workspace-write: ["exec", "--cd", "{workspace}", "--sandbox", "workspace-write", "--ephemeral", "--", "{prompt}"]
    grok-cli:
      enabled: true
      command: "grok"
      modes:
        read-only: ["-p", "{prompt}", "--cwd", "{workspace}", "--output-format", "json", "--permission-mode", "bypassPermissions", "--always-approve", "--tools", "read_file,grep_search,list_dir", "--no-memory", "--no-subagents", "--disable-web-search", "--sandbox", "read-only"]
        workspace-write: ["-p", "{prompt}", "--cwd", "{workspace}", "--output-format", "json", "--permission-mode", "bypassPermissions", "--always-approve", "--tools", "read_file,search_replace,grep_search,list_dir,bash", "--no-memory", "--no-subagents", "--disable-web-search", "--sandbox", "workspace"]
```

P1 can start with built-in templates and expose only the high-level limits in config. Advanced template overrides belong in P2 after the core behavior is stable.

## Security Model

- Existing CCPA API-key middleware protects all `/v1/agent-runs` endpoints.
- `agents.enabled` defaults to `false`.
- All upload paths are relative POSIX-like paths. Reject absolute paths, `..`, empty names, backslash traversal, null bytes, symlinks, and oversized files.
- Reject uploaded VCS metadata paths such as `.git`, `.hg`, and `.svn`; CCPA owns the temporary workspace repository metadata.
- Decode file content in memory, enforce per-file and total decoded byte limits, then write with `fs.open` flags that prevent accidental directory use.
- Create a fresh workspace per run and never run agents in the CCPA repo or in caller-provided paths.
- Use `child_process.spawn(command, argsArray)` without a shell.
- Kill the process tree on timeout or cancel.
- Store stdout/stderr in files but return bounded snippets in JSON.
- Do not put prompt or file content into monitor logs.
- Before diff collection, rewrite the temporary `.git/config` to a narrow safe
  config and run git with disabled system/global config, disabled hooks,
  disabled fsmonitor, and disabled external diff.

## P2

- Multipart and zip/tar.gz upload for larger projects.
- SSE event stream: `GET /v1/agent-runs/:id/events`.
- Durable queue with pending/running/completed/failed/canceled states and restart recovery.
- Run retention cleanup by count, age, and bytes.
- Monitor dashboard panel for recent Agent Runs.
- Webhook callback on completion.
- Structured output with JSON Schema.
- Incremental uploads based on previous run/file hashes.
- Per-API-key policy: allowed agents, allowed modes, size limits, and concurrency.

## P3

- Containerized or OS-sandboxed execution per run.
- Remote workers so CCPA can schedule agent runs on NAS or another host without exposing paths to clients.
- Multi-turn sessions and resumable agent conversations.
- Patch apply workflow with server-side approval endpoints.
- Multi-agent pipelines, for example Claude plans, Codex implements, Grok reviews.
- Full provenance bundle: input hashes, runner versions, command template version, diff, logs, and result.
- Admin UI for queue, cancel, retention, and artifact download.

## Testing Strategy

- Unit-test config normalization and disabled-by-default behavior.
- Unit-test file path and size validation.
- Unit-test workspace materialization and diff generation.
- Integration-test API endpoints using a fake runner command.
- Verify cancellation and timeout behavior.
- Verify `/v1/agent-runs` remains protected by API key.
- Keep real CLI smoke tests manual or opt-in, because they consume provider quota and depend on local auth.
