# CCPA Agent Guide

This is the task-oriented operating manual for coding agents and automation
clients. Use it for normal setup, API calls, Agent Runs, verification, and
triage. You should not need to inspect `src/` merely to consume CCPA.

For deeper operational procedures, use the
[Operations Guide](CCPA_OPERATIONS_GUIDE.md). For implementation boundaries,
use [ARCHITECTURE.md](../ARCHITECTURE.md).

## Source Of Truth

Use this order when information differs:

1. The live runtime: `GET /health`, `GET /v1/models`, and
   `GET /admin/accounts`.
2. The checked-out contract: `config.example.yaml`, `package.json`, this guide,
   and executable verification scripts.
3. The README files and the Operations Guide.
4. Dated files under `docs/plans/`, which are historical context.

Never assume that a model shown in an old example is enabled. Query
`GET /v1/models` before choosing a model for a caller.

## What CCPA Is

CCPA is a single Node.js process that turns local Claude, Codex, and optional
Grok login state into HTTP APIs. Its primary surface is OpenAI-compatible, with
additional Claude-native and uploaded-file Agent Runs endpoints.

It is designed for one trusted operator on a local machine or trusted LAN. It
is not a multi-tenant gateway, billing system, arbitrary shell API, or public
agent execution service.

## Choose The Right Surface

| Goal | Endpoint or command | Notes |
| --- | --- | --- |
| Discover runtime identity | `GET /health` | Public; no provider or account details |
| Discover enabled models | `GET /v1/models` | Authenticated; runtime model truth |
| Chat with any enabled provider | `POST /v1/chat/completions` | OpenAI-compatible |
| Use the Responses API | `POST /v1/responses` | OpenAI-compatible |
| Generate an image | `POST /v1/images/generations` | Codex or Grok image model |
| Edit an image | `POST /v1/images/edits` | Grok Image 2.0; JSON only |
| Use Claude's native schema | `POST /v1/messages` | Claude models only |
| Count Claude-native tokens | `POST /v1/messages/count_tokens` | Claude models only |
| Run a CLI agent on uploaded files | `POST /v1/agent-runs` | Disabled by default; trusted clients only |
| Inspect provider status and Agent Runs config | `GET /admin/accounts` | Authenticated; does not execute runners |
| Inspect in-memory usage | `GET /admin/usage` | Resets on process restart |
| Inspect recent traffic | `GET /admin/usage/recent` | Optional `?limit=N` |
| Open the monitor | `GET /monitor` | HTML is public; admin data still needs a key |

Model routing is deterministic:

- `claude-*` routes to Claude.
- `gpt-*`, `codex-*`, and `o` followed by a digit route to Codex.
- `grok-*` routes to Grok.
- The model must also be allowed by the active provider configuration.

## First-Time Setup

Requirements: Node.js 20+, Git, and local login state for at least one provider.
Agent Runs additionally needs the selected CLI runner installed.

```bash
npm install
cp config.example.yaml config.yaml
npm run build
```

Edit `config.yaml` before starting:

- Replace the example `api-keys` value with a long random secret.
- Enable only the providers you intend to use.
- Set `codex.models` and `grok.models` to the IDs you intentionally expose.
- Leave `agents.enabled: false` unless you need uploaded-file CLI execution.

`host: ""` resolves to `127.0.0.1`. To listen on a LAN, configure a concrete
address such as `0.0.0.0`, then apply network controls appropriate for a
trusted-only service. Never expose Agent Runs to an untrusted network.

Provider login commands:

```bash
npm run login
npm run login:codex
grok login --oauth
```

Only run the commands for providers you use. For a remote Claude login, use:

```bash
node dist/index.js --login --manual
```

Start the built service:

```bash
npm start
```

Use a non-default configuration file with:

```bash
node dist/index.js --config=/absolute/path/to/config.yaml
```

For source-level development, use `npm run dev` instead of building first.

## Runtime Preflight

Set local shell variables without committing their values:

```bash
export CCPA_ORIGIN="http://127.0.0.1:8317"
export CCPA_API_KEY="<one-api-key-from-config.yaml>"
```

Then check the process, configured models, and provider readiness:

