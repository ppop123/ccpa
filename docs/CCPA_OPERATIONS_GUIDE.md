# CCPA Operations Guide

This guide covers the current public-facing CCPA runtime. Historical design
notes live under [docs/plans](plans/README.md); treat them as dated context, not
as operational truth.

## Runtime Shape

CCPA runs a single local HTTP process that exposes OpenAI-compatible endpoints
for enabled providers:

- Claude through local Claude OAuth tokens stored in `auth-dir`
- Codex through the configured Codex auth file, normally `~/.codex/auth.json`
- experimental Grok through the configured Grok OAuth file, normally `~/.grok/auth.json`

The default local base URL is:

```text
http://127.0.0.1:8317
```

The public health endpoint returns only non-sensitive runtime identity:

```json
{
  "status": "ok",
  "service": "ccpa",
  "version": "3.0.0",
  "started_at": "2026-06-29T00:00:00.000Z",
  "uptime_ms": 1234
}
```

When the project is built with `npm run build`, `/health` also includes
`build.git_commit`, `build.git_branch`, `build.git_dirty`, and `build.built_at`.

## Configuration

Start from the example config:

```bash
cp config.example.yaml config.yaml
```

Minimum fields to review:

```yaml
host: ""
port: 8317
auth-dir: "~/.ccpa"

api-keys:
  - "sk-replace-with-a-long-random-key"

codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"
```

`host: ""` listens on all interfaces. For a strictly local process, set
`host: "127.0.0.1"`.

Local rate limiting is disabled by default for single-operator workflows. Enable
`rate-limit.enabled: true` before exposing the service to untrusted clients.

## Upgrade Notes

For fresh public installs, clone the public repository and start from
`config.example.yaml`:

```bash
git clone https://github.com/ppop123/ccpa
cd ccpa
cp config.example.yaml config.yaml
```

For local installs that predate the public checkout name, migrate the working
directory, launchd wrapper, and external healthcheck wrapper to the `ccpa`
checkout path, then rebuild and verify:

```bash
npm run build
npm run release:verify -- \
  --require-provider-status ok \
  --require-build-commit "$(git rev-parse HEAD)" \
  --require-external-healthcheck-dir "$(pwd)"
```

The runtime keeps a read-only compatibility fallback for proxy variables stored
in an older LaunchAgent plist. New installs should use the current
`com.wy.ccpa.plist` naming.

## Authentication

Clients must send one of:

```text
Authorization: Bearer <configured-api-key>
x-api-key: <configured-api-key>
```

Never commit `config.yaml`, OAuth files, generated token files, or real API
keys. Run the release secret scan before publishing:

```bash
npm run secrets:scan
```

## Provider Setup

Claude:

```bash
node dist/index.js --login --manual
```

Codex:

```bash
node dist/index.js --login-codex
```

Grok:

```bash
grok login --oauth
```

Grok support is experimental because the OAuth file is owned by the Grok CLI and
the entitlement surface can change.

## Running

Build and start:

```bash
npm install
npm run build
npm start
```

The startup log should begin with:

```text
ccpa running on http://<host>:8317
```

## Operational Checks

Low-cost canary:

```bash
npm run canary -- --require-provider-status ok
```

Strict local release verification:

```bash
npm run release:verify -- \
  --require-provider-status ok \
  --require-build-commit "$(git rev-parse HEAD)" \
  --require-external-healthcheck-dir "$(pwd)"
```

Release readiness summary:

```bash
npm run release:readiness -- --list
```

Read-only upstream matrix plan:

```bash
npm run upstream:matrix
```

Only run `npm run upstream:matrix -- --apply` when you intentionally want real
provider requests and quota usage.

## Monitoring

Useful local endpoints:

- `GET /health`
- `POST /v1/agent-runs`
- `GET /v1/agent-runs/:id`
- `GET /v1/agent-runs/:id/artifacts`
- `POST /v1/agent-runs/:id/cancel`
- `GET /admin/accounts`
- `GET /admin/usage`
- `GET /admin/usage/recent`
- `GET /monitor`

Admin endpoints require a configured API key. `/monitor` serves a static browser
shell and fetches admin JSON from the browser after you enter an API key.

Monitor interpretation notes:

- Provider Status is the cross-provider readiness view for Claude, Codex, and
  Grok.
- Claude Accounts is Claude-specific. Codex and Grok use auth-file readiness,
  so they do not appear as Claude-style account rows.
- Claude account cards show lifetime account totals. The small account-panel
  metadata line shows Claude request count since the current process started.
- Usage Breakdown and Live Traffic are memory-only session metrics and reset on
  process restart.
