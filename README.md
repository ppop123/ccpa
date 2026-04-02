# ccpa

Claude + Codex Proxy API

[中文](./README_CN.md)

`ccpa` is a small local proxy that turns your existing Claude and Codex login state into OpenAI-compatible HTTP APIs.

It is built for one machine, one operator, and one clear use case:

- call Claude and Codex from your own scripts
- expose both providers behind one local `base_url`
- route automatically by `model`

It is intentionally not a multi-account pool, billing platform, or generic API gateway.

The repository is called `ccpa`. Some runtime logs and config paths still use the older internal name `auth2api`.

## What it does

- serves Claude and Codex from one process
- supports `POST /v1/chat/completions`
- supports `POST /v1/responses`
- supports `GET /v1/models`
- supports Claude native `POST /v1/messages` and `POST /v1/messages/count_tokens`
- provides admin status at `GET /admin/accounts`
- provides in-memory usage stats at `GET /admin/usage` and `GET /admin/usage/recent`
- provides a browser dashboard shell at `GET /monitor`

Routing is simple:

- `claude-*` -> Claude
- `gpt-*`, `o*`, `codex-*` -> Codex

## What you need

- Node.js 20+
- a Claude login if you want Claude models
- a Codex login if you want Codex models

Claude auth is stored under `auth-dir`.

Codex auth is read from `codex.auth-file`, with fallback to `~/.codex/auth.json` when the configured path does not exist.

The process can start in any of these modes:

- Claude only
- Codex only
- Claude + Codex

If neither side is available, startup fails.

## Install

```bash
git clone https://github.com/ppop123/ccpa
cd ccpa
npm install
npm run build
cp config.example.yaml config.yaml
```

## 5-minute setup

1. Put a real API key in `config.yaml`.
2. Configure the Codex model allowlist in `codex.models`.
3. Log in to the providers you want.
4. Start the server.

Minimal config:

```yaml
host: ""
port: 8317

auth-dir: "~/.auth2api"

api-keys:
  - "sk-replace-with-a-long-random-key"

codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"

debug: "off"
```

For the full config surface, see [config.example.yaml](/Users/wy/auth2api/config.example.yaml).

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

Important runtime rules:

- `codex.enabled: false` disables all Codex routing
- models not listed in `codex.models` return `400 Unsupported model`
- `/v1/models` returns Claude built-ins plus configured Codex models

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `POST /v1/responses` | OpenAI-compatible responses |
| `POST /v1/messages` | Claude native messages |
| `POST /v1/messages/count_tokens` | Claude native token counting |
| `GET /v1/models` | List available models |
| `GET /admin/accounts` | Provider availability and login hints |
| `GET /admin/usage` | Aggregate usage counters |
| `GET /admin/usage/recent` | Recent request summaries |
| `GET /monitor` | Browser dashboard shell for the admin endpoints |
| `GET /health` | Health check |

Both `/v1` and `/admin` require your API key.

## Monitoring

`/admin/accounts` tells you whether Claude and Codex are currently available.

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
  -v ~/.auth2api:/data \
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

- [auth2api](https://github.com/AmazingAng/auth2api)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