```bash
curl -fsS "$CCPA_ORIGIN/health"

curl -fsS "$CCPA_ORIGIN/v1/models" \
  -H "Authorization: Bearer $CCPA_API_KEY"

curl -fsS "$CCPA_ORIGIN/admin/accounts" \
  -H "Authorization: Bearer $CCPA_API_KEY"
```

Authentication accepts either `Authorization: Bearer <key>` or
`x-api-key: <key>`. Every `/v1` and `/admin` route requires a configured key.
`/health` is intentionally unauthenticated.

## OpenAI-Compatible Calls

### Chat Completions

Replace the example model with an ID returned by `GET /v1/models`.

```bash
curl -fsS "$CCPA_ORIGIN/v1/chat/completions" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6",
    "messages": [{"role": "user", "content": "Reply with ok."}],
    "stream": false
  }'
```

OpenAI Python clients should use:

```python
from openai import OpenAI

client = OpenAI(
    api_key="<configured-api-key>",
    base_url="http://127.0.0.1:8317/v1",
)

response = client.chat.completions.create(
    model="<id-from-v1-models>",
    messages=[{"role": "user", "content": "Reply with ok."}],
)
print(response.choices[0].message.content)
```

For a quick local shell call, the repository helper reads the first API key
from `config.yaml`:

```bash
./scripts/call_ccpa.sh gpt-5.6 "Reply with ok."
```

### Responses

```bash
curl -fsS "$CCPA_ORIGIN/v1/responses" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6",
    "input": "Reply with ok.",
    "stream": false
  }'
```

#### Grok Agent Tools search

Use native Responses Agent Tools for new Grok search integrations. CCPA does
not rewrite this request or its typed search outputs and citation annotations:

```bash
curl -fsS "$CCPA_ORIGIN/v1/responses" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6",
    "input": "What did xAI release this week? Cite current sources.",
    "tools": [
      {"type": "web_search", "filters": {"allowed_domains": ["x.ai"]}},
      {"type": "x_search", "allowed_x_handles": ["xai"]}
    ],
    "tool_choice": "auto",
    "stream": false
  }'
```

The deprecated Chat Live Search bridge is intentionally narrower:

- `POST /v1/chat/completions` plus `search_parameters` is bridged only when
  `stream` is `false`, `null`, or omitted.
- The bridge accepts simple text `messages` only. Multimodal Chat content and
  tool-call history must be sent in their native Responses shapes instead of
  being guessed or dropped.
- When `mode: auto` or `mode: on` activates the bridge, the only accepted
  top-level Chat fields are `model`, `messages`, `search_parameters`, `stream`,
  `temperature`, `top_p`, `user`, `service_tier`, `max_tokens`,
  `max_completion_tokens`, `reasoning_effort`, `reasoning`, and `n`. Any other
  Chat field fails closed with HTTP 400 `unsupported_legacy_search_parameter`.
- `mode: auto` and `mode: on` map to Agent Tools `tool_choice`; `mode: off`
  removes `search_parameters` and continues as an ordinary Chat request.
- Web domain allow/exclude filters, X handle allow/exclude filters, and
  `return_citations` are supported when their Agent Tools equivalents preserve
  the request semantics. `from_date` and `to_date` are supported only when X is
  the sole source; Agent Tools Web Search has no date filter, so any date plus
  Web source fails closed with HTTP 400.
- Legacy `return_citations: false` sends
  `include: ["no_inline_citations"]`, asking xAI to remove inline citation links,
  and the mapped Chat response omits top-level `citations`.
- `stream: true` returns HTTP 400
  `legacy_live_search_streaming_unsupported`; use native streaming Responses
  rather than expecting the gateway to synthesize Chat SSE events.
- `max_search_results`, separate `news` or `rss` sources, `country`,
  `safe_search`, X engagement filters, and conflicting/unknown legacy fields
  return HTTP 400 `unsupported_legacy_search_parameter`. The gateway does not
  reinterpret or silently drop them.

Responses is the compatibility-complete surface for Agent Tools output items
and structured citations. The old bridge maps only the final assistant text,
deduplicated citation URLs, and usage back into a Chat Completion response.

### Claude-Native Messages

```bash
curl -fsS "$CCPA_ORIGIN/v1/messages" \
  -H "x-api-key: $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Reply with ok."}]
  }'
```

