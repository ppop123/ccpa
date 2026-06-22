# CCPA Release Handoff - 2026-06-22

## Scope

This handoff captures the current CCPA stabilization candidate for `/Users/wy/auth2api`.
The goal of the candidate is to turn the local and 50.9 deployments from daily firefighting into a stable self-use OpenAI-compatible gateway for Claude and Codex subscription resources.

## Current Verified State

- Local repo: `/Users/wy/auth2api`
- Local branch: `main`
- Local HEAD before the candidate: `7915477`
- Primary push remote for this product fork: `ccpa https://github.com/ppop123/ccpa.git`
- Local live service: strict `npm run release:verify -- --require-provider-status ok` passed with `release_verify: yes`
- 50.9 live service: strict canary reports `admin/accounts: ok (2/2 providers available)`
- 50.9 release gate: strict `npm run release:verify -- --require-provider-status ok` passed with `release_verify: yes`
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

## Candidate Shape

Latest local readiness manifest:

- Path: `/tmp/ccpa-release-readiness-phase177.json`
- `releaseReady`: `true`
- `candidateFiles`: 85
- `transientArtifacts`: 0

Latest 50.9 readiness manifest:

- Path: `/tmp/ccpa-release-readiness-phase177-50_9.json`
- `releaseReady`: `true`
- `candidateFiles`: 99
- `transientArtifacts`: 0

The remote candidate is broader because 50.9 still has extra local source/test/other files, including root-level historical handoff/script copies. Treat the local `/Users/wy/auth2api` candidate as the source of truth for code review and commits unless explicitly deciding to reconcile remote-only artifacts.

## Review Buckets

The local release readiness bucket summary is:

- `runtime-source`: 33 files
- `tests`: 29 files
- `scripts`: 11 files
- `docs`: 8 files including this handoff note
- `project-config`: 4 files

Use `npm run release:readiness -- --list` for the authoritative current file list. Do not hand-maintain candidate paths from this document.

## Safe Verification Commands

These commands are no-upstream or dry-run only:

```bash
npm run release:readiness -- --list
npm run release:verify -- --require-provider-status ok
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
ssh wangyan@192.168.50.9 'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin; cd /Users/wangyan/ccpa && npm run release:verify -- --require-provider-status ok'
ssh wangyan@192.168.50.9 'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin; cd /Users/wangyan/ccpa && npm run secrets:scan'
ssh wangyan@192.168.50.9 'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin; cd /Users/wangyan/ccpa && npm run security:posture'
ssh wangyan@192.168.50.9 'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin; cd /Users/wangyan/ccpa && npm run security:audit'
ssh wangyan@192.168.50.9 'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin; cd /Users/wangyan/ccpa && npm run upstream:matrix'
ssh wangyan@192.168.50.9 'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin; cd /Users/wangyan/ccpa && npm audit --json'
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
   npm run release:verify -- --require-provider-status ok
   ```
3. Optionally run quota-spending upstream matrix after explicit approval.
4. Create review commits from the local candidate. Reasonable commit split:
   - runtime protocol/provider/account changes
   - operational scripts and release gates
   - tests
   - docs/config
5. Push to `ccpa` remote or open a PR from a `codex/` branch.

Avoid staging remote-only `.bak` files from 50.9 unless a separate cleanup/reconciliation decision is made.

## Remaining Product Gaps

- True upstream acceptance is still dry-run only until `upstream:matrix --apply` is explicitly approved and passes.
- The current candidate is verified but still uncommitted; release rollback is therefore based on tar backups and dirty-worktree state, not git commits.
- Claude multi-account pooling remains a future capacity feature, not a blocker for current self-use stability.
