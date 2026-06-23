# Changelog

## v2.0.0 - 2026-06-23

This is the first stable self-use CCPA release after the June stabilization
cycle. The focus is making the project practical as an OpenAI-compatible
gateway for personal Claude and Codex subscription resources.

### Highlights

- Expanded OpenAI-compatible coverage across chat completions, responses,
  images, embeddings fallback behavior, model listing, and Anthropic-native
  passthrough routes.
- Hardened Codex support for streaming, Responses API translation, image
  generation, upstream error mapping, auth retry behavior, and model routing.
- Improved Claude account handling with multiple token files, cooldown/backoff
  state, retry headers, account availability reporting, and native endpoint
  allow-list enforcement.
- Added monitoring and admin visibility for provider health, account snapshots,
  cache hit rate, request source, client IP, user agent, failure context, and
  endpoint usage.
- Added release and operations tooling: canary, contract check, healthcheck,
  live rollout, rollout preflight, release readiness, strict release verify,
  secret scan, security posture, log maintenance, build-info stamping, and
  upstream matrix dry-run.
- Strengthened security defaults around API key parsing, placeholder rejection,
  per-key local rate limiting, redacted logs, npm audit, and release-facing
  secret scanning.
- Added the CCPA operations guide and release handoff docs for local and 50.9
  deployments.

### Compatibility Notes

- The package version is now `2.0.0`; `/health` reports the running package
  version and build metadata when built with `npm run build`.
- The release gate is intentionally strict. Run `npm run release:verify` before
  deploying a candidate.
- `npm run upstream:matrix` remains dry-run by default and does not spend
  subscription quota unless `--apply` is explicitly passed.
- Some previously accepted but unsupported OpenAI parameters are now rejected
  with OpenAI-style JSON errors instead of being silently passed through.

## 1.1.1 - 2026-04-09

This release tightens runtime observability and fixes recent Codex compatibility regressions.

### Added

- Browser monitor now breaks traffic down by request source in addition to provider, endpoint, and model
- Recent request records now include source, client IP, and user-agent metadata
- Cooldown handling is shared across Claude endpoints with explicit status mapping for server and network cooldowns

### Fixed

- Codex non-stream responses now preserve assistant output when upstream `response.completed` events carry an empty `output` array
- Monitor status codes now distinguish upstream rate limits from local server and network cooldowns instead of collapsing them into `429`
- Admin usage tests now cover source tracking and the updated Codex SSE shape

## 1.1.0 - 2026-03-30

This release turns the original single-provider proxy into a practical local dual-provider service for Claude and Codex.

### Added

- Codex provider support with model-based routing for `/v1/chat/completions` and `/v1/responses`
- `--login-codex` to trigger the official `codex login` flow from the project CLI
- Codex auth discovery via `codex.auth-file` with fallback to `~/.codex/auth.json`
- In-memory monitoring endpoints:
  - `GET /admin/usage`
  - `GET /admin/usage/recent`
- Helper script `scripts/call_ccpa.sh` for local shell usage

### Changed

- `/v1/models` now returns the combined Claude + Codex model set
- Runtime startup now allows Claude-only, Codex-only, or dual-provider mode
- Unsupported Codex models now fail explicitly instead of falling back incorrectly
- README and README_CN now document the published `ccpa` repository name and current local usage flow
- Default generated API keys use a formal `sk-...` format

### Fixed

- Codex upstream compatibility for `instructions`, `store`, and stream handling
- Non-stream Codex requests now work by aggregating upstream SSE server-side
- Codex routing now respects both `codex.enabled` and `codex.models`
- `/admin/accounts` now returns clearer provider status and login hints

### Upgrade notes

- Existing Claude token storage remains under `auth-dir`
- Codex auth remains separate and is discovered from `codex.auth-file` or `~/.codex/auth.json`
- Usage metrics are memory-only in this release and reset on process restart
