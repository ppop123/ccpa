# CCPA Compatibility Fix Plan

Date: 2026-06-09
Scope: make the current Claude/Codex subscription-to-API proxy reliable for personal OpenAI-compatible use.

## Context

The service is intended for trusted LAN and local callers. LAN exposure is acceptable for this project as long as API key auth remains mandatory and keys are not leaked. Therefore rate limiting is not the first repair item; protocol correctness, red tests, and operational truthfulness come first.

Current verification baseline:

- `npm run build` passes.
- `npx tsx --test tests/*.test.ts` fails: 57/60 pass.
- The 3 failures are all Codex image generation / `partial_image` handling.
- `/v1/responses` does not normalize string `input`.
- `/v1/embeddings` is unimplemented and currently returns Express HTML 404.
- `/admin/accounts` already includes both Claude and Codex provider status; any doc or issue saying "Claude only" is stale.

## Goals

1. Restore a green automated test suite.
2. Improve OpenAI-compatible behavior for the common client paths this project claims to support.
3. Keep subscription safety defaults: `store=false`, API key auth, no accidental prompt/key logging.
4. Make the operations guide match code and current limitations.
5. Avoid broad refactors until the broken surface is stable.

## Non-Goals

- Do not implement the entire OpenAI API surface in this pass.
- Do not add multi-account Claude pooling yet.
- Do not expose this as an unauthenticated public internet service.
- Do not change the deployment model or require a new database.
- Do not perform live upstream load tests unless explicitly approved.

## Phase 0: Preflight And Baseline

Actions:

- Save current evidence before changes:
  - `npm run build`
  - `npx tsx --test tests/*.test.ts`
  - `git diff --stat`
- Confirm current config still requires API keys for `/v1/*` and `/admin/*`.
- Do not touch LaunchAgent/plist or live service until code-level tests pass.

Acceptance:

- Baseline failures are documented.
- No runtime service restart has been performed during code edits.

## Phase 1: Fix Codex Image Partial Handling

Problem:

- `src/providers/codex-sse.ts` handles `response.output_item.added` / `done`, but not `response.image_generation_call.partial_image`.
- `src/providers/codex-images.ts` expects `output[].result` or equivalent image b64.
- Tests already describe the desired behavior.
- This is a merge regression, not a new feature. The pre-merge reference implementation exists at `src/providers/codex-sse.ts.bak-pre-merge-2026-06-09`.
- Do not restore the `.bak` wholesale: current `codex-sse.ts` has a better generic `mergeOutputItem()` architecture, and only needs image partials folded into that output array.

Files:

- `src/providers/codex-sse.ts`
- `tests/codex-sse.test.ts`
- `tests/smoke.test.ts`

Implementation:

- In `collectCodexResponseFromSse()`, handle `response.image_generation_call.partial_image`.
- Merge partial image data into the matching `image_generation_call` output item by `item_id`.
- Preserve:
  - `id`
  - `type: "image_generation_call"`
  - `result`
  - `output_format`
  - optional `background`
  - current status if present
- If the partial arrives before the item is added, create or cache a placeholder and merge it later.
- If a later `response.output_item.done` for the same image item lacks `result`, preserve the existing partial `result` instead of clobbering it.
- Treat multiple partials as progressive updates; last partial wins.
- Keep existing text delta fallback behavior unchanged.
- Do not change `/v1/chat/completions` streaming protocol in this phase unless tests force it.

Suggested helper shape:

```ts
function mergeImagePartial(current: any, data: any): any {
  const itemId = typeof data?.item_id === "string" ? data.item_id : null;
  const b64 = typeof data?.partial_image_b64 === "string" ? data.partial_image_b64 : "";
  if (!itemId || !b64) return current;

  const output = Array.isArray(current?.output) ? [...current.output] : [];
  const index = output.findIndex((item) => item?.id === itemId);
  const base = index >= 0 ? output[index] : { id: itemId, type: "image_generation_call", status: "in_progress" };

  const merged = {
    ...base,
    type: "image_generation_call",
    result: b64,
    output_format: data.output_format || base.output_format || "png",
    ...(data.background ? { background: data.background } : {}),
  };

  if (index >= 0) output[index] = merged;
  else output.push(merged);
  return { ...current, output };
}
```

