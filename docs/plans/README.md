# CCPA Plan Archive

This directory contains dated design, implementation, review, and handoff notes.
These documents are intentionally append-only context: they explain decisions,
but they are not always current runtime truth.

## Current Handoff

- [2026-06-22 release handoff](2026-06-22-ccpa-release-handoff.md): latest
  release-oriented handoff note, including verification commands, quota-spending
  boundaries, and remaining product gaps as of that date.

Before relying on the handoff, compare it with current `git status`, `git log`,
`npm run canary`, and `npm run release:verify`.

## Compatibility Stabilization

- [2026-06-09 compatibility fix plan](2026-06-09-ccpa-compatibility-fix-plan.md):
  original compatibility repair plan for Responses string input, JSON 404s,
  image partial handling, observability, and reliability.
- [2026-06-09 compatibility plan review](2026-06-09-ccpa-compatibility-fix-review.md):
  adversarial review of that plan and the first repair order.

These files are useful for auditing why a fix was prioritized, but many listed
items have since been closed. Check the Operations Guide and tests for the
current state.

## Historical Feature Plans

- [Agent Runs design](2026-07-08-agent-runs-design.md): uploaded-file CLI
  agent execution surface for Claude Code, Codex CLI, and Grok CLI.
- [Agent Runs implementation plan](2026-07-08-agent-runs-implementation.md):
  task-level P1 implementation plan for config, validation, run lifecycle,
  routes, docs, and verification.
- [Codex dual-provider design](2026-03-30-codex-dual-provider-design.md):
  provider abstraction, routing, Codex auth, streaming, and error-handling
  design.
- [Codex dual-provider implementation plan](2026-03-30-codex-dual-provider.md):
  task-level implementation plan for adding Codex alongside Claude.
- [Usage monitoring plan](2026-03-30-usage-monitoring.md): in-memory usage
  tracking and admin usage endpoints.
- [Browser monitor dashboard plan](2026-04-01-browser-monitor-dashboard.md):
  `/monitor` browser dashboard shell.
- [Failure request context plan](2026-04-14-failure-request-context.md):
  request context capture for failure diagnostics and monitor display.

## Adding A New Plan

Use this naming pattern:

```text
docs/plans/YYYY-MM-DD-short-topic.md
```

Start each new plan with a short status paragraph that says whether it is a
proposal, an active implementation plan, a review, or a historical handoff.
When behavior changes after a plan lands, update the README or Operations Guide
instead of rewriting old plan history.
