# CCPA Compatibility Fix Plan — Review

Date: 2026-06-09
Reviewer: Claude (Opus)
Subject: review of `docs/plans/2026-06-09-ccpa-compatibility-fix-plan.md`
Context: personal / self-hosted use. Security and secret-leak items are explicitly **low priority** for this deployment and are de-emphasized below.

---

## TL;DR

The plan is **accurate and well-scoped**. Every factual baseline claim in it checks out against the code (verified below). Ship it largely as written.

Two things the plan does **not** account for, and they change how Phase 1 should be executed:

1. **Phase 1 is a merge regression, not a missing feature.** The 3 failing tests used to pass. A merge earlier today (`2026-06-09`) overwrote the image-handling logic in `src/providers/codex-sse.ts`. The pre-merge version — which fully handled `partial_image` — is sitting right there as `src/providers/codex-sse.ts.bak-pre-merge-2026-06-09`. Use it as the reference implementation. This makes Phase 1 a low-risk port, not a from-scratch design.
2. **Do not wholesale-restore the `.bak`.** The post-merge file changed the output-merging architecture (`mergeOutputItem` now handles `output_item.added`/`.done` and places items into `response.output` by index/id). The `.bak` used a parallel `images` Map applied at the end. Restoring the `.bak` verbatim would double-handle image items. The correct fix is a single new handler that folds `partial_image` into the existing output item. Exact code below.

Everything else (Phases 2, 3, 5, 6 and the rate-limit position) is correct. Phase 4 is fine but its priority should drop to near-zero for personal use; its real value is fixing stale technical claims, not redacting secrets.

---

## Verification baseline (all confirmed)

Verified on the `main` working tree (not the stale worktree under `.claude/worktrees/`).

| Plan claim | Status | Evidence |
|---|---|---|
| `npm run build` passes | ✅ | `tsc` clean |
| `tsx --test tests/*.test.ts` → 57/60 | ✅ | `# pass 57 # fail 3` |
| 3 failures all Codex image / `partial_image` | ✅ | `not ok 35` (codex-sse), `not ok 47`, `not ok 48` (smoke) — see appendix |
| `codex-sse.ts` lacks `response.image_generation_call.partial_image` handling | ✅ | current file handles only `created` / `output_text.delta` / `output_item.added\|done` / `completed` |
| `/v1/responses` does not normalize string `input` | ✅ | `normalizeCodexRequestBody` only maps `Array.isArray(input)` — `codex-request.ts:28` |
| `/v1/embeddings` returns Express HTML 404 | ✅ | `server.ts` has no `/v1` catch-all; falls through to Express default HTML |
| `/admin/accounts` already exposes Claude **and** Codex status | ✅ | `server.ts:271-281` returns both `claude` and `codex` |
| Rate limiting is config-gated and **off by default** | ✅ | `createRateLimitMiddleware` returns `null` when `!config["rate-limit"]?.enabled` — `server.ts:26-62,169-171` |

The plan's "Current verification baseline" section is trustworthy.

---

## Critical finding: Phase 1 is a regression, and the reference impl already exists

### What happened
`src/providers/codex-sse.ts.bak-pre-merge-2026-06-09` (untracked, not gitignored) is the pre-merge version. It contained:
- a handler for `response.image_generation_call.partial_image` (`.bak:130-141`) mapping `data.partial_image_b64 → result`, `item_id → id`, plus `output_format` / `background`;
- a handler for `response.output_item.done` of type `image_generation_call` preferring a real `result`/`b64_json`/`image_b64` (`.bak:143-158`);
- an `images: Map<string, any>` accumulator (`.bak:78`) and `buildOutputFromImages` / `mergeCollectedOutput` applied after the read loop (`.bak:34-60,166`).

The merge replaced this with a generic `mergeOutputItem` + `mergeResponseSnapshot` design that **dropped all image-specific branches**. That is exactly why tests 35/47/48 regressed.