Acceptance:

- `npx tsx --test tests/codex-sse.test.ts` passes.
- `npx tsx --test tests/smoke.test.ts` passes for image generation tests.
- Full suite moves from 57/60 to 60/60.

## Phase 2: Normalize Responses API String Input

Problem:

- OpenAI Responses API accepts `input` as string or array.
- Current `normalizeCodexRequestBody()` only normalizes array items and leaves string input untouched.
- Claude responses path may also mishandle string input depending on router/provider.

Files:

- `src/providers/codex-request.ts`
- `src/providers/codex-responses.ts`
- `src/proxy/responses.ts`
- `tests/codex-responses.test.ts`
- `tests/smoke.test.ts`

Implementation:

- Add local normalization for:
  - `input: "hello"`
  - `input: [{role:"system", ...}]`
- For Codex, convert string input to a user message item accepted by the upstream Responses API.
- For Claude responses path, ensure string input becomes a user message rather than empty `messages`.
- Keep `instructions` defaulting to `""`.
- Keep `store=false` default.

Suggested shape:

```ts
if (typeof normalized.input === "string") {
  normalized.input = [{ role: "user", content: normalized.input }];
}
```

Acceptance:

- Add tests proving `POST /v1/responses` with `input: "hi"` reaches upstream as a user message.
- Verify both Codex and Claude route behavior where practical with mocks.
- No regression in existing responses streaming tests.

## Phase 3: Add JSON 404 For `/v1/*`

Problem:

- Unimplemented OpenAI endpoints such as `/v1/embeddings` return HTML.
- OpenAI SDK clients expect JSON error bodies and can fail with parse errors.

Files:

- `src/server.ts`
- `tests/smoke.test.ts` or a new focused server test

Implementation:

- Add a final `/v1` catch-all after all registered `/v1` routes:

