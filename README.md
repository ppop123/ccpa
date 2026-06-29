# ccpa

Claude + Codex + Grok Proxy API

[中文](./README_CN.md)

`ccpa` is a small local proxy that turns your existing Claude, Codex, and experimental Grok login state into OpenAI-compatible HTTP APIs.

It is built for one machine, one operator, and one clear use case:

- call Claude, Codex, and optionally Grok from your own scripts
- expose the enabled providers behind one local `base_url`
- route automatically by `model`

It is intentionally not a multi-account pool, billing platform, or generic API gateway.

## Documentation

- [Documentation map](docs/README.md): where to find current usage docs,
  operations runbooks, historical plans, and handoff notes.
- [Operations Guide](docs/CCPA_OPERATIONS_GUIDE.md): detailed deployment,
  endpoint, model-routing, OAuth recovery, rollback, and known-gap reference.
- [Plan archive](docs/plans/README.md): dated design and stabilization notes.

## What it does

- serves Claude, Codex, and experimental Grok from one process
- supports `POST /v1/chat/completions`
- supports `POST /v1/responses`
- supports `POST /v1/images/generations`
- supports `GET /v1/models`
- supports Claude native `POST /v1/messages` and `POST /v1/messages/count_tokens`
- provides admin status at `GET /admin/accounts`
- provides in-memory usage stats at `GET /admin/usage` and `GET /admin/usage/recent`
- provides a browser dashboard shell at `GET /monitor`

Routing is simple:

- `claude-*` -> Claude
- `gpt-*`, `o*`, `codex-*` -> Codex
- `grok-*` -> Grok

## What you need

- Node.js 20+
- a Claude login if you want Claude models
- a Codex login if you want Codex models
- a SuperGrok OAuth login if you want experimental Grok models

Claude auth is stored under `auth-dir`.

Codex auth is read from `codex.auth-file`, with fallback to `~/.codex/auth.json` when the configured path does not exist.

Experimental Grok auth is read from `grok.auth-file`, with fallback to `~/.grok/auth.json`. This adapter uses the local `grok login --oauth` state and forwards requests to xAI's OpenAI-compatible API; it does not require an xAI API key, but it should be treated as experimental because the OAuth file format is owned by the Grok CLI.

The process can start in any of these modes:

- Claude only
- Codex only
- Grok only
- any combination of the enabled providers

If no provider is available, startup fails.

## Install

```bash
git clone https://github.com/ppop123/ccpa
cd ccpa
npm install
npm run build
cp config.example.yaml config.yaml
```

Upgrade note for pre-public local checkouts: rebuild from a clean commit, point
your launchd wrapper and healthcheck wrapper at the `ccpa` checkout directory,
and rerun `npm run release:verify` before relying on the live process. CCPA still
reads proxy variables from an older LaunchAgent plist as a compatibility
fallback, but new installs should use the current `com.wy.ccpa.plist` naming.

## 5-minute setup

1. Put a real API key in `config.yaml`.
2. Configure the Codex model allowlist in `codex.models`.
3. Log in to the providers you want.
4. Start the server.

Minimal config:

```yaml
host: ""
port: 8317

auth-dir: "~/.ccpa"

api-keys:
  - "sk-replace-with-a-long-random-key"

rate-limit:
  enabled: false

codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"
    - "gpt-5.4-mini"
    - "gpt-5.2"
    - "gpt-image-2"

grok:
  enabled: false
  auth-file: "~/.grok/auth.json"
  base-url: "https://api.x.ai/v1"
  models:
    - "grok-4.3"

debug: "off"
```

For the full config surface, see [config.example.yaml](config.example.yaml).

Local `/v1` rate limiting is disabled by default. If you want it, set `rate-limit.enabled: true` and tune `window-ms` / `max-requests` in [config.example.yaml](config.example.yaml). When enabled, buckets are isolated by authenticated API key, so one local client key cannot consume another key's quota from the same IP. Local rate-limit 429s include `Retry-After` and `X-RateLimit-*`; Claude account cooldown 429s and refresh-backoff 503s include `Retry-After`.

Start the server:

```bash
node dist/index.js
```

