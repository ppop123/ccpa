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
  "version": "2.0.0",
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
- `GET /admin/accounts`
- `GET /admin/usage`
- `GET /admin/usage/recent`
- `GET /monitor`

Admin endpoints require a configured API key. `/monitor` serves a static browser
shell and fetches admin JSON from the browser after you enter an API key.

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