### Why not just restore the `.bak`
The post-merge architecture is actually an improvement for the non-image path:
- `mergeOutputItem` (`codex-sse.ts:22-43`) now handles **both** `output_item.added` and `output_item.done`, placing items into `response.output` by `output_index` or matching `id`.
- `mergeResponseSnapshot` (`codex-sse.ts:1-20`) now **preserves** `current.output` when an incoming snapshot has an empty/absent `output` array.

In all three failing tests the sequence is `output_item.added (image_generation_call, no result)` → `partial_image` → `completed (no/empty output)`. With the new code, the `added` event already places the image item at `output[0]` and `completed` preserves it. **The only missing step is folding the `partial_image` payload into that existing item.** Restoring the `.bak`'s parallel Map would re-add the same item by id and you'd have to reconcile two code paths.

### Recommended fix (fits current architecture)
Add one handler in the event loop, before/after the `output_item` branch in `collectCodexResponseFromSse`:

```ts
function mergeImagePartial(current: any, data: any): any {
  const itemId = typeof data?.item_id === "string" ? data.item_id : null;
  const b64 = typeof data?.partial_image_b64 === "string" ? data.partial_image_b64 : "";
  if (!itemId || !b64) return current;

  const output = Array.isArray(current?.output) ? [...current.output] : [];
  const index = output.findIndex((c) => c?.id === itemId);
  const base = index >= 0 ? output[index] : { id: itemId, type: "image_generation_call", status: "in_progress" };

  const merged = {
    ...base,
    type: "image_generation_call",
    result: b64,                                   // last partial wins
    output_format: data.output_format || base.output_format || "png",
    ...(data.background ? { background: data.background } : {}),
  };

  if (index >= 0) output[index] = merged;
  else output.push(merged);
  return { ...current, output };
}
```

Wire it in:

```ts
if (currentEvent === "response.image_generation_call.partial_image") {
  response = mergeImagePartial(response, data);
  continue;
}
```

This passes test 35 (`result === "abc123"`, `output_format === "png"`) and both smoke tests, because `extractGeneratedImage` (`codex-images.ts:73-92`) reads `item.result` off the `image_generation_call` output item.

### Edge cases to keep in mind (not covered by current tests, worth a guard)
1. **Arrival order**: handle `partial_image` arriving *before* `output_item.added` — the `findIndex` miss + `push` placeholder above covers it.
2. **Multiple partials**: `partial_image` streams progressively. Last-wins (overwrite `result`) is correct; do not append.
3. **`output_item.done` clobber risk**: if upstream sends `output_item.done` for the image item *without* a `result`, the current `mergeOutputItem` would replace the merged item and wipe the partial result. Real Codex usually includes the final `result` in `done`/`completed`, so this is rare. If you want to be safe, make `mergeOutputItem` preserve an existing `result` when the incoming image item lacks one. Optional; no test requires it today.

---

## Per-phase notes

