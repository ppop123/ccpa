# Changelog

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
