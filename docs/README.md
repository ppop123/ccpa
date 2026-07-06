# CCPA Documentation Map

This directory is the documentation entry point for CCPA. Use it to decide
which document is current operational guidance and which document is historical
planning context.

## Start Here

- [Project README](../README.md): quick setup, supported endpoints, model
  routing, monitoring, canary, rollout, and release verification commands.
- [中文 README](../README_CN.md): Chinese quick-start and operations summary.
- [Operations Guide](CCPA_OPERATIONS_GUIDE.md): detailed runbook for local and
  50.9 deployments, endpoint behavior, model routing, OAuth recovery, logs,
  rollback, and known gaps.
- [Monitor screenshot](assets/ccpa-monitor-3.0.0.png): sanitized browser
  monitor image used by the GitHub README.
- [Plan archive](plans/README.md): dated design notes, implementation plans,
  compatibility reviews, and release handoff notes.
- [CHANGELOG](../CHANGELOG.md): repository-level release notes when maintained.

## Current Versus Historical

Treat the README files and the top "current status" section of the Operations
Guide as the best human-readable source for current usage. For live runtime
truth, verify with the canary and release gates instead of relying on dated
text:

```bash
npm run canary -- --require-provider-status ok --require-build-commit "$(git rev-parse HEAD)"
npm run release:verify -- --require-provider-status ok
```

Documents under [plans](plans/README.md) are useful for understanding why the
system was built this way, but most of them are historical snapshots. A dated
plan can describe behavior that has since been fixed or intentionally changed.

The root-level `task_plan.md`, `findings.md`, and `progress.md` files are
agent working logs. They are useful during active stabilization work, but they
are not the product manual.

## Maintenance Rules

- Keep README and README_CN synchronized for user-facing setup, rollout, and
  safety guidance.
- Keep current operational corrections in the Operations Guide near the top so
  old appendix notes do not look authoritative.
- Add new design or review notes under `docs/plans/YYYY-MM-DD-topic.md`.
- Do not put real API keys, OAuth tokens, refresh tokens, or account secrets in
  docs. Run `npm run secrets:scan` before handing off a release candidate.
- Prefer adding an index or status note over moving old files. Many historical
  plans are useful as evidence and should remain stable.
