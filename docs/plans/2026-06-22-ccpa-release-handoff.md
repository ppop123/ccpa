# CCPA Release Handoff - 2026-06-22

## Scope

This handoff captures the current CCPA stabilization candidate for `/Users/wy/auth2api`.
The goal of the candidate is to turn the local and 50.9 deployments from daily firefighting into a stable self-use OpenAI-compatible gateway for Claude and Codex subscription resources.

## Current Verified State

- Local repo: `/Users/wy/auth2api`
- Local branch: `codex/ccpa-stabilization`
- Current runtime identity is verified by command, not by this static file: run `COMMIT="$(git rev-parse HEAD)"` and then `npm run canary -- --require-provider-status ok --require-build-commit "$COMMIT"` from the deployed tree.
- Phase 184 example runtime commit before this handoff refresh: `caea69d Thread build commit through rollout gates`.
- Primary push remote for this product fork: `ccpa https://github.com/ppop123/ccpa.git`
- Local branch: pushed to `ccpa/codex/ccpa-stabilization`; use `git status --short --branch` and `npm run release:readiness -- --list` for the latest docs/source candidate state.
- Local live service: after `npm run rollout:live -- --apply --require-build-commit "$COMMIT"`, `/health.build.git_dirty=false`; strict `npm run release:verify -- --require-provider-status ok --require-build-commit "$COMMIT" --require-external-healthcheck-dir "$(pwd)"` passed with `release_verify: yes`
- 50.9 live service: LaunchAgent now runs `/Users/wangyan/ccpa-candidates/f3afdf0-20260622165529/dist/index.js` with `/Users/wangyan/ccpa-candidates/f3afdf0-20260622165529/config.yaml`; strict canary reports `admin/accounts: ok (2/2 providers available)` and 13 models.
- 50.9 old live tree: `/Users/wangyan/ccpa` is no longer the LaunchAgent working directory. It remains a dirty historical tree and rollback reference; do not stage or normalize its remote-only files as product code.
- Dependency audit: local and 50.9 `npm audit --json` both report 0 vulnerabilities
- Config security posture: local and 50.9 `npm run security:posture` both report `findings: 0`, `security_posture: yes`; both warn that all-interface intranet bind is running without local rate limiting.
- Phase 169 note: explicit custom or empty `claude.models` is now enforced in both provider support checks and server routing; default built-in Claude models still allow future `claude-*` IDs.
- Phase 170 note: the same `claude.models` policy now applies to native `/v1/messages` and `/v1/messages/count_tokens`, so Anthropic-shaped clients cannot bypass a narrowed Claude allow-list.
- Phase 171 note: `npm run release:verify` now includes `npm run test:unit`, so provider/runtime regressions such as Phase 170's native Claude bypass are covered by the default release gate.
- Phase 172 note: `npm run release:verify` now includes `npm run typecheck`, so TypeScript compile errors are caught by the read-only release gate without writing `dist`.
- Phase 173 note: `npm run release:verify` now includes `npm run secrets:scan`, so release-facing docs/scripts/source/config are checked for real-looking API keys and OAuth tokens before preflight.
- Phase 174 note: `npm run secrets:scan` also includes visible git candidate files outside the fixed default paths, while still excluding tests and private runtime config.
- Phase 175 note: `npm run release:verify` now includes `npm run security:audit`, so moderate-or-higher npm advisories fail the default release gate.
- Phase 176 note: `npm run release:verify` now includes `npm run upstream:matrix` dry-run, so the real-upstream acceptance harness is checked without spending subscription quota.
- Phase 177 note: `npm run release:verify` now includes `npm run security:posture`, so missing, placeholder, or weak client API keys fail before live preflight. Intranet all-interface bind without local rate limiting remains a warning when strong API keys are configured.
- Phase 181 note: multiple `auth-dir/claude-*.json` token files are supported; CCPA chooses the first non-expired, non-cooldown Claude account and persists non-secret runtime backoff/counter state.
- Phase 182 note: `release:verify` strips `CCPA_*` runtime env from typecheck/test/diff/script-syntax steps while still allowing preflight/security posture to use explicit runtime config.
- Phase 183 note: `/health` exposes non-secret `build.git_commit`, `git_branch`, `git_dirty`, and `built_at` metadata when `dist/build-info.json` exists.
- Phase 184 note: `--require-build-commit <sha>` is now a first-class option for canary, rollout preflight, live rollout, and release verify.
- Phase 187 note: `rollout:preflight` and `release:verify` can require the external healthcheck wrapper to `cd` into the deployed repo/candidate path via `--require-external-healthcheck-dir <dir>`.
- Phase 188 note: `rollout:live --install-external-healthcheck` now preserves the resolved npm PATH for bare `npm` wrappers; 50.9 rollout commands should still pass `--npm-bin /opt/homebrew/bin/npm`.

