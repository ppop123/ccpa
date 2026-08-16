# CCPA Quality And Verification

This file maps change risk to the smallest credible verification. Commands in
the first three levels are local and do not intentionally spend provider quota.

## Level 0: Documentation And Harness

Use for docs, navigation, and fixed entrypoint changes:

```bash
python3 scripts/check-harness.py
npm exec -- tsx --test tests/readme-docs.test.ts tests/harness-scripts.test.ts
git diff --check
```

## Level 1: Focused Contract

Run the smallest relevant test file while developing. Examples:

```bash
npm exec -- tsx --test tests/agent-routes.test.ts
npm exec -- tsx --test tests/config.test.ts
npm exec -- tsx --test tests/codex-responses.test.ts
```

Every behavior change needs a failing regression test before the implementation
change.

## Level 2: Full Local Verification

Use before handing off normal code changes:

```bash
./scripts/verify.sh
git diff --check
npm run secrets:scan
```

`scripts/verify.sh` runs typechecking, the complete unit suite, and the
operations-script suite. Run `npm run build` as well when the deliverable or
runtime consumes `dist/`.

## Level 3: Smoke

Use when HTTP composition, startup, provider routing, or packaged behavior may
have changed:

```bash
./scripts/smoke.sh
```

## Level 4: Live Runtime And Release

Use for rollout or release work:

```bash
npm run canary -- --require-provider-status ok
npm run release:verify -- --require-provider-status ok
```

When verifying a specific candidate, also require its build commit and external
healthcheck directory as described in the Operations Guide.

## Mutation And Quota Boundaries

- `npm run upstream:matrix` produces a read-only plan.
- `npm run upstream:matrix -- --apply` makes real provider requests and may
  spend quota.
- `npm run rollout:live -- --apply` changes the live service.
- `npm run security:audit` reaches the package registry and may change its
  result over time, but does not modify dependencies.

Do not cross a mutation, deployment, or quota boundary without explicit scope.

## Review Gate

All code-writing work in this repository requires a synchronous read-only
Claude Code review before commit or push. Blocking, high, security,
correctness, and regression findings must be resolved. The exact command shape
lives in `AGENTS.md`.

## Partially Verified Surfaces

- OAuth entitlements and provider availability are external and can drift.
- Grok support is experimental because its OAuth state and upstream behavior
  are controlled by the Grok CLI/xAI surface.
- Agent Runs validates workspace paths and fixes runner arguments, but remains
  a trusted-client execution surface.
- Usage metrics are process-memory state, not durable accounting.
- A passing local suite does not prove that the running launchd candidate uses
  the same commit; verify `/health.build.git_commit` during rollout.
