# Usage Monitoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a lightweight in-memory usage monitoring API to auth2api so local operators can inspect provider health, per-model traffic, and recent requests.

**Architecture:** Introduce a process-local `UsageTracker` that collects request summaries at the HTTP routing layer. Wrap each routed handler in a monitoring adapter that captures endpoint, provider, model, status, latency, and usage tokens from JSON or SSE responses, then expose aggregated snapshots via `/admin/usage` and `/admin/usage/recent`.

**Tech Stack:** TypeScript, Express, existing Node test runner (`tsx --test`)

### Task 1: Define monitoring contract with failing integration test

**Files:**
- Create: `tests/admin-usage.test.ts`
- Reference: `src/server.ts`
- Reference: `tests/smoke.test.ts`

**Step 1: Write the failing test**

- Start a real test server with one Claude token and one Codex auth file.
- Mock one successful Claude request and one successful Codex request.
- Assert `GET /admin/usage` returns:
  - `totals.totalRequests === 2`
  - `providers.claude.totalRequests === 1`
  - `providers.codex.totalRequests === 1`
  - `models["claude-sonnet-4-6"].totalRequests === 1`
  - `models["gpt-5.4"].totalRequests === 1`
- Assert `GET /admin/usage/recent` returns two entries with endpoint/provider/model fields.

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: 404 for `/admin/usage` or assertion failure because tracking does not exist yet.

### Task 2: Add a minimal in-memory tracker

**Files:**
- Create: `src/monitoring/usage.ts`
- Test: `tests/admin-usage.test.ts`

**Step 1: Write the smallest implementation**

- Add `UsageRecord`
- Add `UsageTracker`
- Support:
  - `record(...)`
  - `snapshot()`
  - `recent(limit)`

**Step 2: Keep the first version small**

- Use in-memory arrays/maps
- Cap recent records to a reasonable size such as 200
- Aggregate:
  - totals
  - by provider
  - by endpoint
  - by model
  - total tokens

**Step 3: Run targeted tests**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: still failing, because routes are not wired yet.

### Task 3: Instrument routed handlers

**Files:**
- Modify: `src/server.ts`
- Possibly create: `src/monitoring/http-usage.ts`
- Reference: `src/proxy/handler.ts`
- Reference: `src/proxy/responses.ts`
- Reference: `src/proxy/passthrough.ts`
- Reference: `src/providers/codex-chat.ts`
- Reference: `src/providers/codex-responses.ts`

**Step 1: Add a routing-layer wrapper**

- Capture request start time
- Determine endpoint and provider
- Intercept `res.json(...)`
- Intercept `res.write(...)` for SSE
- On `finish`, record a single summary into `UsageTracker`

**Step 2: Extract usage safely**

- JSON responses:
  - OpenAI chat: `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`
  - OpenAI responses: `usage.input_tokens`, `usage.output_tokens`, `usage.total_tokens`
  - Claude native messages: `usage.input_tokens`, `usage.output_tokens`
- SSE responses:
  - Claude/OpenAI chat final usage chunk
  - OpenAI responses `response.completed`
  - Claude native `message_delta`

**Step 3: Register admin routes**

- `GET /admin/usage`
- `GET /admin/usage/recent`

### Task 4: Expand tests for failures and limits

**Files:**
- Modify: `tests/admin-usage.test.ts`

**Step 1: Add one failure case**

- Trigger one bad model or auth failure
- Assert failure count increases

**Step 2: Add recent list assertions**

- Verify newest-first ordering
- Verify `success`, `statusCode`, and `latencyMs` exist

### Task 5: Verify and document

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`

**Step 1: Add endpoint documentation**

- Mention `/admin/usage`
- Mention `/admin/usage/recent`
- Clarify first version is in-memory only

**Step 2: Run final verification**

Run:
- `npx tsx --test tests/admin-usage.test.ts`
- `npx tsx --test tests/*.test.ts`
- `npm run build`
- `git diff --check`

**Step 3: Optional local smoke**

- `curl /admin/usage`
- `curl /admin/usage/recent`