- **Phase 0 (baseline):** fine. The baseline is already captured above; no need to redo.
- **Phase 1 (image partials):** correct goal. Execute as the targeted port described above, not a from-scratch design. Cite the `.bak` for field mapping. After the fix, delete or `.gitignore` the two `*.bak-pre-merge-2026-06-09` files (`codex-sse.ts.bak…`, `codex-chat.ts.bak…`) so they don't get committed.
- **Phase 2 (string `input`):** correct and needed. See Q2 for the exact shape. Keep it a pure normalization step; do not add `store` config here (see Q5).
- **Phase 3 (`/v1` JSON 404):** correct. Minor shape tweak in Q3. Mount the catch-all after all `/v1` routes and after the auth middleware (already the case).
- **Phase 4 (ops guide):** **low priority for personal use.** The guide is untracked (`?? docs/CCPA_OPERATIONS_GUIDE.md`) and the embedded key is not in git history, so there is no leak surface via push. Skip the redaction urgency. The genuinely useful part of Phase 4 is correcting the **stale technical claims** the plan lists (Codex status already in `/admin/accounts`; `--manual` login doesn't need a service stop; `CodexAuthStore` uses an mtime cache; no `nextRefreshAttemptAt` field). Do that part if/when the guide is actually consulted.
- **Phase 5 (cache-token observability):** good, low-risk, additive. Keep `/admin/usage/recent` shape backward-compatible as stated.
- **Phase 6 (reliability):** good ordering. Persisting cooldown/backoff state and a clear Codex-401 relogin hint are the high-value items. Moving `CLAUDE_MODELS` to config is nice-to-have.

---

## Answers to the plan's "Review Questions For Claude"

**Q1 — Is Phase 1's partial-image merge strategy correct for all observed SSE orders?**
Yes, with the three edge cases above. Key it by `item_id`, tolerate either arrival order, use last-partial-wins, and don't let a result-less `output_item.done` overwrite a merged result. The `.bak` solved order-independence with an end-of-stream Map; the targeted handler solves it by merging into the live `output` array — both are valid, the latter fits current code better.

**Q2 — String `input`: plain `{role, content}` or typed content parts?**
Plain `[{ role: "user", content: <string> }]`. The project's own working image path already builds exactly this (`codex-images.ts:64-71`) and the smoke test asserts it reaches upstream verbatim (`smoke.test.ts:463`). No evidence the Codex Responses upstream needs typed `input_text` parts. Don't over-build.

```ts
if (typeof normalized.input === "string") {
  normalized.input = [{ role: "user", content: normalized.input }];
}
```

For the Claude `/v1/responses` path, ensure the same string→user-message conversion so you never produce empty `messages`.

**Q3 — Is the `/v1` catch-all error shape close enough for the OpenAI SDK?**
Yes. The SDK only needs a JSON body it can parse with an `error.message`. Suggest `type: "invalid_request_error"` (OpenAI's real 404 convention) instead of `"not_found"`; keep HTTP 404. The `code: "endpoint_not_implemented"` is harmless and helpful.

**Q4 — Are the doc redactions too aggressive for a private guide?**
Moot for this deployment — treat redaction as optional. The file is local/untracked and the key isn't in history. If anything, the plan is slightly *over*-focused on secrets; redirect that phase's effort to fixing the stale technical claims, which are what will actually mislead a future reader.

**Q5 — Keep `store=false` hard, or make it config-driven in the Phase 2 pass?**
Keep it hard-coded `false` for now (`codex-request.ts:26`). Do **not** fold a `codex.store` config into Phase 2 — that phase's job is input normalization, and mixing concerns widens its blast radius. The plan already schedules config-driven `store` in Phase 6; leave it there.

---

## Recommended execution order

1. **Phase 1** via the targeted `mergeImagePartial` port → back to 60/60. (diff the `.bak` first.)
2. **Phase 3** (`/v1` JSON 404) — tiny, isolated, removes a real client-facing failure mode.
3. **Phase 2** (string `input` normalization) — small, with new tests for `input: "hi"` on both routes.
4. **Phase 5 / Phase 6** as capacity allows.
5. **Phase 4** only the "fix stale claims" part, on demand.

Run after each code phase:
```bash
npm run build && npx tsx --test tests/*.test.ts && git diff --check
```

---

## Appendix: exact failing tests

```
not ok 35 - collectCodexResponseFromSse keeps image generation partials as output items   (tests/codex-sse.test.ts:35)
not ok 47 - proxies OpenAI image generations through Codex image generation                (tests/smoke.test.ts:407)
not ok 48 - retries a transient Codex image generation network failure                     (tests/smoke.test.ts:471)
```

All three drive the sequence `output_item.added(image_generation_call, no result)` → `image_generation_call.partial_image(partial_image_b64)` → `completed(no/empty output)`, and assert the final image `result` / `b64_json` equals the partial bytes. The single `mergeImagePartial` handler satisfies all three.

Reference implementation to port from: `src/providers/codex-sse.ts.bak-pre-merge-2026-06-09:130-158`.