```ts
app.use("/v1", (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint not implemented: ${req.method} ${req.path}`,
      type: "invalid_request_error",
      code: "endpoint_not_implemented",
    },
  });
});
```

- Keep `/health` and `/monitor` behavior unchanged.
- Keep API key middleware before the catch-all, so unknown `/v1/*` endpoints still require auth.

Acceptance:

- `POST /v1/embeddings` with a valid key returns `404 application/json`.
- Missing/invalid key still returns 401/403 before endpoint-not-implemented.
- Existing routes still work.

## Phase 4: Correct Operations Guide And Remove Secrets

Problem:

- `docs/CCPA_OPERATIONS_GUIDE.md` is useful but not yet authoritative.
- It contains stale claims, wrong line references, real API key examples, token file/email paths, and remote assertions not verified in this pass.
- Because this deployment is personal and the guide is currently local/untracked, secret redaction is lower priority than correcting stale technical claims. Redact before committing, syncing broadly, or sharing outside the trusted environment.

Files:

- `docs/CCPA_OPERATIONS_GUIDE.md`

Implementation:

- When preparing the guide for commit or external sharing, replace full API keys with placeholders such as `sk-LOCAL-REDACTED`.
- When preparing the guide for commit or external sharing, replace concrete account email/token filename with pattern examples unless needed for private local-only notes.
- Mark `50.9` facts as either verified with exact command/date or "needs remote verification".
- Correct:
  - `/admin/accounts` already includes Codex provider status.
  - image generation currently depends on the Phase 1 fix and test status.
  - `--manual` login does not need to stop service to free port 54545.
  - CodexAuthStore uses mtime cache, not unconditional reread.
  - `/admin/accounts` does not expose `nextRefreshAttemptAt`.
  - any "not a git repo" claim.
- Move audit metadata and verifier backlog out of the main operator path or clearly label it as appendix.

Acceptance:

- For any committed/shared version, `rg -n "sk-[A-Za-z0-9_-]{20,}|@gmail|access_token|refresh_token" docs/CCPA_OPERATIONS_GUIDE.md` returns no real secrets.
- Known issue list matches current code after Phases 1-3.
- Runbook commands are accurate and do not imply unverified remote facts.

## Phase 5: Observability Cleanup

Problem:

- Cache read/creation tokens are exposed in responses but not aggregated in usage/dashboard.
- Logs can contain account identifiers and are not rotated.

Files:

- `src/monitoring/usage.ts`
- `src/monitoring/http-usage.ts`
- `src/monitoring/dashboard-page.ts`
- deployment docs or LaunchAgent docs

Implementation:

- Track `cache_creation_input_tokens` and `cache_read_input_tokens` in usage totals.
- Add cache hit/read fields to `/admin/usage` and `/monitor`.
- Avoid logging full account identifiers where not needed; prefer masked email or provider name.
- Document log rotation as deployment-level setup. Do not silently alter plist/log paths in this code pass.

Acceptance:

- Tests cover usage aggregation for cache fields.
- Dashboard renders cache fields without exposing API keys or prompts.
- Existing `/admin/usage/recent` shape remains backward-compatible.

## Phase 6: Reliability Improvements

Problem:

- Claude account cooldown and refresh backoff are in memory.
- Codex path has transient fetch retry but no 401 refresh/relogin strategy.
- `CLAUDE_MODELS` is hardcoded.

Recommended order:

1. Persist Claude account state in `~/.ccpa/state.json`.
2. Add a safe Codex 401 recovery behavior:
   - reload auth file after 401 if mtime changed;
   - return a clear relogin hint if unchanged;
   - do not spawn interactive login from request handlers.
3. Move Claude model list and aliases to config with current hardcoded values as defaults.
4. Keep `store=false` as default, but expose `codex.store` config for advanced users.

Acceptance:

- Restart does not erase cooldown/backoff counters.
- Codex 401 error tells the operator exactly how to refresh auth.
- `/v1/models` remains stable with current config.
- Existing tests still pass.

## Rate Limit Position

Current deployment allows trusted LAN callers and requires API keys. Keep rate limiting default disabled for now, but document the boundary:

- Acceptable: local/LAN trusted clients with strong API key.
- Not acceptable: public internet exposure without reverse proxy, TLS, IP allowlist, and rate limiting.

Optional later change:

- Add a commented `rate-limit` block in `config.example.yaml`.
- Add runbook advice for enabling it if the service is exposed beyond trusted LAN.

## Recommended Execution Order

1. Phase 1 via the targeted `mergeImagePartial` port, using `src/providers/codex-sse.ts.bak-pre-merge-2026-06-09` only as field-mapping reference.
2. Phase 3 JSON `/v1` catch-all. This is tiny, isolated, and removes a client-facing SDK parse failure.
3. Phase 2 Responses string input normalization. Add focused tests for `input: "hi"` on both Codex and Claude routes where practical.
4. Phase 5 and Phase 6 as capacity allows.
5. Phase 4 stale-claim cleanup on demand; redaction before commit, broad sync, or external sharing.

## Final Verification Matrix

Run after each phase that changes code:

```bash
npm run build
npx tsx --test tests/codex-sse.test.ts
npx tsx --test tests/codex-responses.test.ts tests/codex-responses-stream.test.ts
npx tsx --test tests/smoke.test.ts
npx tsx --test tests/*.test.ts
git diff --check
```

Optional live smoke only after user approval:

```bash
curl -sS http://127.0.0.1:8317/health
curl -sS -H "Authorization: Bearer $KEY" http://127.0.0.1:8317/v1/models
curl -sS -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:8317/v1/responses \
  -d '{"model":"gpt-5.4","input":"hi","stream":false}'
```

## Review Questions For Claude

1. Is Phase 1's partial image merge strategy correct for all observed Codex SSE event orders?
2. Should string `input` normalize to plain `{role, content}` or typed content parts for Codex?
3. Is the `/v1` catch-all error shape close enough to OpenAI SDK expectations?
4. Are any doc redactions too aggressive for a private operations guide?
5. Should `store=false` remain hard default, or become config-driven in the same pass as Phase 2?