### Image Generation And Editing

```bash
curl -fsS "$CCPA_ORIGIN/v1/images/generations" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A tiny blue icon on a white background",
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

For Grok Image 2.0 generation:

```bash
curl -fsS "$CCPA_ORIGIN/v1/images/generations" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-imagine-image-2.0",
    "prompt": "A glass greenhouse at sunrise",
    "aspect_ratio": "16:9",
    "resolution": "2k",
    "quality": "medium"
  }'
```

For a single-image Grok edit, use the xAI JSON shape:

```bash
curl -fsS "$CCPA_ORIGIN/v1/images/edits" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-imagine-image-2.0",
    "prompt": "Render this as a detailed pencil sketch",
    "image": {
      "type": "image_url",
      "url": "https://example.com/source.png"
    },
    "response_format": "url"
  }'
```

Use `image` for one source or `images` for up to three sources. An `image_url`
may be a public URL or a base64 data URI. Image edits currently require the
exact `grok-imagine-image-2.0` model, and it must appear in `GET /v1/models`.
Image edits require `application/json`: the OpenAI SDK's
`images.edit()` emits `multipart/form-data`, which xAI does not accept, and CCPA
does not translate multipart requests in this release. It returns
`415 unsupported_media_type`; use direct JSON HTTP or an xAI SDK for edits.

## Agent Runs

Agent Runs sends a prompt plus file contents to a server-controlled temporary
workspace. CCPA runs a fixed CLI command, collects output and a Git diff, and
offers a downloadable artifact. It never receives or modifies a caller-owned
host path.

### Enable And Check Runners

Start from the full block in `config.example.yaml`. The minimum switch is:

```yaml
agents:
  enabled: true
```

Supported runners are `claude-code`, `codex-cli`, and `grok-cli`. Under launchd
or another restricted service environment, configure absolute runner command
paths when the service `PATH` differs from your interactive shell.

After restarting CCPA, inspect `GET /admin/accounts`. Its `agents` object shows
whether Agent Runs is enabled, each configured runner command, and selected
limits: concurrency, runtime, file count, and total bytes. It does not probe
whether a runner command exists, has a compatible version, or can start in the
service environment. Validate the configured binary as the service user, then
use a minimal `read-only` run before accepting real workloads.

### Create A Run

```bash
curl -fsS "$CCPA_ORIGIN/v1/agent-runs" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "codex-cli",
    "mode": "workspace-write",
    "wait": true,
    "timeout_ms": 120000,
    "prompt": "Review these files and make the smallest useful fix.",
    "files": [
      {"path": "README.md", "content": "# Demo\n", "encoding": "utf8"}
    ]
  }'
```

Request contract:

- Required: `agent`, non-empty `prompt`.
- Optional: `mode`, `wait`, `timeout_ms`, `files`.
- `mode` defaults to `read-only`; valid values are `read-only` and
  `workspace-write`.
- `wait` defaults to synchronous waiting. `wait: false` returns `202`
  immediately. A synchronous request also returns `202` if it exceeds
  `agents.sync-wait-ms` while the run continues.
- `timeout_ms` may shorten but cannot exceed the server's
  `agents.max-runtime-ms`.
- File `encoding` is `utf8` by default or may be `base64`.

Default bundle limits are 200 files, 1 MiB per file, and 10 MiB total. Absolute
paths, backslashes, paths that normalize to the current/parent directory or
escape the workspace, duplicate paths, and `.git`, `.hg`, or `.svn` path
segments are rejected. Internal `..` segments may normalize away—for example,
`a/../README.md` becomes `README.md`—so clients should send canonical relative
paths rather than relying on normalization.

The exact limits come from the active `config.yaml`; only the selected limits
exposed by `GET /admin/accounts` are discoverable through the API. In
particular, `sync-wait-ms`, `max-file-bytes`, and `keep-runs` are not returned.

### Poll, Cancel, And Download

```bash
curl -fsS "$CCPA_ORIGIN/v1/agent-runs/<run-id>" \
  -H "Authorization: Bearer $CCPA_API_KEY"

curl -fsS -X POST "$CCPA_ORIGIN/v1/agent-runs/<run-id>/cancel" \
  -H "Authorization: Bearer $CCPA_API_KEY"

