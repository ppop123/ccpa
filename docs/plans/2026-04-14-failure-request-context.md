# Failure Request Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为失败请求补充可调试、已脱敏的上下文摘要，并通过现有 recent 监控接口与页面暴露。

**Architecture:** 在 `wrapTrackedHandler` 统一汇总 request summary，并允许具体 handler 通过 `res.locals` 写入 failure metadata。`UsageTracker` 保存新的可选 `failureContext` 字段，`/admin/usage/recent` 原样返回，浏览器页在失败行展示摘要。

**Tech Stack:** Node.js, Express, TypeScript, node:test

### Task 1: Define the data contract

**Files:**
- Modify: `src/monitoring/usage.ts`
- Modify: `src/monitoring/http-usage.ts`
- Test: `tests/admin-usage.test.ts`

**Step 1: Write the failing test**
- 为 recent 失败记录断言新增 `failureContext`，至少覆盖：
  - `stage`
  - `kind`
  - `message`
  - `requestSummary`

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: recent item 缺少 `failureContext`

**Step 3: Write minimal implementation**
- 在 `UsageRecord` 中增加可选 `failureContext`
- 在 `wrapTrackedHandler` 增加请求摘要与 `res.locals` 读取逻辑

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: PASS

### Task 2: Populate failure context from handlers

**Files:**
- Modify: `src/server.ts`
- Modify: `src/proxy/handler.ts`
- Modify: `src/proxy/responses.ts`
- Modify: `src/proxy/passthrough.ts`
- Modify: `src/providers/codex-chat.ts`
- Modify: `src/providers/codex-responses.ts`
- Test: `tests/admin-usage.test.ts`

**Step 1: Write the failing test**
- 增加上游失败或 cooldown 失败场景，断言 recent 失败记录能区分：
  - 本地 routing/validation failure
  - upstream/cooldown/network failure

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: failureContext 缺少 handler-specific 信息

**Step 3: Write minimal implementation**
- 在各失败分支设置统一结构的 failure metadata

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: PASS

### Task 3: Expose in monitor page

**Files:**
- Modify: `src/monitoring/dashboard-page.ts`
- Test: `tests/admin-usage.test.ts`

**Step 1: Write the failing test**
- 为 `/monitor` HTML 断言 recent 失败上下文字段有展示入口或标识

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: FAIL

**Step 3: Write minimal implementation**
- 只在失败行展示简短 failure context，不展示敏感正文

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: PASS

### Task 4: Final verification

**Files:**
- Modify: `progress.md`

**Step 1: Run targeted tests**

Run: `npx tsx --test tests/admin-usage.test.ts`

Expected: PASS

**Step 2: Run full tests**

Run: `npx tsx --test tests/*.test.ts`

Expected: PASS

**Step 3: Run build**

Run: `npm run build`

Expected: PASS

**Step 4: Check formatting**

Run: `git diff --check`

Expected: PASS