## Candidate Shape

Latest local readiness:

- Command: `npm run release:readiness -- --list`
- `release_ready: yes`
- `modified: 0`
- `untracked candidates: 0`
- `transient artifacts: 0 visible`

Latest 50.9 live/candidate readiness:

- Candidate path: `/Users/wangyan/ccpa-candidates/f3afdf0-20260622165529`
- Commit: use `git rev-parse HEAD` inside the candidate worktree and require that value in canary/release verify
- Strict release gate: passed against live `127.0.0.1:8317`
- LaunchAgent rollback backup: `/Users/wangyan/Library/LaunchAgents/com.wangyan.ccpa.plist.bak-pre-clean-candidate-<short-sha>-<timestamp>`

Treat the local `/Users/wy/auth2api` branch and the remote clean candidate above as the code source of truth. The old `/Users/wangyan/ccpa` tree remains useful for rollback history and logs, but it is no longer the live runtime source.

## Review Buckets

The local worktree is currently clean, so `release:readiness -- --list` reports no candidate buckets. Use git history plus the release gates, not this document, for authoritative file lists.

## Safe Verification Commands

These commands are no-upstream or dry-run only:

```bash
npm run release:readiness -- --list
COMMIT="$(git rev-parse HEAD)"
DEPLOY_DIR="$(pwd)"
npm run release:verify -- --require-provider-status ok --require-build-commit "$COMMIT" --require-external-healthcheck-dir "$DEPLOY_DIR"
npm run rollout:preflight -- --require-provider-status ok --require-build-commit "$COMMIT" --require-external-healthcheck-dir "$DEPLOY_DIR"
npm run canary -- --require-provider-status ok --require-build-commit "$COMMIT"
npm run secrets:scan
npm run security:posture
npm run security:audit
npm run typecheck
npm run test:unit
npm run upstream:matrix
npm audit --json
git diff --check
```

Remote 50.9 equivalents should run with the non-login PATH:

```bash
ssh wangyan@192.168.50.9 'PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm --version'
ssh wangyan@192.168.50.9 'cd /Users/wangyan/ccpa && PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm run canary -- --url http://127.0.0.1:8317 --require-provider-status ok'
ssh wangyan@192.168.50.9 'cd /Users/wangyan/ccpa-candidates/f3afdf0-20260622165529 && COMMIT="$(git rev-parse HEAD)" && CCPA_BASE_URL=http://127.0.0.1:8317 CCPA_CONFIG=/Users/wangyan/ccpa-candidates/f3afdf0-20260622165529/config.yaml PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm run release:verify -- --require-provider-status ok --require-build-commit "$COMMIT" --require-external-healthcheck-dir /Users/wangyan/ccpa-candidates/f3afdf0-20260622165529'
```

## Quota-Spending Commands

Do not run these without explicit approval because they make real upstream Claude/Codex requests:

```bash
npm run upstream:matrix -- --apply
npm run upstream:matrix -- --apply --include-image
```

## Integration Recommendation

Preferred next release workflow:

1. Generate a fresh readiness manifest:
   ```bash
   npm run release:readiness -- --write-json /tmp/ccpa-release-readiness-final.json
   ```
2. Run strict local gate:
   ```bash
   COMMIT="$(git rev-parse HEAD)"
   npm run release:verify -- --require-provider-status ok --require-build-commit "$COMMIT" --require-external-healthcheck-dir "$(pwd)"
   ```
3. Optionally run quota-spending upstream matrix after explicit approval.
4. Keep pushing stabilization commits to `ccpa/codex/ccpa-stabilization`.
5. For future 50.9 updates, refresh `/Users/wangyan/ccpa-candidates/f3afdf0-20260622165529`, run `npm run build`, and use `npm run rollout:live -- --apply --install-external-healthcheck --npm-bin /opt/homebrew/bin/npm --require-build-commit "$COMMIT"` from that candidate path.
6. After every cutover, run canary/release verify with `--require-build-commit <expected-sha>` and `--require-external-healthcheck-dir <deployed-path>` from the deployed path.

Avoid staging remote-only `.bak` files or root-level historical handoff copies from 50.9 unless a separate cleanup/reconciliation decision is made.

## Remaining Product Gaps

- True upstream acceptance is still dry-run only until `upstream:matrix --apply` is explicitly approved and passes.
- The old `/Users/wangyan/ccpa` tree is still dirty and should be treated as rollback/history, not the source of truth.
- `/v1/embeddings` intentionally returns JSON `endpoint_not_implemented`; actual embeddings generation is still not implemented.