curl -fS "$CCPA_ORIGIN/v1/agent-runs/<run-id>/artifacts" \
  -H "Authorization: Bearer $CCPA_API_KEY" \
  -o artifacts.tar.gz
```

Statuses are `pending`, `running`, `completed`, `failed`, `canceled`, and
`timed_out`. A run result exposes `output_text`, `error_text`, `changed_files`,
`diff`, `failure_code`, timestamps, exit code, and `artifacts_url` when ready.
It does not expose server workspace paths.

Review the returned diff or artifact before applying it to a real project.
Client input cannot add arbitrary CLI flags; runner arguments are fixed by the
server. Even so, Agent Runs remains a trusted-client feature, especially for
the Claude Code runner, which does not have a CCPA-managed OS sandbox profile.

## Verification Entry Points

For documentation or harness changes:

```bash
python3 scripts/check-harness.py
npm exec -- tsx --test tests/readme-docs.test.ts tests/harness-scripts.test.ts
git diff --check
```

For a normal code handoff, run the stable local verification entrypoint:

```bash
./scripts/verify.sh
```

For smoke coverage:

```bash
./scripts/smoke.sh
```

For a live process, start with the low-cost canary:

```bash
npm run canary -- --require-provider-status ok
```

Use the stricter `npm run release:verify` contract for release or rollout work.
See [docs/QUALITY.md](QUALITY.md) for the verification matrix.

`npm run upstream:matrix` is a read-only plan. Adding `--apply` makes real
provider requests and may spend quota. `npm run rollout:live -- --apply`
changes the live service. Do not run either mutation without explicit scope.

All code-writing work must follow the synchronous Claude Code review rule in
`AGENTS.md` before commit or push.

## Failure Playbook

| Symptom | Check first | Action |
| --- | --- | --- |
| Connection refused | `GET /health`, process output | Build/start CCPA; verify host and port |
| `401 missing_api_key` | Request headers | Add Bearer or `x-api-key` header |
| `403 invalid_api_key` | Active `config.yaml` | Use a key from the config loaded by the running process |
| `400 unsupported_model` | `GET /v1/models` | Select an exposed model or update provider config and restart |
| `415 unsupported_media_type` on image edits | Request `Content-Type` | Send the xAI JSON shape with `application/json`; multipart is not converted |
| Provider unavailable | `GET /admin/accounts` | Follow provider hint; repeat login if expired |
| `503 agent_runs_disabled` | `admin.accounts.agents.enabled` | Enable Agent Runs and restart only if the trust boundary is acceptable |
| `503 agent_runner_disabled` | Runner entry in `/admin/accounts` | Enable/install that runner; use an absolute command path for services |
| Run fails although runner is enabled | Service user's `PATH` and CLI version | Fix the configured command; `/admin/accounts` does not execute or version-check it |
| `429 agent_concurrency_exceeded` | Active run IDs | Poll or cancel the active run; retry after it finishes |
| Agent create returns `202` | Returned status and run ID | Poll `GET /v1/agent-runs/:id`; this is not a failure |
| Artifact returns `409` | Run status | Wait for a terminal state, then download again |
| `/health.build.git_commit` is stale | Build metadata | Rebuild and restart the intended candidate; run release verification |

Set `debug: "errors"` for upstream failure details or `debug: "verbose"` for
per-request access logging. Do not enable verbose logging casually around
sensitive workloads.

## Repository Map For Maintainers

- `src/index.ts`: CLI mode selection and process startup.
- `src/config.ts`: config schema, defaults, and normalization.
- `src/server.ts`: middleware and HTTP route composition.
- `src/providers/`: Claude, Codex, Grok adapters and model routing.
- `src/proxy/`: Claude translation, passthrough, retries, and streaming.
- `src/agents/`: Agent Runs validation, runner templates, lifecycle, diff, and
  artifacts.
- `src/monitoring/`: usage tracking and the browser monitor.
- `scripts/`: fixed health, canary, rollout, release, and security entrypoints.
- `tests/`: executable contracts for providers, routes, scripts, and docs.

Inspect implementation code when you are changing a contract, routing rule,
security boundary, or provider adapter. For ordinary consumption and
operations, this guide plus the live discovery endpoints should be enough.