Default address:

```text
http://127.0.0.1:8317
```

## Login

Claude login:

```bash
npm run login
```

Manual Claude login for remote shells:

```bash
node dist/index.js --login --manual
```

Codex login:

```bash
npm run login:codex
```

That runs the official `codex login` flow. If Codex CLI is missing, ccpa prints a clear install hint.

Experimental Grok login:

```bash
grok login --oauth
```

Then enable `grok.enabled` and list the Grok model IDs you want to expose in `grok.models`.

If only one provider is logged in, the server still starts and only exposes that side. `/admin/accounts` shows what is missing.

## Call it from scripts

Use any OpenAI-compatible client with:

- `base_url = http://127.0.0.1:8317/v1`
- `api_key = one of api-keys in config.yaml`

### curl

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Reply with ok."}],
    "stream": false
  }'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-sk-...",
    base_url="http://127.0.0.1:8317/v1",
)

resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Reply with ok."}],
)

print(resp.choices[0].message.content)
```

### Local shell helper

```bash
./scripts/call_ccpa.sh gpt-5.4 "Reply with ok."
./scripts/call_ccpa.sh claude-sonnet-4-6 "Reply with ok."
```

The helper reads `config.yaml`, uses `api-keys[0]`, and calls the local server for you.

### Image generation

`gpt-image-2` uses the same Codex OAuth login as Codex chat models and is exposed
through the OpenAI-compatible Images API. The external `gpt-image-2` name is a
compatibility alias; the Codex upstream request is routed through `gpt-5.5` with
the `image_generation` tool because Codex rejects `gpt-image-2` as a raw model id
for ChatGPT accounts.

```bash
curl http://127.0.0.1:8317/v1/images/generations \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A tiny blue icon on a white background",
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

## Models

Built-in Claude models:

- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001`
- `claude-haiku-4-5`

Claude aliases:

- `opus`
- `sonnet`
- `haiku`

Codex models come only from `codex.models`.
Grok models come only from `grok.models` and require `grok.enabled: true`.

Important runtime rules:

- `codex.enabled: false` disables all Codex routing
- `grok.enabled: false` disables all Grok routing
- models not listed in `codex.models` return `400 Unsupported model`
- models not listed in `grok.models` return `400 Unsupported model`
- `/v1/models` returns Claude built-ins plus configured Codex and Grok models

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `POST /v1/responses` | OpenAI-compatible responses |
| `POST /v1/images/generations` | OpenAI-compatible image generations through Codex or Grok OAuth |
| `POST /v1/messages` | Claude native messages |
| `POST /v1/messages/count_tokens` | Claude native token counting |
| `GET /v1/models` | List available models |
| `GET /admin/accounts` | Provider availability and login hints |
| `GET /admin/usage` | Aggregate usage counters |
| `GET /admin/usage/recent` | Recent request summaries |
| `GET /monitor` | Browser dashboard shell for the admin endpoints |
| `GET /health` | Public process health and runtime identity |

Both `/v1` and `/admin` require your API key.

## Monitoring

`/admin/accounts` tells you whether Claude, Codex, and Grok are currently available.
It also includes a `server` object with the running package version, process
start time, uptime, and a provider readiness summary.

`/health` does not require an API key and intentionally does not include
account or provider details. It returns only non-sensitive process identity,
such as `service`, `version`, `started_at`, and `uptime_ms`.

`/admin/usage` gives aggregate counters since process start, including:

- total requests
- per-provider counts
- per-endpoint counts
- per-model counts

`/admin/usage/recent` gives the newest request summaries first.

These stats are memory-only and reset on restart.

If you want to inspect them in a browser, open:

```text
http://127.0.0.1:8317/monitor
```

The `/monitor` page itself does not embed live data server-side. It asks for an API key in the browser, then calls the existing `/admin/accounts`, `/admin/usage`, and `/admin/usage/recent` endpoints over same-origin requests.

## Canary

Run a low-cost canary after building, restarting, or changing launchd config:

```bash
npm run canary -- --url http://127.0.0.1:8317
```

The canary reads `api-keys[0]` from `config.yaml` by default and does not print
the key. It checks `/health`, `/admin/accounts`, `/v1/models`, and the expected
JSON 404 from `/v1/embeddings`; it does not send a real model-generation
request upstream. It also requires provider readiness of `degraded` or better
by default, meaning at least one provider must be available. Use
`--require-provider-status ok` when you want all enabled providers ready, or
`--require-provider-status any` for diagnostics that should only verify the
server contract.

When `dist/index.js` exists locally, the canary also checks that the live
process started after the local dist build time. Use `--no-dist-check` when
checking a remote instance from a machine that does not share the same dist
files.

`npm run build` writes `dist/build-info.json`, and `/health` exposes the build
git commit. When you need to prove that the live process is running a specific
candidate commit, run:

```bash
npm run canary -- --url http://127.0.0.1:8317 --require-build-commit "$(git rev-parse HEAD)"
```

Run the no-upstream OpenAI-compatible contract gate when you want broader
protocol coverage without spending upstream quota:

```bash
npm run contract:check -- --url http://127.0.0.1:8317
```

It checks auth failures, admin readiness, model listing, JSON 404s, malformed
JSON handling, unsupported-model errors, and local validation errors for chat,
responses, image-generation, and Claude native messages/count_tokens routes. It
intentionally uses only local validation/error paths and does not call Claude or
Codex generation upstream.

Before a live rollout, use the read-only preflight to check local rollout assets,
run the same low-cost canary plus contract gate, and print the manual commands
that would be needed next:

```bash
npm run rollout:preflight
```

The preflight does not run `launchctl`, edit plist files, replace external
healthcheck scripts, or clean live logs.

When you are ready to perform the rollout, first inspect the dry-run execution
plan:

```bash
npm run rollout:live
```

This prints the build, `launchctl kickstart`, post-rollout canary, contract
gate, and no-restart healthcheck steps without executing them. Add `-- --apply`
only when you intend to execute the rollout. Replacing the external
`/Users/wy/ccpa-healthcheck.sh` wrapper is a separate opt-in step:
`-- --apply --install-external-healthcheck`.

Before staging or handing a release candidate to another agent, run the local
readiness hygiene check:

```bash
npm run release:readiness
```

It is read-only. It allows dirty candidate changes, but fails if transient local
artifacts such as `.DS_Store`, `.claude/` worktrees, or `*.bak-pre-*` backup
files are still visible in `git status`. The default output groups candidate
files into review buckets such as runtime source, tests, scripts, docs, and
project config. Use `npm run release:readiness -- --list` to expand paths under
each bucket, or `npm run release:readiness -- --json` when handing the manifest
to another agent. Use `npm run release:readiness -- --write-json
/tmp/ccpa-release-readiness.json` when you want to save a handoff artifact; the
JSON includes generation time, repo/status source, review commands, and the
explicit quota-spending upstream matrix commands.

For a final read-only release gate, run:

```bash
npm run release:verify
```

It runs release readiness, secret scanning (`npm run secrets:scan`),
configuration security posture checks (`npm run security:posture`), dependency
security audit (`npm run security:audit`), the no-quota upstream matrix dry-run
(`npm run upstream:matrix`), rollout preflight, TypeScript typecheck
(`npm run typecheck`), the provider/runtime unit suite (`npm run test:unit`),
the smoke suite, the ops-script behavior suite (`npm run test:ops`), `git diff
--check`, and syntax checks for discovered
`scripts/ccpa-*.mjs` /
`scripts/ccpa-*.sh` ops scripts. It fails fast on the first failing gate and
redacts email/API-key-shaped output. It does not build, restart launchd, stage
files, or call model-generation upstreams.

You can run the secret scan directly with `npm run secrets:scan`. It scans
release-facing docs, scripts, source, project config, and visible git candidate
files while intentionally excluding `tests/`, `config.yaml`, `dist/`, and local
auth directories.

You can run the configuration posture check directly with
`npm run security:posture`. It fails missing, placeholder, or weak client API
keys. It warns, but does not fail, when the service binds all interfaces while
local rate limiting is disabled, because intranet deployments protected by
strong API keys are an intentional supported mode.

You can run the dependency audit directly with `npm run security:audit`. It uses
`npm audit --audit-level=moderate`, so moderate or higher advisories fail the
release gate.

The default rollout preflight requirement is `degraded`, meaning at least one
provider is available. Use `npm run release:verify -- --require-provider-status
ok` when the handoff must prove all enabled providers are ready.
When `--require-external-healthcheck-dir` is set, rollout preflight also treats
the external wrapper's log-maintenance exports as part of the strict contract:
the wrapper must enable `CCPA_HEALTHCHECK_MAINTAIN_LOGS` and set `CCPA_LOG_PATHS`
for `/tmp/ccpa.*` plus `$HOME/ccpa/logs/launchd.{stdout,stderr}.log`.

When you intentionally want to spend upstream quota for a real end-to-end
matrix, start with the same dry-run plan used by `release:verify`:

```bash
npm run upstream:matrix
```

If your local config has moved to newer aliases, override the planned models
without editing the script:

```bash
npm run upstream:matrix -- --codex-model gpt-5.5 --claude-model claude-opus-4-8
```

Add `-- --apply` only when you want to send real generation requests through the
local CCPA service. The default apply matrix covers Codex and Claude text paths
for `/v1/chat/completions` and `/v1/responses`; add `-- --apply --include-image`
only when you also want to spend an image generation request. Text checks require
the model to answer `ok`; an HTTP 200 or `status: completed` alone is not enough
to pass the apply matrix.

For launchd or cron-style monitoring, use the repository healthcheck wrapper:

```bash
npm run healthcheck -- --no-restart
```

It runs the same low-cost canary plus the no-upstream contract gate, reads the
API key from config or environment, and does not call model-generation
endpoints. When used as a watchdog, leave restart enabled or set
`CCPA_HEALTHCHECK_RESTART=true`; for manual diagnostics, use `--no-restart`.
Set `CCPA_HEALTHCHECK_RUN_CONTRACT=false` only if you need a shallow health
watchdog during diagnostics. Set `CCPA_HEALTHCHECK_MAINTAIN_LOGS=true` if you
want the healthcheck to run the log maintenance helper before the canary; log
maintenance failures are recorded but do not block the canary/contract checks or
trigger restarts. Wrappers installed by
`npm run rollout:live -- --apply --install-external-healthcheck` also default
`CCPA_LOG_PATHS` to cover both `/tmp/ccpa.*` and
`$HOME/ccpa/logs/launchd.{stdout,stderr}.log` so local and 50.9 launchd logs
receive the same redaction/rotation maintenance.

For local launchd logs, run the repository log maintenance helper periodically:

```bash
npm run logs:maintain
```

It redacts email addresses and `sk-*` API-key-shaped strings from the default
`/tmp/ccpa.stdout.log`, `/tmp/ccpa.stderr.log`, and `/tmp/ccpa-healthcheck.log`
files. If a log exceeds `CCPA_LOG_MAX_BYTES` (default `1048576`), it writes a
redacted copy to `<log>.1` and truncates the current file in place so launchd can
keep writing to the same path. Use `CCPA_LOG_PATHS`, `CCPA_LOG_MAX_BYTES`, and
`CCPA_LOG_KEEP` to customize the paths, threshold, and retention count.

## Debugging

`debug` supports three levels:

- `off`
- `errors`
- `verbose`

`verbose` adds per-request access logs. `errors` logs upstream and network failures without full access logging.

## Claude Code

Point Claude Code at ccpa like this:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code uses native `/v1/messages`, so ccpa passes those requests through directly.

## Docker

```bash
docker build -t ccpa .

docker run -d \
  -p 8317:8317 \
  -v ~/.ccpa:/data \
  -v ~/.codex/auth.json:/root/.codex/auth.json:ro \
  -v ./config.yaml:/config/config.yaml \
  ccpa
```

If you persist Claude login in Docker, set:

```yaml
auth-dir: "/data"
```

If you change the Codex auth path inside the container, update `codex.auth-file` to match.

## Smoke test

```bash
npm run test:smoke
```

This test suite uses mocked upstream responses and does not call real Claude or Codex services.

## Inspired by

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
