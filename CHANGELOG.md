# Changelog

## v3.0.0 - 2026-07-06

This release promotes the browser monitor and local contract probes into the
main release surface. It also fixes a usage-accounting edge case where a final
HTTP 200 response could still be shown as failed after an upstream retry.

### Highlights

- Clarified monitor request counters: Claude account cards now label lifetime
  account totals separately from process-session usage totals.
- Fixed retry success accounting across chat completions, Responses API,
  Claude native messages, and Claude native count_tokens. A transient upstream
  network failure that is recovered by retry now records the final request as
  successful instead of keeping stale failure context.
- Tagged contract-check traffic with `x-ccpa-source: probe:contract`, so the
  Live Traffic table can separate local compatibility probes from real clients.
- Documented that the Claude Accounts panel is Claude-specific. Codex and Grok
  readiness remain visible in the Provider Status card because those providers
  use separate auth-file state rather than Claude-style account rows.
- Added a sanitized browser-monitor screenshot for the GitHub README.

### Validation

- `npm exec -- tsx --test tests/admin-usage.test.ts`
- `npm exec -- tsx --test tests/contract-check-script.test.ts`
- `npm run typecheck`
- `git diff --check`

## v2.0.1 - 2026-06-29

This patch release prepares CCPA for the public GitHub repository and refreshes
the local release surface after the rename cleanup.

### Highlights

- Updated the package identity, runtime service name, default auth directory,
  README files, operations guide, and release tooling around the public `ccpa`
  project name.
- Documented the experimental SuperGrok OAuth provider path and keeps Grok
  visible in `/admin/accounts`, `/v1/models`, and the `/monitor` Provider
  Status card when configured.
- Hardened monitor freshness by serving `/monitor` and its admin JSON data with
  no-store caching semantics.
- Preserved the legacy LaunchAgent proxy-environment fallback for local upgrade
  compatibility, while keeping tracked public docs and source free of the old
  project-name string.
- Cleaned stale local worktree metadata and verified that the live service runs
  from `/Users/wy/ccpa`.

### Validation

- `npm run typecheck`
- `npm run test:unit`
- `npm run test:smoke`
- `npm run test:ops`
- `npm run secrets:scan`
- `npm run security:posture`
- `npm run release:readiness`
- `npm run release:verify -- --require-provider-status ok --require-build-commit <candidate> --require-external-healthcheck-dir /Users/wy/ccpa`

### Upgrade notes

- Fresh installs should clone `https://github.com/ppop123/ccpa` and use
  `auth-dir: "~/.ccpa"`.
- Existing local installs from the pre-public checkout should rebuild from a
  clean commit, update launchd wrappers to point at the new checkout directory,
  and rerun `npm run release:verify` before relying on the service.
- If proxy variables still live in an older LaunchAgent plist, CCPA will read
  them as a compatibility fallback, but new installs should use the current
  `com.wy.ccpa.plist` naming.

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