- Live Traffic marks rows from the final recorded outcome. A transient upstream
  network failure that is recovered by retry and ends with HTTP 200 is recorded
  as OK.
- `probe:contract` in the Source column marks the no-upstream compatibility
  probe run by `npm run contract:check`.

## Agent Runs

Agent Runs is an optional execution surface for trusted local/LAN automation.
It accepts uploaded file contents, creates a temporary workspace under
`agents.runs-dir`, runs `claude`, `codex`, or `grok` CLI in that workspace, and
returns the final output, changed files, unified diff, and artifacts archive.

It is disabled by default:

```yaml
agents:
  enabled: false
```

Enable it only on trusted networks:

```yaml
agents:
  enabled: true
  max-concurrency: 1
  max-runtime-ms: 600000
  max-total-bytes: 10485760
```

When running under launchd, prefer absolute runner commands if your shell has
multiple CLI installs. For example, point `agents.runners.claude-code.command`
at the Claude Code binary that supports the flags in this guide, and point
`agents.runners.grok-cli.command` at the installed Grok binary if `~/.grok/bin`
is not in the launchd `PATH`.

P1 request format is JSON:

```bash
curl http://127.0.0.1:8317/v1/agent-runs \
  -H "Authorization: Bearer <configured-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "claude-code",
    "mode": "workspace-write",
    "wait": true,
    "prompt": "Review these files and make the smallest useful fix.",
    "files": [
      {"path": "README.md", "content": "# Demo\n", "encoding": "utf8"}
    ]
  }'
```

Supported P1 agents are `claude-code`, `codex-cli`, and `grok-cli`. Supported
modes are `read-only` and `workspace-write`; both modes operate only on the
temporary uploaded-file workspace. CCPA never modifies the caller's original
directory. The caller should review and apply `diff` or download
`artifacts.tar.gz` from `/v1/agent-runs/:id/artifacts`.
Completed run directories are retained up to `agents.keep-runs`; older run
records and artifacts are removed automatically.

Grok headless editing requires `bypassPermissions` plus an explicit built-in
tool allowlist. CCPA also runs Grok with `--sandbox read-only` for read-only
requests and `--sandbox workspace` for workspace-write requests, so the Grok
process can only write inside the temporary run workspace and Grok's own state
directories.

`GET /admin/accounts` includes an `agents` object with the Agent Runs enablement
state, configured limits, and runner command names. It does not include prompts
or uploaded file contents.

## Logs And Healthcheck

The repository healthcheck wrapper is:

```bash
npm run healthcheck -- --no-restart
```

The live rollout helper can install an external healthcheck wrapper:

```bash
npm run rollout:live -- --apply --install-external-healthcheck
```

Strict preflight and release verification can require that wrapper to point at a
specific checked-out directory:

```bash
npm run rollout:preflight -- \
  --require-provider-status ok \
  --require-build-commit "$(git rev-parse HEAD)" \
  --require-external-healthcheck-dir "$(pwd)"
```

## Deployment

Default local rollout sequence:

```bash
COMMIT="$(git rev-parse HEAD)"
npm run rollout:live -- --apply --require-build-commit "$COMMIT"
```

For a clean candidate directory on another machine:

```bash
git fetch --all --tags
git checkout <commit-or-tag>
npm install
npm run build
COMMIT="$(git rev-parse HEAD)"
npm run rollout:live -- --apply --require-build-commit "$COMMIT"
npm run release:verify -- --require-provider-status ok --require-build-commit "$COMMIT"
```

Do not claim a rollout is complete until `/health.build.git_commit` matches the
candidate commit and `release:verify` passes.

## Troubleshooting

- `provider_status: degraded`: at least one enabled provider is unavailable;
  inspect `/admin/accounts` for provider-specific hints.
- `account_token_expired`: refresh or redo the Claude login.
- `grok_auth_unavailable` or `grok_auth_expired`: rerun `grok login --oauth`.
- `endpoint_not_implemented`: the endpoint is intentionally outside the current
  CCPA surface.
- `git_dirty: true` in `/health.build`: the running build was created from a
  dirty worktree; rebuild from a clean commit before publishing.

## Release Checklist

Before publishing:

```bash
npm run typecheck
npm run test:unit
npm run test:smoke
npm run test:ops
npm run secrets:scan
npm run security:posture
npm run security:audit
npm run release:readiness -- --list
npm run release:verify -- --require-provider-status ok
```

Then rerun the old-name scan used by the release checklist. Any remaining match
in public docs or runtime code must be either removed or documented as an
intentional compatibility shim.
