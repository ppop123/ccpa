# Browser Monitor Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a browser-friendly monitoring dashboard for local operators without weakening the existing `/admin/*` API key protection.

**Architecture:** Expose a lightweight unauthenticated HTML shell at `GET /monitor`. The page contains inline CSS and JavaScript, prompts for an API key, then fetches `/admin/accounts`, `/admin/usage`, and `/admin/usage/recent` over same-origin requests with `Authorization: Bearer <key>`. The existing admin JSON endpoints and auth middleware remain unchanged.

**Tech Stack:** TypeScript, Express, inline HTML/CSS/JS, existing Node test runner (`tsx --test`)

### Task 1: Define the browser entry contract with a failing test

**Files:**
- Modify: `tests/admin-usage.test.ts`
- Reference: `src/server.ts`

**Step 1: Write the failing test**

- Assert `GET /monitor` works without an API key.
- Assert the response status is `200`.
- Assert the response `Content-Type` includes `text/html`.
- Assert the HTML includes:
  - a page title such as `ccpa Monitor`
  - references to `/admin/accounts`
  - references to `/admin/usage`
  - references to `/admin/usage/recent`
  - an API key input control

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: 404 or HTML assertions fail because `/monitor` does not exist yet.

### Task 2: Add the minimal dashboard renderer

**Files:**
- Create: `src/monitoring/dashboard-page.ts`
- Modify: `src/server.ts`

**Step 1: Add a pure renderer**

- Export a `renderMonitorPage()` function returning a complete HTML document.
- Keep it dependency-free.
- Use inline CSS for cards, tables, status pills, and monospace blocks.

**Step 2: Keep the first version small**

- API key input with optional persistence in `localStorage`
- Refresh button
- Auto-refresh timer
- Three sections:
  - provider/account status
  - totals and aggregates
  - recent requests table

**Step 3: Register the route**

- Add `GET /monitor`
- Return the HTML shell with `res.type("html").send(...)`
- Do not add this route under `/admin`

### Task 3: Verify the data flow stays secure

**Files:**
- Modify: `tests/admin-usage.test.ts`
- Modify: `src/monitoring/dashboard-page.ts` if needed

**Step 1: Add one safety assertion**

- Ensure the rendered page does not embed configured API keys server-side.

**Step 2: Run targeted tests**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: pass.

### Task 4: Document browser usage

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`

**Step 1: Add a short browser monitoring section**

- Mention `http://127.0.0.1:8317/monitor`
- Explain the page still needs an API key to load live data
- Clarify that existing `/admin/*` routes remain protected

### Task 5: Final verification

**Files:**
- No new files expected

**Step 1: Run final verification**

Run:
- `npx tsx --test tests/admin-usage.test.ts`
- `npm run build`
- `git diff --check`

**Step 2: Manual smoke expectations**

- Open `/monitor`
- Paste API key
- See accounts, totals, and recent requests update without page reload
