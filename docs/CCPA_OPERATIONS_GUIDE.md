# CCPA Operations Guide

> CCPA = auth2api 1.1.0 本地分支，把 Claude Code + Codex 订阅打包成 OpenAI 兼容本地 endpoint。
> 这份文档让接手者一开就能用，并知道为什么这么改、哪些坑、回滚怎么做。

**版本**：2026-06-09 状态快照；2026-06-22 本机 + 50.9 运维状态校订
**部署位置**：本机 `~/auth2api/` (port 8317) + 50.9 `~/ccpa/` (port 8317)
**两边代码**：2026-06-09 成文时 4 个关键源文件 md5 完全一致（translator / manager / codex-chat / codex-sse）。2026-06-22 本机稳定分支已推进到 `codex/ccpa-stabilization`；50.9 live 仍运行 `/Users/wangyan/ccpa` dirty tree，最新候选已在独立 clean worktree 验证，切换 live 需单独确认。

## 0. 当前状态覆盖说明（2026-06-22）

这份手册最早是 2026-06-09 的大快照，后续本机 repo 和 50.9 部署已完成多轮稳定性修复。下面这些结论覆盖正文和附录里仍保留的旧评审口径：

- `/v1/responses` 已支持 OpenAI 标准的 string `input`，会在 Codex/Claude 路径规范化成 user message；客户端不再需要自己包数组。
- `/v1/embeddings` 仍未实现，但已不再返回 Express HTML；已鉴权请求返回 OpenAI-style JSON 404，`error.code=endpoint_not_implemented`。
- `/health` 现在返回非敏感 runtime identity：`status`、`service`、`version`、`started_at`、`uptime_ms`；`npm run build` 生成 `dist/build-info.json` 后，还会带 `build.git_commit` 等构建元数据。
- `/admin/accounts` 现在包含 `server` provider readiness 摘要，以及 `claude` / `codex` 两个 provider 状态；`accounts` 数组仍只表示 Claude OAuth 账号列表。
- prompt cache usage 已进入 `/admin/usage`、`/admin/usage/recent` 和 `/monitor` 聚合展示。
- `/tmp/ccpa.stdout.log`、`/tmp/ccpa.stderr.log`、`/tmp/ccpa-healthcheck.log` 已有 repo 管理的维护脚本和 healthcheck opt-in；本机 `/Users/wy/ccpa-healthcheck.sh` 与 50.9 `/Users/wangyan/ccpa-healthcheck.sh` 都已替换为仓库 wrapper。
- cloaking billing build hash 已稳定为配置项/默认值，不再每次请求随机；`cch` 仍随 payload 变化。
- rate-limit 默认关闭是自用内网部署的有意默认。若暴露到公网或多客户端环境，应在 `config.yaml` 显式开启。
- 50.9 live 在 2026-06-22 已重新完成 CCPA Claude OAuth 登录，当前 strict canary provider readiness 为 `ok`：Claude 与 Codex 两个 provider 都可用；`/v1/models` 当前 13 个模型，外部 healthcheck wrapper 已安装并可在非登录 PATH 下直接运行。但 live tree 仍是 dirty `main`，不是最新 `codex/ccpa-stabilization` clean candidate。
- canary/preflight/strict release gate 现在会在 provider degraded 时打印 `provider_hint`，例如 Claude 过期会直接提示 `node dist/index.js --config=... --login --manual`，而不是只给 generic degraded 错误。
- canary 支持 `--require-build-commit <sha>`，可用 `/health.build.git_commit` 证明 live runtime 是否真的跑某个候选提交，避免只靠 dist mtime 判断。
- 50.9 的 `codex.models` 已补齐 `gpt-image-2`，避免 Images API contract 在路由层先报 `unsupported_model`。
- 依赖安全已完成 Phase 157 收敛：本机和 50.9 的 `npm audit --json` 均为 0 vulnerabilities；运行时代码已移除 `uuid` 依赖，改用 Node 内置 `crypto.randomUUID()`。
- Phase 158 修复了过期 Claude token 的健康误报：过期 token 不再进入上游请求，Claude chat/responses/messages/count_tokens 会返回 OpenAI-style `account_token_expired`，`/admin/accounts` 会把该 provider 标为 unavailable。
- `release:readiness` 现在可以用 `--write-json PATH` 写出 handoff manifest；JSON 包含生成时间、repo/status 来源、review 命令和需要显式确认才会花额度的 upstream matrix 命令。
- Phase 164 修复了 Claude SSE 正常跨 chunk 时被误判为失败的问题：`message_stop` 的 `event:` 与 `data:` 分到不同 read chunk 时，chat 仍会输出 `[DONE]`，responses 仍会输出 `response.completed`。同时启动日志不再打印 authenticated proxy 的 userinfo。
- Phase 171 起 `npm run release:verify` 默认包含 `npm run test:unit`，会在 smoke/ops 之前覆盖 provider/runtime 单元测试，避免模型路由、auth retry、Responses 兼容等回归只能靠手工全量测试发现。
- Phase 172 起 `npm run release:verify` 默认包含 `npm run typecheck`，使用 `tsc --noEmit` 做只读 TypeScript 编译检查；这补上 `tsx --test` 运行测试不等价于 `tsc` 的发布门禁缺口。
- Phase 173 起 `npm run release:verify` 默认包含 `npm run secrets:scan`，会扫描面向发布的 docs/scripts/src/project config，并默认排除 `tests/`、`config.yaml`、`dist/` 和本机 auth 目录，防止 handoff 文档或脚本再次带出真实 API key / OAuth token。
- Phase 174 起 `npm run secrets:scan` 还会纳入 `git status` 中可见的候选文件；根目录 handoff 副本或 `other` bucket 文件也会被扫到，同时继续跳过 `tests/` 与私有运行配置。
- Phase 175 起 `npm run release:verify` 默认包含 `npm run security:audit`，使用 `npm audit --audit-level=moderate`，让中危及以上依赖公告在发布门禁里失败，而不是依赖手工记忆。
- Phase 176 起 `npm run release:verify` 默认包含 `npm run upstream:matrix` dry-run，持续校验真实上游验收入口和计划矩阵，但仍保持 `quota_spending: no`；只有显式 `--apply` 才会花 Claude/Codex 额度。
- Phase 177 起 `npm run release:verify` 默认包含 `npm run security:posture`，会阻断缺失、占位或弱客户端 API key；对 `host: 0.0.0.0` 且 `rate-limit.enabled: false` 的内网自用形态只告警不阻断。

当前最可信的发布前门禁：

```bash
npm run release:verify
npm run release:readiness -- --list
npm run release:readiness -- --write-json /tmp/ccpa-release-readiness.json
npm run secrets:scan          # 只读 secret 扫描；覆盖 git candidates，不扫 tests/config.yaml
npm run security:posture      # 只读配置姿态检查；强 API key 为硬门槛，内网无本地限流为 warning
npm run security:audit         # npm audit --audit-level=moderate
npm run upstream:matrix        # 默认 dry-run，不花上游额度；release:verify 也会跑
npm run typecheck              # TypeScript no-emit 编译检查，不写 dist
npm run test:unit              # provider/runtime 单元测试，不触发真实生成上游
npm run test:ops               # 运维脚本行为测试，不触发真实生成上游
npm run rollout:preflight
```

`npm run release:verify` 默认要求 provider readiness 达到 `degraded`（至少 Claude/Codex 一个可用）。如果这次验收必须证明 Claude 和 Codex 都可用，使用：

```bash
npm run release:verify -- --require-provider-status ok
```

当前本机和 50.9 的 strict 模式均通过；如果未来 50.9 Claude token 再次过期，strict gate 会失败并打印 `provider_hint` 指向 `node dist/index.js --config=... --login --manual`。

`npm run upstream:matrix -- --apply` 会真实请求本机 CCPA 并消耗 Claude/Codex 订阅额度；只有明确需要真上游验收时再跑。

50.9 本轮回滚点：

- 整体备份：`/Users/wangyan/ccpa-backups/pre-phase156-20260620211351.tgz`
- 配置备份：`/Users/wangyan/ccpa/config.yaml.bak-pre-phase156-gpt-image-2-20260620211506`
- 依赖安全收敛前备份：`/Users/wangyan/ccpa-backups/pre-phase157-20260620212059.tgz`
- 过期 token 可用性修复前备份：`/Users/wangyan/ccpa-backups/pre-phase158-expired-token-availability-20260620212759.tgz`
- live rollout / external healthcheck 修复前备份：`/Users/wangyan/ccpa-backups/pre-phase160-live-rollout-healthcheck-20260620214504.tgz`
- 旧外部 wrapper 备份：`/Users/wangyan/ccpa-healthcheck.sh.bak-pre-repo-healthcheck-20260620134830`
- provider recovery hints 修复前备份：`/Users/wangyan/ccpa-backups/pre-phase161-canary-provider-hints-20260620215442.tgz`
- release handoff manifest 修复前备份：`/Users/wangyan/ccpa-backups/pre-phase163-release-handoff-manifest-20260620221000.tgz`
- streaming chunk / proxy log redaction 修复前备份：`/Users/wangyan/ccpa-backups/pre-phase164-streaming-proxy-redaction-20260620223803.tgz`

## 目录

0. [当前状态覆盖说明（2026-06-20）](#0-当前状态覆盖说明2026-06-20)
1. [总览与架构拓扑](#1-总览与架构拓扑)
2. [部署清单（本机 + 50.9）](#2-部署清单本机--509)
3. [端点参考](#3-端点参考)
4. [模型矩阵与路由](#4-模型矩阵与路由)
5. [业务集成范例](#5-业务集成范例)
6. [运维 Runbook](#6-运维-runbook)
7. [更新日志与备份清单](#7-更新日志与备份清单)
8. [已知问题与未来工作](#8-已知问题与未来工作)
9. [附录：文档校对备忘 — 待补 / 待修](#9-附录文档校对备忘--待补--待修)

---
## 1. 总览与架构拓扑

### 它是什么

CCPA 是 auth2api 1.1.0 的本地分支，一个跑在 127.0.0.1:8317 的 OpenAI 兼容 HTTP endpoint。它把两件事拼到一个进程里：

1. **Claude Code 订阅** — 拿 OAuth access token 直连 `api.anthropic.com/v1/messages`，让你订阅价就能跑 claude-opus-4-8 / sonnet-4-6 / haiku-4-5。
2. **OpenAI Codex 订阅** — 复用 `~/.codex/auth.json` 直连 `chatgpt.com/backend-api/codex/responses`，跑 gpt-5.4 / gpt-5.5 / gpt-image-2。

业务侧只用 OpenAI SDK + `base_url=http://127.0.0.1:8317`，按 model 字段前缀（`claude-*` vs `gpt-*`/`codex-*`/`o\d`）自动选 provider，对调用方完全无感。跟 LiteLLM/OpenRouter 这类通用 proxy 的区别：CCPA 不用 API key 计费，纯走订阅的 OAuth token + Stainless headers 伪装成 Claude Code CLI/Codex CLI；payload 上还要走 cloaking（billingHeader 注入、敏感词替换、system prompt 加 `cache_control: ephemeral`），普通 proxy 没有这层。

当前用户：本机老登写作 / 老外看中国管线 / 选题候选生成、50.9 上的 podcast pipeline。业务全部已切 thu 主线（clade_safe_thu.py），CCPA 当兜底；恢复 health 后可切回。

### 请求生命周期

一个 `POST /v1/chat/completions` 进来的完整路径：

```
Client (OpenAI SDK)
   │  Authorization: Bearer sk-XXX | x-api-key
   ▼
Express app  (src/index.ts:8 ProxyAgent → setGlobalDispatcher)
   ├─ express.json({limit})           server.ts:138
   ├─ CORS (localhost only)           server.ts:154-167
   ├─ rateLimit (disabled default)    server.ts:169-171
   ├─ requireApiKey                   server.ts:175-188
   ▼
routeByModel (wrapTrackedHandler)     server.ts:70-136
   │  resolveProviderFromModel(body.model)
   │  prefix "claude-" → claude       providers/router.ts:16
   │  prefix "gpt-"/"codex-"/"o\d" → codex   router.ts:20-26
   ▼
ClaudeProvider.handleChatCompletions  providers/claude.ts:32
   = createChatCompletionsHandler(config, manager)   proxy/handler.ts:21
   │
   ├─ openaiToClaude(body)             translator.ts (OpenAI body → Anthropic shape)
   ├─ applyCloaking(claudeBody, ...)   cloaking.ts (billingHeader / agentBlock / cache_control)
   ├─ manager.getNextAccount()         accounts/manager.ts (Claude account pool，带 cooldown / backoff)
   ▼
callClaudeAPI(token, body, stream)    proxy/claude-api.ts:53
   │  POST https://api.anthropic.com/v1/messages?beta=true
   │  headers: Authorization Bearer + Anthropic-Beta (claude-code/oauth/caching)
   │           + X-App: cli + User-Agent claude-cli/2.1.63 + X-Stainless-*
   │  fetch() → undici ProxyAgent (HTTPS_PROXY=http://127.0.0.1:6152)
   ▼
api.anthropic.com  ←→ Surge 6152 ←→ ProxyAgent
   ▼
Response
   ├─ ok + stream: handleStreamingResponse (proxy/streaming.ts) 边收边吐 SSE
   ├─ ok + nostream: claudeToOpenai(resp, model)  (translator.ts)
   ├─ 401: manager.refreshAccount() 走 PKCE refresh，attempt-- 重跑
   ├─ 429/5xx: classifyFailure + 退避后 retry（MAX_RETRIES=3）
   └─ 400: 直接吐回客户端
   ▼
res.json(openaiResp)   ←  请求结束
```

codex 路径同构但更简单：`CodexProvider.handleChatCompletions` → `providers/codex-chat.ts` 做 chat→Responses 转换 → `providers/codex-upstream.ts:13 callCodexResponses` → `chatgpt.com/backend-api/codex/responses`。codex 不走 cloaking（没账户切换、没 OAuth refresh），上游 401 直接抛出依赖 codex CLI 续期（已知 P3 issue）。

`/v1/messages`、`/v1/messages/count_tokens` 是 Anthropic native 直 passthrough，不经 translator，由 `proxy/passthrough.ts` 处理。

### 模块分层

```
src/
├─ index.ts            进程入口，--login flow，ProxyAgent 装载
├─ startup.ts          startup pre-check (canStartServer)
├─ server.ts           Express app 装配 + 中间件 + 端点注册 (293 行)
├─ config.ts           yaml 加载 + DEFAULT_CONFIG
├─ api-key.ts          Bearer / x-api-key 双格式解析
│
├─ providers/          model-prefix 路由 → 选哪个上游
│   ├─ router.ts       resolveProviderFromModel (29 行，前缀匹配)
│   ├─ types.ts        Provider/ProviderModel 接口
│   ├─ claude.ts       ClaudeProvider + CLAUDE_MODELS 8 alias hardcode
│   ├─ codex.ts        CodexProvider 入口类
│   ├─ codex-chat.ts   chat completions ↔ Responses API 转译 (~550 行)
│   ├─ codex-sse.ts    Responses SSE 流，mergeOutputItem 通用处理
│   ├─ codex-request.ts  normalize role + 强制 store=false
│   ├─ codex-responses.ts  /v1/responses 端点
│   ├─ codex-images.ts     /v1/images/generations 端点
│   ├─ codex-upstream.ts   fetch chatgpt.com (2 attempts)
│   └─ codex-auth.ts       CodexAuthStore (~/.codex/auth.json)
│
├─ proxy/              claude 路径：translator / cloaking / fetch
│   ├─ handler.ts      chat completions 主 handler，3 retry + 401 refresh
│   ├─ translator.ts   OpenAI ↔ Anthropic 双向转译 + usage 字段
│   ├─ cloaking.ts     billingHeader / agentBlock / system cache_control
│   ├─ cloak-utils.ts  hash / 敏感词替换工具
│   ├─ claude-api.ts   fetch api.anthropic.com，Stainless headers (86 行)
│   ├─ streaming.ts    Anthropic SSE → OpenAI chunks 转译
│   ├─ responses.ts    claude 的 /v1/responses 端点 (624 行)
│   └─ passthrough.ts  /v1/messages 直透 (~330 行)
│
├─ auth/               OAuth + token storage
│   ├─ oauth.ts        PKCE flow + refresh，TOKEN_URL=api.anthropic.com/v1/oauth/token
│   ├─ token-storage.ts  ~/.auth2api/claude-<email>.json 读写
│   ├─ pkce.ts         code_verifier / challenge 生成
│   ├─ callback-server.ts  oauth callback @127.0.0.1:54545
│   ├─ codex-login.ts  codex CLI login flow
│   └─ types.ts
│
├─ accounts/
│   └─ manager.ts      Claude account pool state + cooldown + refresh backoff
│
└─ monitoring/         dashboard + usage 聚合
    ├─ dashboard-page.ts  /monitor HTML (810 行)
    ├─ http-usage.ts      请求级 usage tracking + failure context (330 行)
    └─ usage.ts           跨请求聚合 (167 行)
```

### 关键设计抉择

**Router 用前缀字符串而非 capabilities/registry**
`router.ts:3-4` 三行常量 `CLAUDE_PREFIXES = ["claude-"]` / `CODEX_PREFIXES = ["gpt-", "codex-"]` 加一条 `/^o\d/` 正则就完事。代价是加新厂商要改代码，收益是新 model 出来（claude-opus-4-9 / gpt-5.6）零改动自动路由，业务方在 model 字段写啥都行。alias `opus`/`sonnet`/`haiku` 走 `ClaudeProvider.supportsModel` 兜底（server.ts:118）。

**简单账号池，不做并发放大**
`accounts/manager.ts` 会加载 `auth-dir` 下多个 `claude-*.json` token，按稳定文件名顺序选择第一个可用账号；过期或 cooldown 中的账号会被跳过。它不是加权调度或并发放大器，重点是避免旧 token 文件让服务启动失败，并为手工备用账号提供平滑切换。冷却走 cooldown timer + retry-after 退避；refresh 失败有指数 backoff 60s→30min，避免 401 风暴打爆 OAuth endpoint。

**Cloaking 是必需层不是可选**
`proxy/cloaking.ts` 注入 billingHeader / agentBlock / `cache_control: ephemeral` 让上游看起来像 Claude Code CLI 在跑，否则 Anthropic 会基于 user-agent + body shape 识别非官方客户端。`claude-api.ts:22-50` 配合伪 Stainless headers (`X-Stainless-Runtime=node`, `User-Agent=claude-cli/2.1.63`)。这层关掉立即 401/403。

**编译产物 `dist/` 而非 ts-node runtime**
plist `ProgramArguments` 直接 `node dist/index.js`，避免开机时 ts-node 冷启动 +2s 和编译错误炸进 launchd。改源码必须 `npm run build` 才生效。备份命名约定 `<file>.bak-pre-<reason>-<date>` 让回滚不靠 git（这台机器 auth2api 不是 git repo）。

**HTTPS_PROXY 走环境变量而非 config.yaml**
`index.ts:6-8` 读 `process.env.HTTPS_PROXY` 装 ProxyAgent。原因：proxy 端口（Surge 的 6152）会跟着客户端配置变，不要污染 config.yaml；同时 NO_PROXY=localhost 确保 callback-server 不绕回去。改 proxy 端口只改 plist，不重新 build。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
find /Users/wy/auth2api/src -type f -name '*.ts' | head -40
grep -nE 'app\.(get|post|use)' /Users/wy/auth2api/src/server.ts | head -30
ls /Users/wy/auth2api/src/
wc -l /Users/wy/auth2api/src/server.ts /Users/wy/auth2api/src/proxy/handler.ts /Users/wy/auth2api/src/proxy/translator.ts /Users/wy/auth2api/src/providers/router.ts
ls /Users/wy/auth2api/dist/
grep -n 'ProxyAgent\|HTTPS_PROXY\|undici' /Users/wy/auth2api/src/index.ts
curl -s http://127.0.0.1:8317/health
```

</details>

---

## 2. 部署清单（本机 + 50.9）

CCPA 在两台机器上运行同源代码，但用户、路径、node 路径、代理配置都不同。下面给你两边的全部路径事实，再用对比表把差异一次说清。

### 本机（wy@localhost）

项目目录 `/Users/wy/auth2api/`，git remote `ccpa` 指向 `https://github.com/ppop123/ccpa.git`（origin 是 fork 上游 AmazingAng/auth2api，平时不推），当前 HEAD `7915477 feat: add browser monitor dashboard`，工作区有大量 modified（src/proxy/*、src/providers/*、src/accounts/manager.ts 等，今天还没 commit）。

LaunchAgent plist `~/Library/LaunchAgents/com.wy.ccpa.plist`（label `com.wy.ccpa`），实际启动的命令：

```bash
/Users/wy/.nvm/versions/node/v22.14.0/bin/node \
  /Users/wy/auth2api/dist/index.js \
  --config=/Users/wy/auth2api/config.yaml
```

WorkingDirectory `/Users/wy/auth2api`，KeepAlive + RunAtLoad 都开。EnvironmentVariables：

| key | value |
| --- | --- |
| HOME | `/Users/wy` |
| PATH | `/Users/wy/.nvm/versions/node/v22.14.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` |
| HTTPS_PROXY | `http://127.0.0.1:6152` |
| HTTP_PROXY | `http://127.0.0.1:6152` |
| NO_PROXY | `localhost,127.0.0.1,::1,.local` |

`6152` 是 Surge 本机的 HTTP 代理端口（今天才从误写的 `8234` 改回来），CCPA 启动时 `src/index.ts` 会读 `HTTPS_PROXY` 然后自动挂 `ProxyAgent`，让所有出站 fetch 走 Surge。`launchctl print gui/503/com.wy.ccpa` 状态 `running`，`runs = 7`，监听通过 `lsof` 确认（PID 39642、TCP `*:8317 LISTEN`）。

Token 文件 `~/.auth2api/claude-<account>.json`（mode 0600，约 400 bytes）：

```json
{
  "access_token": "<redacted>",
  "refresh_token": "<redacted>",
  "last_refresh": "2026-06-09T03:36:15.044Z",
  "email": "<account>",
  "type": "claude",
  "expired": "2026-06-09T11:36:15.042Z"
}
```

字段映射在 `src/auth/token-storage.ts:5-15`：`tokenToStorage` 把内存 `TokenData{accessToken,refreshToken,email,expiresAt}` 映射成磁盘 `TokenStorage{access_token,refresh_token,last_refresh,email,type,expired}`，写盘前 `data.email` 会做 `[^a-zA-Z0-9@._-]` 过滤生成文件名。`storageToToken` 反向加载时丢掉 `last_refresh` 和 `type`。

Codex token `~/.codex/auth.json`（4.6K），结构 `{auth_mode, OPENAI_API_KEY, tokens:{id_token,access_token,refresh_token,account_id}, last_refresh}` —— 由 codex CLI 自己维护，CCPA 在 `src/providers/codex-auth.ts` 只读不写；上游 401 时会让本地 auth cache 失效并重读 `auth.json` 重试一次，最终仍依赖 codex CLI 或用户登录态能刷新该文件。

日志 `/tmp/ccpa.stdout.log`、`/tmp/ccpa.stderr.log`。2026-06-09 快照里还没有 rotate；当前 repo 已提供 `scripts/ccpa-log-maintenance.sh`，healthcheck 可通过 `CCPA_HEALTHCHECK_MAINTAIN_LOGS=true` 在 canary 前维护并脱敏轮转。历史 stderr 里的 oauth refresh failure 噪音不代表当前代码仍会无限刷屏。

健康检查：

```bash
curl -sS http://127.0.0.1:8317/health
# {"status":"ok","service":"auth2api","version":"...","started_at":"...","uptime_ms":...}
```

### 50.9（wangyan@192.168.50.9，Mac mini）

项目目录 `/Users/wangyan/ccpa/`（注意是 `ccpa/` 不是 `auth2api/`），git remote 单一 `origin https://github.com/ppop123/ccpa`，当前 HEAD `b177ccf chore: prepare v1.1.1 release`。dist 已构建（`~/ccpa/dist/index.js` mtime `Jun 9 14:58` 跟本机同步过）。

LaunchAgent `~/Library/LaunchAgents/com.wangyan.ccpa.plist`（label `com.wangyan.ccpa`，1148 bytes，3 月底就稳定了），启动命令：

```bash
/opt/homebrew/bin/node \
  /Users/wangyan/ccpa/dist/index.js \
  --config=/Users/wangyan/ccpa/config.yaml
```

EnvironmentVariables 只有 `HOME=/Users/wangyan` 和 `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`，**没有 HTTPS_PROXY**（50.9 直连或 Surge 透明代理覆盖，不靠环境变量）。WorkingDirectory `/Users/wangyan/ccpa`，KeepAlive + RunAtLoad + `ThrottleInterval=5` + `Umask=63`（八进制 077）。`launchctl print gui/501/com.wangyan.ccpa` 状态 `running`、`runs=3`、PID 11734。

日志单独放项目内 `~/ccpa/logs/launchd.{stdout,stderr}.log`（本机是 `/tmp/`）。2026-06-20 同步后，repo 内已有 `scripts/ccpa-log-maintenance.sh`；手动 healthcheck/rollout 可通过 `CCPA_HEALTHCHECK_MAINTAIN_LOGS=true` 顺手维护这些日志。

Token 文件 `~/.auth2api/claude-<account>.json`（两台机器可以登同一个 Claude 订阅；mode 0600，约 400 bytes）。Codex auth `~/.codex/auth.json` 由 50.9 本地的 codex CLI 维护。

`config.yaml` 关键字段：`host: 0.0.0.0`（注意是 `0.0.0.0` 不是 `127.0.0.1`，所以局域网可达）、`port: 8317`、`api-keys: sk-XXX`（跟本机不同 key，单独发给业务方）、`codex.enabled: true`、`codex.models: [gpt-5.4, gpt-5.5, gpt-5.4-mini, gpt-5.2, gpt-image-2]`。

下游调用方：菲姐 OpenClaw（50.9 本地 gateway 当兜底，主线 thu）、加贺 / 浪矢 / 汤川等 agent（写作 + 选题 + deck 填充）、podcast pipeline（`~/podcast-pipeline/`）、老外看中国（`/Volumes/data/laowai/`）—— 局域网内业务都指 `http://192.168.50.9:8317`。

健康检查：

```bash
ssh wangyan@192.168.50.9 'curl -sS http://127.0.0.1:8317/health'
# {"status":"ok","service":"auth2api","version":"1.1.0","started_at":"...","uptime_ms":...}
```

### 对比表

| 维度 | 本机 (wy) | 50.9 (wangyan) |
| --- | --- | --- |
| 用户 / uid | `wy` / 503 | `wangyan` / 501 |
| 项目目录 | `~/auth2api/` | `~/ccpa/` |
| Git remote | `ccpa` + `fork` + `origin` 三个 | 单 `origin = ppop123/ccpa` |
| 当前 commit | `7915477`（含未 commit 改动） | `b177ccf v1.1.1 release` |
| Node 路径 | `~/.nvm/versions/node/v22.14.0/bin/node` | `/opt/homebrew/bin/node` |
| Plist label | `com.wy.ccpa` | `com.wangyan.ccpa` |
| HTTPS_PROXY | `http://127.0.0.1:6152`（Surge） | 不设（直连 / 透明代理） |
| `config.host` | `0.0.0.0` | `0.0.0.0` |
| Port | 8317 | 8317（局域网可达） |
| api-key | `sk-XXX` | `sk-REMOTE-XXX` |
| Log 路径 | `/tmp/ccpa.{stdout,stderr}.log` | `~/ccpa/logs/launchd.{stdout,stderr}.log` |
| Token 文件 | `~/.auth2api/claude-<account>.json` | 两边可登同一 Claude 订阅 |
| Codex auth | `~/.codex/auth.json`（本机 codex CLI） | `~/.codex/auth.json`（50.9 codex CLI） |
| 主要调用方 | 本机业务脚本（兜底） | 菲姐 OpenClaw、加贺 / 浪矢 / 汤川 agent、podcast、老外看中国 |
| 连通性 | `http://127.0.0.1:8317` | `http://192.168.50.9:8317`（局域网内） |

两边 token 文件可以用同一个 Claude 账号：业务上是同一订阅、各自跑 refresh、互不知道对方。如果一边把 refresh_token 用废了（Anthropic 旋转 refresh_token），另一边下次 refresh 也会跟着挂 —— 排查时先看 `last_refresh` 和 `expired` 字段对齐情况。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
stat -f '%Sm %N' /Users/wy/auth2api/dist/index.js
cat /Users/wy/Library/LaunchAgents/com.wy.ccpa.plist
launchctl print gui/$(id -u)/com.wy.ccpa | head -40
lsof -iTCP:8317 -sTCP:LISTEN
find /Users/wy/.auth2api -maxdepth 1 -name 'claude-*.json' -print | wc -l
ls -la /Users/wy/.codex/auth.json
cd /Users/wy/auth2api && git log -1 --format='%H %h %s'
cd /Users/wy/auth2api && git remote -v
python3 -c 'import glob,json; [print("claude token", json.load(open(p)).get("expired"), json.load(open(p)).get("last_refresh")) for p in glob.glob("/Users/wy/.auth2api/claude-*.json")]'
curl -sS http://127.0.0.1:8317/health
ssh wangyan@192.168.50.9 'ls ~/ccpa/dist/ | head'
ssh wangyan@192.168.50.9 'ls -la ~/ccpa/dist/index.js'
ssh wangyan@192.168.50.9 'find ~/.auth2api -maxdepth 1 -name "claude-*.json" -print | wc -l'
ssh wangyan@192.168.50.9 'cat ~/Library/LaunchAgents/com.wangyan.ccpa.plist'
ssh wangyan@192.168.50.9 'lsof -iTCP:8317 -sTCP:LISTEN'
ssh wangyan@192.168.50.9 'launchctl print gui/$(id -u)/com.wangyan.ccpa | head -40'
ssh wangyan@192.168.50.9 'cd ~/ccpa && git log -1 --format="%H %h %s" && git remote -v'
ssh wangyan@192.168.50.9 'cat ~/ccpa/config.yaml | head -20'
ssh wangyan@192.168.50.9 'curl -sS http://127.0.0.1:8317/health'
ssh wangyan@192.168.50.9 'ls -la ~/ccpa/logs/'
tail -5 /tmp/ccpa.stderr.log
```

</details>

---

## 3. 端点参考

CCPA 在 `127.0.0.1:8317` 暴露 9 个公开端点 + 3 个 `/admin` 端点。下面是逐个清单：方法、认证、关键 body 字段、响应形状、可粘 curl，以及踩过的坑。

### 鉴权速记

所有 `/v1/*` 和 `/admin/*` 路径走 `requireApiKey` 中间件（`src/server.ts:175-187`），接受两种 header：

```
Authorization: Bearer sk-...
x-api-key: sk-...
```

`extractApiKey` 先看 `Authorization: Bearer`，再 fallback 到 `x-api-key`（`src/api-key.ts:1-18`）。两种都给 Claude Code 客户端和 OpenAI SDK 用同一份 api-key 走通。`/health` 和 `/monitor` 不要 key（`src/server.ts:189-190` 注册顺序）。

下文 curl 示例统一用占位 `sk-XXX`。本机真实 key 从 `config.yaml` 的 `api-keys[]` 读取，不写进文档。

---

### POST /v1/chat/completions

OpenAI ChatCompletion 兼容，按 `model` 前缀路由到 claude（`claude-*`）或 codex（`gpt-*` / `codex-*` / `o\d`），见 `src/providers/router.ts:6-29` 和 `src/server.ts:193-200`。

**Body 关键字段**：`model`（必填，否则默认 `claude-sonnet-4-6`，见 `handler.ts:36`）、`messages[]`（必填，否则 400）、`stream`（bool）、`tools[]`、`tool_choice`、`max_tokens`、`temperature`、`top_p`、`stop`。

**响应**：OpenAI ChatCompletion 形状 — `{id, object: "chat.completion", choices: [{message: {role, content}, finish_reason}], usage: {prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: {cached_tokens}}}`。`prompt_tokens_details.cached_tokens` 是 2026-06-09 新加的，从 Claude 的 `cache_read_input_tokens` 提取（`src/proxy/translator.ts`）。

```bash
curl -sS -X POST http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer sk-XXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"say hi"}],"max_tokens":50}'
```

**Gotcha**：3 次重试（`MAX_RETRIES=3`，`handler.ts:11`），429/500/502/503/504 会换账号或退避重试；401 会触发一次 `manager.refreshAccount`（`handler.ts:126-132`）。

---

### POST /v1/responses

OpenAI Responses API。claude 模型走 `src/providers/claude.ts` 的 responses handler；codex 模型走 `src/providers/codex-responses.ts`。

**Body 关键字段**：`model`、`input`（支持 OpenAI 标准 string 或数组）、`stream`、`tools`、`instructions`。

**响应**：`{id: "resp_...", object: "response", status: "completed", output: [{type: "message", role: "assistant", content: [{type: "output_text", text}]}], usage: {input_tokens, output_tokens, total_tokens}}`。

```bash
curl -sS -X POST http://127.0.0.1:8317/v1/responses \
  -H "Authorization: Bearer sk-XXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","input":"hi"}'
```

**状态更新**：早期 P1 “不接 string input” 已修复。传 `"input":"hi"` 时，CCPA 会先规范化成 user message 再送到 Claude/Codex；数组 input 仍保持兼容。

---

### POST /v1/images/generations

DALL-E 兼容。强制走 codex（`src/server.ts:209-229`），默认 `model="gpt-image-2"`，内部转成 `gpt-5.5` + `image_generation` tool（`src/providers/codex-images.ts:15-71`）。

**Body 关键字段**：`prompt`（必填）、`model`（默认 `gpt-image-2`）、`n`（1-4）、`response_format`（`b64_json` 默认 / `url`）、`size`、`quality`、`background`、`output_format`。

**响应**：`{created, data: [{b64_json}]}` 或 `{data: [{url}]}`。

```bash
curl -sS -X POST http://127.0.0.1:8317/v1/images/generations \
  -H "Authorization: Bearer sk-XXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a red apple on a table","n":1,"size":"1024x1024","response_format":"b64_json"}'
```

**Gotcha**：图片端点是非流式响应，耗时通常更长（30s+）。Codex chat/responses stream 中的 `partial_image` 已有 OpenAI-compatible 转换；若业务要稳定拿最终图片，仍建议优先使用 `/v1/images/generations`。

---

### POST /v1/messages

Anthropic native passthrough，只接受 `claude-*` 模型，走 `src/proxy/passthrough.ts`（`createMessagesHandler`）。

**Body 关键字段**：`model`、`messages[]`（必填）、`max_tokens`、`system`、`stream`、`tools`、`temperature`。注意要带 `anthropic-version` header（`callClaudeAPI` 内部固定 `2023-06-01`）。

**响应**：原生 Anthropic 形状 — `{id, type: "message", role: "assistant", content: [{type: "text", text}], stop_reason, usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}}`。

```bash
curl -sS -X POST http://127.0.0.1:8317/v1/messages \
  -H "Authorization: Bearer sk-XXX" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

---

### POST /v1/messages/count_tokens

只 claude，passthrough 到 Anthropic 的 token 计数端点。

**Body**：`model`、`messages[]`（或 `system`、`tools`）。**响应**：`{"input_tokens": <int>}`。

```bash
curl -sS -X POST http://127.0.0.1:8317/v1/messages/count_tokens \
  -H "Authorization: Bearer sk-XXX" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"count me"}]}'
```

实测返 `{"input_tokens":9}`。

---

### GET /v1/models

列 11 个模型（5 个 claude 全名 + 3 个 claude alias + 3 个 codex），逻辑在 `src/server.ts:249-260`，源是 `ClaudeProvider.listModels()` 拼 `CodexProvider.listModels()`。

**响应**：`{object: "list", data: [{id, object: "model", created, owned_by}]}`。`owned_by` 是 `"anthropic"` 或 `"openai"`。

```bash
curl -sS http://127.0.0.1:8317/v1/models -H "Authorization: Bearer sk-XXX"
```

实测 11 条全列出，详见"模型"section。

---

### GET /health

无认证。返回非敏感 runtime identity：`{"status":"ok","service":"auth2api","version":"...","started_at":"...","uptime_ms":123}`。**不暴露账号数量或 provider 细节**。

```bash
curl -sS http://127.0.0.1:8317/health
```

---

### GET /monitor

无认证，返 `Content-Type: text/html` 的 dashboard 页面（`src/monitoring/dashboard-page.ts`，810 行）。浏览器直接打开 `http://127.0.0.1:8317/monitor`。

```bash
curl -sS -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:8317/monitor
# 200 text/html; charset=utf-8
```

---

### GET /admin/accounts

需要 api-key（`/admin` 走同一鉴权中间件，`src/server.ts:190`）。返聚合的账号快照 + 各 provider 状态（`src/server.ts:271-281`）。

**响应**：`{server: {provider_status, providers: {...}}, accounts: [{email, available, cooldownUntil, failureCount, lastError, lastSuccessAt, lastRefreshAt, totalRequests, totalSuccesses, totalFailures, expiresAt, refreshing}], account_count, claude: {...}, codex: {...}, generated_at}`。

```bash
curl -sS http://127.0.0.1:8317/admin/accounts -H "Authorization: Bearer sk-XXX"
```

**Gotcha**：`accounts` 数组当前只装 Claude OAuth 账号；Codex 没有同构的多账号池，所以状态在 `codex` 子对象里。总体可用性看 `server.provider_status`，排查 provider 细节再看 `claude` / `codex`。

---

### GET /admin/usage 与 /admin/usage/recent

文档之前漏了。`src/server.ts:283-290` 也注册了两个监控端点：

- `/admin/usage` — 跨请求聚合：`{totals: {totalRequests, inputTokens, outputTokens, ...}, providers: {claude: {...}, codex: {...}}}`
- `/admin/usage/recent?limit=N` — 最近 N 条请求的 detail

```bash
curl -sS http://127.0.0.1:8317/admin/usage -H "Authorization: Bearer sk-XXX"
curl -sS "http://127.0.0.1:8317/admin/usage/recent?limit=20" -H "Authorization: Bearer sk-XXX"
```

---

### POST /v1/embeddings — 不支持

未实现。已鉴权请求返回 OpenAI-style JSON 404，不再是 Express HTML。

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8317/v1/embeddings \
  -H "Authorization: Bearer sk-XXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"hi"}'
# 404
```

响应体形状：

```json
{"error":{"message":"Endpoint not implemented: POST /v1/embeddings","type":"invalid_request_error","code":"endpoint_not_implemented"}}
```

如果业务需要 embeddings，单独走别的 provider，别指 ccpa。

---

### 通用错误形状

- 所有本地 `/v1` / `/admin` validation、鉴权、未知端点错误都使用 OpenAI-style JSON：`{error: {message, type, code}}`。
- 鉴权失败：401 `authentication_error` + `missing_api_key`；403 `authentication_error` + `invalid_api_key`。
- rate limit：429 `rate_limit_error`，code 例如 `rate_limit_exceeded` 或 provider/account 相关 code。
- model 路由失败：400 `invalid_request_error` + `unsupported_model`。
- 未实现端点：404 `invalid_request_error` + `endpoint_not_implemented`。
- Claude/Codex provider validation/auth/upstream/internal 错误也已归一到稳定 `error.type` / `error.code`，便于 OpenAI SDK 和业务 retry 逻辑识别。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
curl -sS http://127.0.0.1:8317/health
/usr/bin/curl -sS http://127.0.0.1:8317/v1/models -H 'Authorization: Bearer sk-XXX'
/usr/bin/curl -sS http://127.0.0.1:8317/admin/accounts -H 'Authorization: Bearer sk-XXX'
/usr/bin/curl -sS http://127.0.0.1:8317/admin/usage -H 'Authorization: Bearer sk-XXX'
/usr/bin/curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8317/v1/embeddings -H 'Authorization: Bearer sk-XXX' -d '{"model":"text-embedding-3-small","input":"hi"}'
/usr/bin/curl -sS -X POST http://127.0.0.1:8317/v1/chat/completions -H 'Authorization: Bearer sk-XXX' -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"say hi in 3 words"}],"max_tokens":50}'
/usr/bin/curl -sS -X POST http://127.0.0.1:8317/v1/messages -H 'Authorization: Bearer sk-XXX' -H 'anthropic-version: 2023-06-01' -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
/usr/bin/curl -sS -X POST http://127.0.0.1:8317/v1/messages/count_tokens -H 'Authorization: Bearer sk-XXX' -H 'anthropic-version: 2023-06-01' -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"count me"}]}'
/usr/bin/curl -sS -X POST http://127.0.0.1:8317/v1/responses -H 'Authorization: Bearer sk-XXX' -d '{"model":"gpt-5.4","input":"hi","stream":false}'
/usr/bin/curl -sS -X POST http://127.0.0.1:8317/v1/responses -H 'Authorization: Bearer sk-XXX' -d '{"model":"gpt-5.4","input":[{"role":"user","content":"hi"}],"stream":false}'
curl -sS -o /dev/null -w 'monitor: %{http_code}, content-type: %{content_type}\n' http://127.0.0.1:8317/monitor
```

</details>

---

## 4. 模型矩阵与路由

### 11 个 model 一览

`GET /v1/models` 返回 11 条记录（8 个 claude 别名/具体名 + 3 个 codex）。下表把每个 model 的上游、用途、能力位都标清楚（cache 列特指 prompt caching；codex 路径没启用 cache_control，所以全 N）。

| model id | alias 等价 | 上游 provider | 用途 | tools | stream | prompt caching |
|---|---|---|---|---|---|---|
| `claude-opus-4-8` | — | anthropic | chat | Y | Y | Y |
| `claude-opus-4-6` | `opus` | anthropic | chat | Y | Y | Y |
| `claude-sonnet-4-6` | `sonnet` | anthropic | chat | Y | Y | Y |
| `claude-haiku-4-5-20251001` | `haiku` / `claude-haiku-4-5` | anthropic | chat | Y | Y | Y |
| `claude-haiku-4-5` | (alias→上一行) | anthropic | chat | Y | Y | Y |
| `opus` | (alias→`claude-opus-4-6`) | anthropic | chat | Y | Y | Y |
| `sonnet` | (alias→`claude-sonnet-4-6`) | anthropic | chat | Y | Y | Y |
| `haiku` | (alias→`claude-haiku-4-5-20251001`) | anthropic | chat | Y | Y | Y |
| `gpt-5.4` | — | codex | chat | Y | Y | N |
| `gpt-5.5` | — | codex | chat | Y | Y | N |
| `gpt-image-2` | — | codex | image | N（内置 image_generation tool） | 部分（P3 限制） | N |

注意 `claude-haiku-4-5` 和 `claude-haiku-4-5-20251001` 是同一个上游 model，但 `/v1/models` 把它们当两条返回（claude.ts:9-18 的 hardcode 列了两条）；实测请求 `claude-haiku-4-5` 响应里 `model` 字段会被改写成 `claude-haiku-4-5-20251001`，因为 translator.ts:12 的 MODEL_ALIASES 做了归一。

### 路由规则

`src/providers/router.ts:6-29` 的 `resolveProviderFromModel()` 只做 prefix 匹配，先小写归一：

```typescript
// router.ts:3-4, 16-26
const CLAUDE_PREFIXES = ["claude-"];
const CODEX_PREFIXES = ["gpt-", "codex-"];
// 命中 claude-* → "claude"
// 命中 gpt-*  / codex-* → "codex"
// 命中 /^o\d/ (o1, o3, o4...) → "codex"
// 其它 → null（404 unsupported_model）
```

裸 alias `opus` / `sonnet` / `haiku` **不走** prefix 路由，它们靠 `ClaudeProvider.supportsModel()`（claude.ts:38-49）单独识别——`CLAUDE_MODELS.includes(normalized)` 那一支兜住。所以加新别名必须改 `CLAUDE_MODELS`，否则 router 会 404。

进了 claude provider 之后，translator.ts:15-17 的 `resolveModel()` 把 alias 翻成具体上游 model 名再丢给 Anthropic API。MODEL_ALIASES 全集：

```typescript
// src/proxy/translator.ts:5-13
{
  opus:                "claude-opus-4-6",
  sonnet:              "claude-sonnet-4-6",
  haiku:               "claude-haiku-4-5-20251001",
  "claude-opus-4-8":   "claude-opus-4-8",
  "claude-opus-4-6":   "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5":  "claude-haiku-4-5-20251001",
}
```

注意 `opus` 别名翻到 `claude-opus-4-6`（不是 4-8）。要用最新 opus 必须显式写 `claude-opus-4-8`。

### model 来源

- **claude 列表** 是 hardcode：`src/providers/claude.ts:9-18` 的 `CLAUDE_MODELS` tuple，加新型号要改源码 + 重编译。
- **codex 列表** 走配置：`config.yaml` 的 `codex.models[]`，启动时 `CodexProvider` 读进来生成 `/v1/models` 输出，加新型号改 yaml 重启即可：

```yaml
# /Users/wy/auth2api/config.yaml:22-29
codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"
    - "gpt-5.5"
    - "gpt-image-2"
```

### 实测验证（2026-06-09 19:50 本机）

对 10 个 chat model 各发一次 `{"messages":[{"role":"user","content":"OK"}],"max_tokens":5}`：

| model | 状态 | latency | prompt/completion tokens |
|---|---|---|---|
| `claude-opus-4-8` | 200 | 1.99s | 36 / 5 |
| `claude-opus-4-6` | 200 | 3.90s | 25 / 5 |
| `claude-sonnet-4-6` | 200 | 4.24s | 25 / 5 |
| `claude-haiku-4-5-20251001` | 200 | 2.68s | 24 / 5 |
| `claude-haiku-4-5` | 200 | 2.15s | 24 / 5 (resolve→4-5-20251001) |
| `opus` | 200 | 2.76s | 25 / 5 (resolve→opus-4-6) |
| `sonnet` | 200 | 2.99s | 25 / 5 (resolve→sonnet-4-6) |
| `haiku` | 200 | 2.90s | 24 / 5 (resolve→haiku-4-5-20251001) |
| `gpt-5.4` | 200 | 2.75s | 7 / 5 |
| `gpt-5.5` | 200 | 2.76s | 7 / 11 |

`gpt-image-2` 用 `/v1/images/generations` 单独测：

```bash
rtk proxy curl -sS http://127.0.0.1:8317/v1/images/generations \
  -H "Authorization: Bearer sk-XXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a red dot","size":"1024x1024","n":1}'
# → {"created":...,"data":[{"b64_json":"iVBORw0KGgo..."}]}  ~ 30s
```

stream 抽测 `claude-haiku-4-5` 和 `gpt-5.5` 都拿到了正常 SSE chunk，最末一条 chunk 带 usage 字段，再下来 `data: [DONE]`（codex 路径）或直接关流（claude 路径）。

### 给业务的请求样例

```python
from openai import OpenAI

c = OpenAI(
    base_url="http://127.0.0.1:8317/v1",
    api_key="sk-XXX",
)

# claude
r = c.chat.completions.create(
    model="claude-opus-4-8",
    messages=[{"role": "user", "content": "OK"}],
    max_tokens=5,
)

# codex
r = c.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "OK"}],
    max_tokens=5,
)
```

### 加新模型

**claude 系列**（必须改源码）：

1. 编辑 `src/providers/claude.ts:9` 的 `CLAUDE_MODELS` tuple，把新 id 加进去。
2. 如果是别名再加进 `src/proxy/translator.ts:5` 的 `MODEL_ALIASES`，让它能 resolve 到真名。
3. `npm run build` 重编译。
4. `launchctl kickstart -k gui/$(id -u)/com.wy.ccpa` 重启。

**codex 系列**（改配置即可）：

```bash
# 1. 编辑 config.yaml 的 codex.models[]
# 2. 重启
launchctl kickstart -k gui/$(id -u)/com.wy.ccpa
# 3. 验证
rtk proxy curl -sS http://127.0.0.1:8317/v1/models | python3 -c 'import sys,json;d=json.load(sys.stdin);print([m["id"] for m in d["data"]])'
```

注意 codex 那边的 model id 必须真的在 ChatGPT 后端存在，CCPA 不校验，写错了请求时上游会 400/404。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
rtk proxy curl -sS http://127.0.0.1:8317/v1/models -H 'Authorization: Bearer sk-XXX'
curl -sS http://127.0.0.1:8317/health
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"claude-opus-4-8","messages":[{"role":"user","content":"OK"}],"max_tokens":5}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"OK"}],"max_tokens":5}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"OK"}],"max_tokens":5}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"claude-haiku-4-5-20251001",...}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"claude-haiku-4-5",...}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"opus",...}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"sonnet",...}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"haiku",...}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"gpt-5.4",...}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"gpt-5.5",...}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/images/generations -d '{"model":"gpt-image-2","prompt":"a red dot","size":"1024x1024","n":1}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"claude-haiku-4-5",...,"stream":true}'
rtk proxy curl -sS http://127.0.0.1:8317/v1/chat/completions -d '{"model":"gpt-5.5",...,"stream":true}'
```

</details>

---

## 5. 业务集成范例

CCPA 对外就是一个 OpenAI 兼容的 HTTP endpoint，所以业务侧能用的姿势就三套：原生 `httpx`、官方 `openai` SDK、以及本机的 `clade` library。下面四种是已经在管线里跑通的写法，直接粘贴改改就能用。

### 1. Python httpx 调 chat completions

依赖最轻、行为最可控，建议生产管线优先用这套。注意 stream 模式必须显式设 `read` timeout，否则连接死掉时 socket recv 永远 block（实测 8h 不超时，参见 `clade_safe_thu.py:42-46`）。

```python
import httpx

CCPA_BASE = "http://127.0.0.1:8317"
API_KEY = "sk-XXX"

# 非 stream：拿完整 JSON
def chat_once(messages, model="claude-opus-4-8", max_tokens=4096):
    with httpx.Client(
        trust_env=False,  # 别让系统代理打架
        timeout=httpx.Timeout(connect=15.0, read=180.0, write=15.0, pool=15.0),
    ) as client:
        r = client.post(
            f"{CCPA_BASE}/v1/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json={"model": model, "messages": messages, "max_tokens": max_tokens},
        )
        r.raise_for_status()
        data = r.json()
    msg = data["choices"][0]["message"]["content"]
    u = data.get("usage", {})
    # 关键：读 cache 命中字段（translator.ts 今天加的）
    cached = u.get("prompt_tokens_details", {}).get("cached_tokens", 0)
    cc = u.get("cache_creation_input_tokens", 0)
    cr = u.get("cache_read_input_tokens", 0)
    print(f"in={u.get('prompt_tokens')} out={u.get('completion_tokens')} "
          f"cache_create={cc} cache_read={cr} (openai-shape cached={cached})")
    return msg

# stream：SSE 累加
def chat_stream(messages, model="claude-opus-4-8"):
    with httpx.Client(trust_env=False,
                     timeout=httpx.Timeout(connect=15.0, read=120.0, write=15.0, pool=15.0)) as c:
        with c.stream("POST", f"{CCPA_BASE}/v1/chat/completions",
                      headers={"Authorization": f"Bearer {API_KEY}"},
                      json={"model": model, "messages": messages, "stream": True}) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line or not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload == "[DONE]":
                    break
                import json
                chunk = json.loads(payload)
                delta = chunk["choices"][0]["delta"].get("content", "")
                if delta:
                    yield delta
```

### 2. Python OpenAI SDK

`openai>=1.0` 直接指 `base_url` 即可。坑：`http_client` 要传 `trust_env=False` 否则 SDK 默认从环境读 `HTTPS_PROXY`，跟 ccpa 本机 LaunchAgent 注的 Surge proxy 重复套娃。

```python
import httpx
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8317/v1",
    api_key="sk-XXX",
    http_client=httpx.Client(trust_env=False, timeout=180.0),
    max_retries=0,  # 业务侧自己 retry，别让 SDK 偷偷重试
)

resp = client.chat.completions.create(
    model="claude-opus-4-8",  # 或 gpt-5.5 / claude-haiku-4-5 / gpt-image-2
    messages=[{"role": "user", "content": "一句话总结 ccpa 是干啥的"}],
)
print(resp.choices[0].message.content)
print(resp.usage.prompt_tokens, resp.usage.completion_tokens)
```

适用场景：和现有 OpenAI 代码无缝对接、需要 tool_calls / function calling 走 OpenAI 标准 schema。

### 3. clade library（本机标准调法）

`clade` 在 `~/clade/` 是统一 router：负责 alias 解析（`claude-opus-4-8` → canonical key）、provider 选择（ccpa / volcano / thu）、按 `model_fallbacks` 自动切。所有自动化管线一律 `from clade import LLM`，**绝不** `subprocess claude -p`（参见 MEMORY `feedback_no_claude_p_use_clade`）。

```python
from pathlib import Path
from clade import LLM

# 50.9 上 config_path 必须显式给，本机的 default 不对
llm = LLM(config_path=str(Path.home() / "clade/config.yaml"))

resp = llm.chat(
    "claude-opus-4-8",  # 走 ccpa → 失败 fallback gpt-5.5/5.4（见 ~/clade/config.yaml model_fallbacks）
    messages=[
        {"role": "system", "content": "你是简洁助手"},
        {"role": "user", "content": "ccpa 端口?"},
    ],
)
print(resp.content, resp.provider, resp.latency, resp.input_tokens, resp.output_tokens)
```

注意：改 `model_fallbacks` 前先 `resolve_model` 看真 canonical（如 `claude-opus-4-8-ccpa`），挂错 key 会静默失效（MEMORY `feedback_clade_fallback_keyed_by_resolved_canonical`）。

### 4. Image generation 三种触发方式

ccpa 的 `gpt-image-2` 走 codex 路径，在 `codex-chat.ts:140-172` 三条触发线并联：

```python
import httpx, base64
BASE = "http://127.0.0.1:8317"; KEY = "sk-..."

# (a) 显式 /v1/images/generations（DALL-E 兼容，最推荐）
r = httpx.post(f"{BASE}/v1/images/generations",
    headers={"Authorization": f"Bearer {KEY}"},
    json={"model": "gpt-image-2", "prompt": "a cat sitting on a laptop",
          "n": 1, "size": "1024x1024"},
    timeout=180)
img_b64 = r.json()["data"][0]["b64_json"]
open("cat.png","wb").write(base64.b64decode(img_b64))

# (b) chat 接口 + 中文自然语言（codex-chat.ts:155-159 正则触发）
#   "画一只猫" / "生成一张图" / "绘制风景" / "做张海报" 都会自动注入 image_generation tool
httpx.post(f"{BASE}/v1/chat/completions",
    headers={"Authorization": f"Bearer {KEY}"},
    json={"model": "gpt-5.5",
          "messages": [{"role": "user", "content": "画一只赛博朋克风格的猫"}]})

# (c) chat 接口 + 英文自然语言（codex-chat.ts:160）
#   /\b(generate|create|draw|make|render)\b.{0,40}\b(image|picture|...)\b/
httpx.post(f"{BASE}/v1/chat/completions",
    headers={"Authorization": f"Bearer {KEY}"},
    json={"model": "gpt-5.5",
          "messages": [{"role": "user", "content": "Generate a logo for a coffee shop"}],
          "tools": [{"type": "image_generation"}]})  # explicit tool 最稳，绕过正则匹配
```

图像生成日常优先用 `doubao-seedream-5-0-260128`（火山引擎，CLAUDE.md 默认），ccpa 的 `gpt-image-2` 当 codex 订阅顺路出图用。

### 5. clade_safe_thu 兜底机制为什么仍保留

`clade_safe_thu.py` 是 monkey-patch，`import` 一下就让所有 `LLM.chat` 默认走 thu (gpt-5.5)，thu 三次都挂才回 ccpa。ccpa 今天恢复了，但策略不撤——理由：(a) ccpa 是个人订阅 quota，连续大批量管线（每日 brief、老外看中国 12 主题视频翻译）容易撞 429 cooldown 全链路断；(b) thu 是聚合网关，慢但稳（小请求 2-13s、大请求 50-60s），管线 SLA 优先稳；(c) 质量差在 prompt/persona 层补硬约束（参见 MEMORY `feedback_ai_products_persona_bypass_bigthink`），不靠模型续命。

切回 ccpa 主线的开关方式：业务文件**删掉** `import clade_safe_thu` 这一行（`brief.py:30` 那种），不需要改 `clade/config.yaml`。

### 6. 常见错误处理对照表

| HTTP | 现象 | 根因 | 处理 |
|---|---|---|---|
| 401 `{"error":{"message":"Missing API key"}}` | Authorization header 缺 | 忘了带 Bearer | 加 header |
| 403 `Invalid API key` | api-key 不在 `config.yaml api-keys[]` | 改错 key 或换机后没同步 | 比对 `~/auth2api/config.yaml` |
| 429 | 当前可选 Claude 账号都在 cooldown | Anthropic 限流或请求失败触发账号级 backoff | 等冷却、换 oauth，或让业务侧 fallback |
| 503 / `account_token_expired` | 所有 Claude token 过期且 refresh 不可用 | refresh_token 失效或 OAuth 刷新 backoff | 重新 `--login`，或等 refresh backoff 后自动重试 |
| 500 `fetch failed` | ProxyAgent 没启动 | LaunchAgent plist 里 `HTTPS_PROXY` 没设 / Surge 没在 6152 | 检 `~/Library/LaunchAgents/com.wy.ccpa.plist` |
| stream 永远不返回 | 没设 read timeout | httpx 默认无超时 + 上游 socket 死 | 必须 `httpx.Timeout(read=120.0)` |
| 404 JSON `endpoint_not_implemented` | embedding 端点未实现 | CCPA 不提供 embedding provider | 业务侧别调 ccpa 做 embedding，用 volcano/openai 直连 |

业务侧 retry 模板（参考 `clade_safe_thu.py:64-91`）：3 次指数退避（5s、10s、15s），429/503 才 retry，401/400 立即 raise；ccpa 全挂走 thu fallback，thu 也挂当天选题/翻译降级跳过别死循环。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
curl -s http://127.0.0.1:8317/health -H 'Authorization: Bearer sk-XXX'
curl -s -X POST http://127.0.0.1:8317/v1/chat/completions -H 'Authorization: Bearer sk-...' -H 'Content-Type: application/json' -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":20}' -o /tmp/ccpa_resp.json
curl -s -X POST http://127.0.0.1:8317/v1/chat/completions -H 'Authorization: Bearer sk-...' -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"count 1 to 5"}],"stream":true,"max_tokens":50}'
curl -s -X POST http://127.0.0.1:8317/v1/chat/completions -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}'
curl -s -X POST http://127.0.0.1:8317/v1/chat/completions -H 'Authorization: Bearer wrong-key' -d '{"model":"claude-haiku-4-5","messages":[...]}'
curl -s -X POST http://127.0.0.1:8317/v1/images/generations -H 'Authorization: Bearer sk-...' -d '{"model":"gpt-image-2","prompt":"a cat","n":1,"size":"1024x1024"}'
curl -s http://127.0.0.1:8317/v1/embeddings -H 'Authorization: Bearer sk-...' -d '{"input":"hi","model":"text-embedding-3-small"}'
```

</details>

---

## 6. 运维 Runbook

下面所有操作默认本机（`~/auth2api`, plist `com.wy.ccpa`），50.9 段落标注。命令都在 2026-06-09 当前 token 状态下跑过一遍。

### 1. 服务启停 / 重启

何时用：刚改 plist、刚重装、卡死要硬启。日常代码改动 *不要* bootout，用 kickstart。

```bash
# 启动（首次或 bootout 之后）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wy.ccpa.plist

# 停止并卸载
launchctl bootout gui/$(id -u)/com.wy.ccpa

# 仅重启进程（不重读 plist；改 plist 时无效）
launchctl kickstart -k gui/$(id -u)/com.wy.ccpa

# 看进程
ps -p $(pgrep -f auth2api/dist/index) -o pid,etime,rss,command
# 我刚看到 PID 39642, ELAPSED 11:26, RSS ~50MB

# 服务状态摘要
launchctl print gui/$(id -u)/com.wy.ccpa | head -20
```

### 2. 改代码 → 编译 → 重启

何时用：改了任何 `src/**/*.ts`。

```bash
cd ~/auth2api
npx tsc                                       # 出错就停，不要 kickstart
ls -la dist/index.js dist/proxy/translator.js # 看 mtime 比 src 新
launchctl kickstart -k gui/$(id -u)/com.wy.ccpa
sleep 2
curl -sS http://127.0.0.1:8317/health         # status/service/version/started_at/uptime_ms
tail -5 /tmp/ccpa.stdout.log                  # 看到 "auth2api running on http://0.0.0.0:8317"
```

注意：`npx tsc` *不会自动* 触发重启，必须 kickstart。

### 3. 健康检查三连

何时用：业务报 fetch failed、provider error，或刚改完想确认。

```bash
# 进程
curl -sS http://127.0.0.1:8317/health
# → {"status":"ok","service":"auth2api","version":"...","started_at":"...","uptime_ms":...}

# 模型列表（要带 api-key, 见 config.yaml api-keys）
KEY=sk-XXX
curl -sS -H "Authorization: Bearer $KEY" http://127.0.0.1:8317/v1/models
# 应返回 11 个模型（claude-* + gpt-*）

# 账号状态
curl -sS -H "Authorization: Bearer $KEY" http://127.0.0.1:8317/admin/accounts
# 看 cooldown / failureCount / nextRefreshAttemptAt
```

不带 key 会返 `{"error":{"message":"Missing API key"}}`，这是正常的。

### 4. Claude token 过期 / refresh 失败 → 重 OAuth

何时用：`/tmp/ccpa.stderr.log` 反复出 `Token refresh failed: fetch failed`，或 token 文件 `expired` 早于 now。我刚看 stderr 就是这状态（`failure #2, next attempt in 120s`），但当前 `expired=2026-06-09T11:36:15Z` 还有 ~4h 才到，所以业务还能跑；真过期了才必须重 oauth。

```bash
# 看 token 元数据，不输出 access_token / refresh_token
python3 -c 'import glob,json,os; [print("claude token", json.load(open(p)).get("expired"), json.load(open(p)).get("last_refresh"), json.load(open(p)).get("type")) for p in glob.glob(os.path.expanduser("~/.auth2api/claude-*.json"))]'
# expired/last_refresh 字段是 ISO 时间；expired < now 就是过期

# 停 ccpa 释放 54545 端口
launchctl bootout gui/$(id -u)/com.wy.ccpa

# 走 Surge 代理重 oauth（Anthropic 国内不通，必须挂代理）
cd ~/auth2api
HTTPS_PROXY=http://127.0.0.1:6152 HTTP_PROXY=http://127.0.0.1:6152 \
  node dist/index.js --login --manual

# 终端会打印一个 https://claude.ai/oauth/authorize?... 链接
# 浏览器打开 → 登录 → 同意 → 浏览器跳转到 http://127.0.0.1:54545/callback?code=...
# 把这个完整 callback URL 复制回终端粘贴

# 验证 token 文件
python3 -c 'import glob,json,os; [print(json.load(open(p)).get("expired"), json.load(open(p)).get("last_refresh")) for p in glob.glob(os.path.expanduser("~/.auth2api/claude-*.json"))]'
# expired 应在 8h 之后

# 重新启动 ccpa
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wy.ccpa.plist
```

坑：`--login` 必须显式设 `HTTPS_PROXY`，plist 里的 env 不会注入到手动 node 进程里（已知 P3）。

### 5. Codex token 报错处理

Codex token 在 `~/.codex/auth.json`，由 codex CLI 自动续期，**ccpa 不管 refresh**。报错形式：

- 业务请求 `gpt-5.5` 收到上游 `401 Unauthorized`（ccpa 无 retry，直接透）
- `/tmp/ccpa.stderr.log` 出 codex upstream 401

救援：

```bash
# 用 codex CLI 续期（你需要在装了 codex 的 shell）
codex login        # 或 codex auth refresh，取决于版本
ls -la ~/.codex/auth.json   # 看 mtime 是不是刚刷新

# ccpa 端不需要重启，CodexAuthStore 每次请求 re-read auth-file
# 但保险起见可以 kickstart
launchctl kickstart -k gui/$(id -u)/com.wy.ccpa
```

### 6. 日志 / 排错

```bash
tail -f /tmp/ccpa.stdout.log    # 启动 / cooldown / refresh 成功
tail -f /tmp/ccpa.stderr.log    # refresh failed / 401 链
```

错误模式 → 根因映射：

| stderr 关键字 | 根因 | 操作 |
|---|---|---|
| `Token refresh failed: fetch failed` | 出站走不通 Anthropic | 查 `HTTPS_PROXY` 是否 6152（不是 8234），Surge 在跑 |
| `Token refresh failed (failure #N, next attempt in ...)` | 退避中（manager.ts 750bdcfe） | 等回退或直接 `--login` 重 oauth |
| `Rate limited on the configured account` | 上游 401/quota | 看 /admin/accounts cooldown，必要时 oauth |
| 客户端 `All providers exhausted` | clade 3 retry 全挂 | 不是 ccpa 自己的错，回到上面三连 |

### 7. 50.9 同步流程

何时用：本机改完一个 src/ 文件，要同步到 Mac mini。

```bash
# 单文件同步示例
scp ~/auth2api/src/proxy/translator.ts wangyan@192.168.50.9:~/ccpa/src/proxy/translator.ts

# 远端编译 + 重启
ssh wangyan@192.168.50.9 'cd ~/ccpa && PATH=/opt/homebrew/bin:$PATH ./node_modules/.bin/tsc && launchctl kickstart -k gui/$(id -u)/com.wangyan.ccpa'

# 验证远端在跑
ssh wangyan@192.168.50.9 'curl -sS http://127.0.0.1:8317/health'
```

50.9 用 `/opt/homebrew/bin/node`（非 nvm），plist 名 `com.wangyan.ccpa`，用户 wangyan / uid 501。

### 8. md5 一致性 check

何时用：怀疑两端代码漂了。

```bash
LOCAL=$(md5 -q ~/auth2api/src/proxy/translator.ts ~/auth2api/src/accounts/manager.ts ~/auth2api/src/providers/codex-chat.ts ~/auth2api/src/providers/codex-sse.ts)
REMOTE=$(ssh wangyan@192.168.50.9 'md5 -q ~/ccpa/src/proxy/translator.ts ~/ccpa/src/accounts/manager.ts ~/ccpa/src/providers/codex-chat.ts ~/ccpa/src/providers/codex-sse.ts')
diff <(echo "$LOCAL") <(echo "$REMOTE")
```

当前对齐基线（2026-06-09 14:35+）：

```
translator.ts    1d21b8337366c59cca5f29fdccf8f9dc
manager.ts       750bdcfe943cc6a138658ce928fc1848
codex-chat.ts    5c3fa71361f4b410b0aad59e1b9b428f
codex-sse.ts     ad77d1eac406b56c102921ce06bae761
```

注意：`codex-chat.ts` 当前 md5 `5c3fa713`（背景文档里 `0a1f4ef6` 是 stream chunk id fix 之前的旧值，已被覆盖）。

### 9. 回滚

何时用：刚改完一发版本业务挂了。

```bash
ls ~/auth2api/src/providers/*.bak-pre-*
# 实际存在的: codex-chat.ts.bak-pre-merge-2026-06-09, codex-sse.ts.bak-pre-merge-2026-06-09
# 注意：translator.ts / manager.ts 的 .bak-pre-* 我没找到（背景文档列了但磁盘上没有），改前自己再 cp 一份

# 回滚单文件
cp ~/auth2api/src/providers/codex-chat.ts.bak-pre-merge-2026-06-09 ~/auth2api/src/providers/codex-chat.ts
cd ~/auth2api && npx tsc
launchctl kickstart -k gui/$(id -u)/com.wy.ccpa

# 50.9 同步回滚后的版本
scp ~/auth2api/src/providers/codex-chat.ts wangyan@192.168.50.9:~/ccpa/src/providers/codex-chat.ts
ssh wangyan@192.168.50.9 'cd ~/ccpa && PATH=/opt/homebrew/bin:$PATH ./node_modules/.bin/tsc && launchctl kickstart -k gui/$(id -u)/com.wangyan.ccpa'
```

### 10. 改 plist

何时用：调 `HTTPS_PROXY` 端口、加 env、改 KeepAlive。

```bash
vim ~/Library/LaunchAgents/com.wy.ccpa.plist
# 改完必须 bootout + bootstrap，kickstart 不会重读 plist
launchctl bootout gui/$(id -u)/com.wy.ccpa
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wy.ccpa.plist
launchctl print gui/$(id -u)/com.wy.ccpa | grep -A1 environment
```

50.9 同理，用户 wangyan 自己的 launchd 域：`launchctl bootout/bootstrap gui/$(id -u)/com.wangyan.ccpa`（在远端 ssh 后执行）。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
launchctl print gui/$(id -u)/com.wy.ccpa | head -20
ps -p $(pgrep -f auth2api/dist/index) -o pid,etime,rss,command
curl -sS http://127.0.0.1:8317/health
md5 -q ~/auth2api/src/proxy/translator.ts ~/auth2api/src/accounts/manager.ts ~/auth2api/src/providers/codex-chat.ts ~/auth2api/src/providers/codex-sse.ts
curl -sS -H 'Authorization: Bearer sk-XXX' http://127.0.0.1:8317/v1/models
curl -sS -H 'Authorization: Bearer sk-...' -X POST http://127.0.0.1:8317/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
python3 -c 'import glob,json,os; [print("claude token", json.load(open(p)).get("expired"), json.load(open(p)).get("last_refresh"), json.load(open(p)).get("type")) for p in glob.glob(os.path.expanduser("~/.auth2api/claude-*.json"))]'
tail -20 /tmp/ccpa.stdout.log; tail -10 /tmp/ccpa.stderr.log
ssh wangyan@192.168.50.9 'launchctl print gui/$(id -u)/com.wangyan.ccpa | head -15; md5 -q ~/ccpa/src/proxy/translator.ts ~/ccpa/src/accounts/manager.ts ~/ccpa/src/providers/codex-chat.ts ~/ccpa/src/providers/codex-sse.ts'
find ~/auth2api/src -name '*.bak*'
grep -A5 'api-keys' ~/auth2api/config.yaml
ls -la ~/Library/LaunchAgents/com.wy.ccpa.plist ~/auth2api/dist/index.js ~/auth2api/dist/proxy/translator.js
```

</details>

---

## 7. 更新日志与备份清单

### 2026-06-09 改动 changelog

按动手时间排序（备份文件 mtime 是最可靠的时间锚点）：

| 时间 | 文件 | 改动 | 为什么 | 影响 |
|---|---|---|---|---|
| 11:18 | `src/proxy/translator.ts` | `convertTools()` 末尾给每个 tool 加 `cache_control:{type:"ephemeral"}`；`claudeToOpenai` 和 streaming usage 加 `cache_creation_input_tokens` / `cache_read_input_tokens` + `prompt_tokens_details.cached_tokens` | 业务侧（老外看中国 cut.py、podcast pipeline）反复传相同 system prompt，没有 prompt cache 每次都花 input token | input token 单价从 $3/M 降到 $0.30/M（cache hit）；dashboard 已抓字段但未聚合（P2） |
| 11:28 | `src/accounts/manager.ts` | 新增 `REFRESH_FAIL_BASE_MS`(60s) / `REFRESH_FAIL_MAX_MS`(30min) + `refreshFailureCount` + `nextRefreshAttemptAt` 指数退避；`performRefresh` 的 catch 块**删掉 recordFailure** | 6/6 patch 在 50.9 已 backport 测过：refresh 失败时 `recordFailure` 会把账号打到 cooldown，反而拒绝服务 | refresh 抖动时不再误锁账号 |
| 11:54-11:58 | `src/providers/codex-chat.ts` | backport 50.9 的 6/6 全套（`extractToolCalls`/`convertChatToolsToResponses`/`convertChatToolChoiceToResponses`/`convertMessagesToInput`/streaming tool_calls）+ 我加 `hasImageGenerationTool`/`isImageGenerationRequest`（中文「画一只/绘制/创作」正则）/`shouldEnableImageGeneration` + `canonicalizeChatRequest` 注入 `image_generation` tool + 强制 `tool_choice` + `normalizeOutputText` image+text 双输出 + `emitChatChunk` 共享 `chatId` | 旧 codex-chat 流式 tool_calls 协议违规（每 chunk 新 id），且不支持 `/v1/chat/completions` 触发画图 | gpt-image-2 通过 `/v1/chat/completions` 即可触发；codex stream 部分渲染仍是 P3 |
| 12:06 | `src/providers/codex-sse.ts` | 整体换成 50.9 6/6 通用 `mergeOutputItem` 处理 `output_item.added` / `output_item.done` | codex 上游 SSE 字段有变更，旧 dispatcher 漏 output 类型 | gpt-5.5 工具调用不再静默丢字段 |
| 14:33 | `src/accounts/manager.ts` | 二次小调（mtime 比 11:28 晚） | 跟 50.9 v2 同步 | 已对齐（详见 fingerprint 段） |
| - | `~/Library/LaunchAgents/com.wy.ccpa.plist` | `HTTPS_PROXY` 8234 → 6152 | Surge 实际监听 6152，8234 是历史值，外网调用全 timeout | LLM fetch 恢复 |
| - | `~/.auth2api/claude-<account>.json` | 重做 oauth | 旧 token 过期 + refresh 也挂 | 新 token 起 8h 有效 |

### 6/6 patches 起源

6 月 6 日在 50.9 给菲姐 OpenClaw 调通保险方案 deck 管线时（参见 MEMORY 的 `feijie_solution_deck_anatomy` / `feijie_openclaw_model_providers`），CCPA 出现两个连锁 bug：

1. **Cooldown fix** (`manager.ts.bak-cooldownfix-2026-06-06`)：单账户 refresh 偶发失败时 `recordFailure` 把 `cooldown_until` 推到几小时后，整个 ccpa 自我封禁。修法 = catch 块只 log 不 record，把锁账号的责任收回给真正的 401/403 路径。
2. **Tools fix** (`codex-chat.ts.bak-toolsfix-2026-06-06`)：codex chat 端点把 tools 喂给 Responses API 时丢字段（function name 没传、多轮历史 tool_call_id 没回填），加贺/汤川等 agent 多轮 tool-calling 失败。修法 = 引入 `convertChatToolsToResponses` 全字段透传 + `convertMessagesToInput` 保留历史 tool_calls。

今天的工作是把这两个 fix **backport 回本机** + 在它们之上叠加 prompt cache 和 image_generation。所以本机 `manager.ts` 和 `codex-chat.ts` 的 `.bak-pre-*-2026-06-09` 备份保留的是「6/6 fix 之前 + 1.1.0 出厂」的旧版，回滚要慎重——直接还原会同时丢掉 6/6 和今天的两层改动。

### 备份命名规范

```
<file>.bak-pre-<reason>-<date>[-v<n>]
```

- `pre-<reason>` 表示「动手前的快照」，reason 用 kebab-case，简短描述本次改动主题：`merge` / `cache` / `backoff` / `imggen` / `sync`。
- `<date>` 用 `YYYY-MM-DD`（本项目默认 2026-06-09 格式）。
- 同一天对同一文件多次改动加 `-v2` / `-v3`。50.9 的 `manager.ts.bak-pre-sync-2026-06-09-v2` 就是当天第二次 sync 前留的快照。
- 历史遗留（6/6 那批）用 `.bak-<reason>-<date>` 无 `pre-` 前缀，新备份不再这么写。

### 当前所有备份清单

**本机 `~/auth2api/src/`：**

```
src/providers/codex-chat.ts.bak-pre-merge-2026-06-09   (12724 B, mtime 11:58, md5 a8f0ab08)
src/providers/codex-sse.ts.bak-pre-merge-2026-06-09    ( 4658 B, mtime 12:06, md5 81ad9f76)
```

注意本机**没有** `manager.ts` 和 `translator.ts` 的 .bak——今天动手前没存。回滚这两个文件必须从 50.9 拉对应快照或 `git checkout`。

**50.9 `~/ccpa/src/`：**

```
src/accounts/manager.ts.bak-cooldownfix-2026-06-06         (8381 B,  md5 c866d593)  ← 6/6 fix 之前的 1.1.0 原版
src/accounts/manager.ts.bak-pre-backoff-2026-06-09         (8447 B,  md5 33a4f298)  ← 6/6 fix 后、今天加 backoff 之前
src/accounts/manager.ts.bak-pre-sync-2026-06-09-v2         (9795 B,  md5 750bdcfe)  ← 当前生产版（与本机一致）
src/providers/codex-chat.ts.bak-pre-imggen-2026-06-09      (13382 B, md5 126d6112)
src/providers/codex-chat.ts.bak-pre-imggen-2026-06-09-v2   (13382 B, 同 hash，重复保留)
src/providers/codex-chat.ts.bak-toolsfix-2026-06-06        (9059 B,  md5 86e1ef20)  ← 6/6 fix 之前的 1.1.0 原版
src/proxy/translator.ts.bak-pre-cache-2026-06-09           (10662 B, md5 08ec1ee6)  ← 加 cache_control 之前
```

### 回滚顺序

按「最小破坏面」原则，**只回滚出问题的那一个文件**，不要一次性 revert 当天全部改动。流程：

```bash
# 1. 先确认当前坏文件的 md5，记到工单
md5 -q ~/auth2api/src/providers/codex-chat.ts

# 2. 找对应 .bak（看清楚是 pre-merge 还是 pre-imggen，别拿错代）
ls -la ~/auth2api/src/providers/codex-chat.ts.bak-*

# 3. 留当前坏版本另一个 .bak（出事后还能 forensic）
cp ~/auth2api/src/providers/codex-chat.ts \
   ~/auth2api/src/providers/codex-chat.ts.bak-rollback-broken-$(date +%Y-%m-%d-%H%M)

# 4. 还原
cp ~/auth2api/src/providers/codex-chat.ts.bak-pre-merge-2026-06-09 \
   ~/auth2api/src/providers/codex-chat.ts

# 5. rebuild + restart（细节见运维 section）
cd ~/auth2api && npm run build
launchctl kickstart -k gui/$(id -u)/com.wy.ccpa

# 6. 验证
curl -sS http://127.0.0.1:8317/health
```

**整体回滚到 6/6 baseline**（极端情况，比如今天改完 ccpa 全线挂掉）：用 50.9 的 `bak-cooldownfix-2026-06-06` / `bak-toolsfix-2026-06-06` 加上本机 `git checkout HEAD -- src/proxy/translator.ts src/providers/codex-sse.ts`，回到 v1.1.0 + 6/6 patch 状态。

### 关键 commit hash

upstream auth2api 仓库今天**没新 commit**——所有 2026-06-09 改动都在 working tree、未 commit。这是有意为之：等 LLM fetch 稳定跑 24h 之后再合一发 commit，不污染历史。

本机 `~/auth2api` HEAD：

```
7915477 feat: add browser monitor dashboard      ← 当前 HEAD
a6e9838 docs: rewrite readme for ccpa
559480f chore: prepare v1.1.0 release
```

50.9 `~/ccpa` HEAD：

```
b177ccf chore: prepare v1.1.1 release            ← 当前 HEAD（比本机超前 v1.1.1）
099d1e7 feat: improve monitor and codex compatibility
7915477 feat: add browser monitor dashboard
```

50.9 比本机多一个 `b177ccf` 1.1.1 release commit + `099d1e7` codex 兼容修复。**本机没 cherry-pick 这两个**——所有 6/6 fix 是直接以文件覆盖方式 backport 的，git 层面看不到。下次清理工作树前先 `git diff HEAD -- src/` 留 patch，否则今天的改动会随 `git checkout` 一并丢。

### 当前 fingerprint（供下次接手对照）

```
src/proxy/translator.ts        1d21b833  (cache_control + cache usage)
src/accounts/manager.ts        750bdcfe  (backoff + 删 recordFailure，与 50.9 v2 完全一致)
src/providers/codex-chat.ts    5c3fa713  (6/6 + imggen + stream chunk id fix)
src/providers/codex-sse.ts     ad77d1ea  (50.9 6/6 mergeOutputItem)
```

注意 `codex-chat.ts` 本机 md5 是 `5c3fa713`，跟 50.9 的 `bak-pre-imggen-2026-06-09` (`126d6112`) **不一致**——因为本机在 50.9 v2 基础上又叠了一次 stream `chatId` 共享修复（mtime 14:58，比 manager.ts 的 14:33 还晚），50.9 尚未同步该补丁。这是已知 drift，需要在下一轮 sync 时把本机这个新文件推回 50.9。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
find ~/auth2api/src -name '*.bak-*' | xargs ls -la
ssh wangyan@192.168.50.9 'find ~/ccpa/src -name "*.bak-*" | xargs ls -la'
cd ~/auth2api && git log --oneline -10
ssh wangyan@192.168.50.9 'cd ~/ccpa && git log --oneline -10'
md5 -q ~/auth2api/src/proxy/translator.ts ~/auth2api/src/accounts/manager.ts ~/auth2api/src/providers/codex-chat.ts ~/auth2api/src/providers/codex-sse.ts
md5 -q ~/auth2api/src/providers/codex-chat.ts.bak-pre-merge-2026-06-09 ~/auth2api/src/providers/codex-sse.ts.bak-pre-merge-2026-06-09
ssh wangyan@192.168.50.9 'md5 -q ~/ccpa/src/accounts/manager.ts.bak-cooldownfix-2026-06-06 ~/ccpa/src/accounts/manager.ts.bak-pre-backoff-2026-06-09 ~/ccpa/src/accounts/manager.ts.bak-pre-sync-2026-06-09-v2 ~/ccpa/src/providers/codex-chat.ts.bak-pre-imggen-2026-06-09 ~/ccpa/src/providers/codex-chat.ts.bak-toolsfix-2026-06-06 ~/ccpa/src/proxy/translator.ts.bak-pre-cache-2026-06-09'
stat -f '%Sm %N' ~/auth2api/src/providers/codex-chat.ts ~/auth2api/src/providers/codex-sse.ts ~/auth2api/src/proxy/translator.ts ~/auth2api/src/accounts/manager.ts
```

</details>

---

## 8. 已知问题与未来工作

下面清单原本来自 2026-06-09 review。2026-06-19 已按当前本机 repo 状态重新校订：已落地的项标为 **closed** 或 **mitigated**，仍应进入后续产品化的项标为 **open**。附录里保留的 verifier 原文是历史证据，不代表当前 active issue。

### P1 — 设计层硬约束，影响场景小但应改

#### 1. 单账户硬约束 throw — closed
- **2026-06-22 状态**：`AccountManager` 已从单个 `AccountState | null` 改为 `AccountState[]`。`auth-dir` 下多个 `claude-*.json` token 会被稳定加载，`getNextAccount()` 返回第一个可用账号；过期或 cooldown 中的账号会被跳过。
- **边界**：这只是自用备用账号池，不是加权轮询、额度聚合或并发放大。Codex 仍按 `codex.auth-file` 使用单个 auth file。
- **验证**：`tests/account-manager-state.test.ts` 覆盖多 token 加载、可用账号选择和 state 不写入 token；`tests/smoke.test.ts` 覆盖 `/admin/accounts` 多 snapshot 暴露。`npm run release:verify -- --require-provider-status ok` 已通过。

#### 2. CLAUDE_MODELS hardcode — closed
- **2026-06-19 状态**：Claude 模型列表已进入 `config.yaml` / `config.example.yaml` 的 `claude.models[]` 配置，并保留默认模型集。新增/调整 alias 不再需要改 provider 源码。
- **后续注意**：发布前用 `npm run typecheck`、`npm run test:unit`、`npm run test:smoke` 和 `npm run release:verify` 验证 `/v1/models` 与路由契约。

#### 3. in-memory state 不持久化 — closed
- **2026-06-19 状态**：Claude account runtime state 已落盘到 auth dir 下的 state 文件，覆盖 cooldown、failure counters、refresh backoff 和最近错误上下文；敏感 access/refresh token 不写入 state。
- **后续注意**：如果未来做多账户，需要把 state schema 从单账户自然扩展为 keyed map。

#### 4. `/v1/responses` string input compatibility — closed
- **2026-06-19 状态**：`src/providers/codex-request.ts` 已处理 `typeof input === "string"`，会规范化为 user message；Claude responses 路径也保留 OpenAI string input 兼容。
- **验证入口**：`npm run release:verify` 的 typecheck/unit/smoke/contract 覆盖本地协议契约；真实上游可用 `npm run upstream:matrix -- --apply` 另行确认。

#### 5. `/v1/embeddings` unsupported endpoint error contract — closed
- **2026-06-19 状态**：embedding 端点仍未实现，但 `/v1` catch-all 已返回 JSON：`invalid_request_error` + `endpoint_not_implemented`。OpenAI SDK 不再因为 HTML body 抛 JSON parse error。
- **后续注意**：是否实现真正 embedding provider 属于新能力，不是稳定性缺陷。

#### 6. rate-limit 默认 disabled — intentional default
- **2026-06-19 状态**：默认关闭仍保留，原因是当前部署定位为内网自用 + API key 限制，避免给个人自动化管线增加默认误伤。
- **安全边界**：如果暴露到公网、多人共享或无法信任客户端，应在 `config.yaml` 显式开启 `rate-limit.enabled=true`，并设置每 key 的窗口/请求上限。

#### 7. cloaking billingHeader build hash stability — closed
- **2026-06-19 状态**：billing build hash 已变成稳定配置/默认值，避免每次请求生成新的 `cc_version` suffix。payload 相关的 `cch` 仍然按请求内容变化。

### P2 — 监控 / 可观测

| 问题 | 2026-06-19 状态 | 后续动作 |
|---|---|---|
| `/admin/accounts` provider status visibility | **closed**：响应现在包含 `server` readiness、`claude` 和 `codex`；`accounts` 数组仍只代表 Claude OAuth account pool | 若未来 Codex 支持多账号，再设计独立账号池结构 |
| cache usage aggregation | **closed**：`UsageTracker` 已聚合 cache creation/read/hit rate，`/monitor` 与 admin usage 已展示 | 继续用 smoke/admin-usage 测试防回归 |
| stderr log 无 rotate | **mitigated**：已有 `scripts/ccpa-log-maintenance.sh`，healthcheck 可通过 `CCPA_HEALTHCHECK_MAINTAIN_LOGS=true` 在 canary 前执行；本机与 50.9 外部 healthcheck wrapper 均已接仓库脚本 | 若公网化再考虑系统级 logrotate/newsyslog |

### P3 — 边缘 / 体验

| 问题 | 2026-06-19 状态 | 后续动作 |
|---|---|---|
| codex stream 不支持 image_generation `partial_image` 流式渲染 | **closed**：chat/responses stream 已保留/转换 image partial，并对 partial/done 重复图片去重 | 真图片质量仍建议用 `/v1/images/generations` 或专门图片 provider 验收 |
| `store=false` hardcode | **closed**：`codex.store` 已进入配置，客户端显式 `store` 优先 | 保持默认 false，除非明确要让 Codex 上游存储 |
| `--login` 必须显式 `export HTTPS_PROXY` | **closed**：Codex login 子进程已从 LaunchAgent plist `EnvironmentVariables` 读取 proxy env fallback，shell 显式 env 优先 | 换机器部署时检查 plist/env 是否和代理端口一致 |
| codex `tool_choice` 字符串 passthrough 未验证 | **closed**：本地校验已拒绝非法 `tool_choice`，合法字符串按 OpenAI 兼容语义转换 | 新增 tool 类型时扩展目标测试 |
| codex 上游 401 时无 refresh | **closed**：Codex chat/responses/images 三条路径已接入一次性 auth cache invalidation/reload/retry | 仍依赖 Codex CLI 或用户登录态能刷新 `~/.codex/auth.json` |

### P4 — Nice-to-have（暂无需求别先做）

- **多 endpoint**：Anthropic OAuth + OpenAI Platform key + Azure 三套 token 并存，按 model prefix 二级路由。需要重写 provider 注册 + 一份 routing-table。**1 天**。
- **prompt cache 跨进程持久化**：把 cache id / TTL 落 redis 或 sqlite，重启复用。Anthropic 端的 cache 本就有 5min TTL，价值有限。**1 天**。
- **batch API**：`/v1/batches` 端点 + 文件存储，给老外管线批量翻译用。**1-2 天**。
- **`/v1/audio/transcriptions`**：codex 路径塞 whisper-1（如果 OpenAI 订阅范围允许）。**半天**。
- **WebSocket realtime**：等 gpt-5.5-realtime 上线再说，现在白搭。**未估**。

### Roadmap 建议执行顺序

1. **发布整理与 review handoff** — 当前候选集已经较大，先用 `npm run release:readiness -- --list` 固化范围，并用 `npm run release:readiness -- --write-json /tmp/ccpa-release-readiness.json` 留一份机器可读 handoff manifest，再让 Claude/Codex review 一轮，避免长期脏树继续扩大。
2. **真上游矩阵验收** — 默认只跑 `npm run upstream:matrix` dry-run；需要花额度确认时，再显式执行 `npm run upstream:matrix -- --apply`，图片另加 `--include-image`。
3. **发布归档 / commit / PR** — 本机与 50.9 已能过 no-upstream release gates，下一步要把当前候选集变成可 review、可回滚的一组提交或 PR。
4. **可选新能力** — embeddings、batch、audio、realtime 都属于新产品面，不再混在稳定性修复清单里。

P4 的 nice-to-have 等真有业务需求再启动，不要无脑提前写。

<details><summary>本节事实验证命令（粘贴重跑可核对）</summary>

```bash
ls /Users/wy/auth2api/src/accounts/manager.ts /Users/wy/auth2api/src/providers/claude.ts /Users/wy/auth2api/src/providers/codex-request.ts /Users/wy/auth2api/src/proxy/cloaking.ts /Users/wy/auth2api/src/config.ts
curl -s http://127.0.0.1:8317/v1/embeddings -H 'Authorization: Bearer sk-...' -H 'Content-Type: application/json' -d '{"model":"text-embedding-3-small","input":"hello"}' -i
curl -s -X POST http://127.0.0.1:8317/v1/responses -H 'Authorization: Bearer sk-...' -H 'Content-Type: application/json' -d '{"model":"gpt-5.5","input":"hi","stream":false}'
curl -s http://127.0.0.1:8317/admin/accounts -H 'Authorization: Bearer sk-...'
grep -c refresh /tmp/ccpa.stderr.log
wc -l /tmp/ccpa.stderr.log
ls -la /tmp/ccpa.stderr.log /tmp/ccpa.stdout.log
grep -n 'tool_choice\|store' /Users/wy/auth2api/src/providers/codex-chat.ts
grep -n 'HTTPS_PROXY\|--login' /Users/wy/auth2api/src/index.ts
grep -n 'rate-limit\|rateLimit\|rate_limit' /Users/wy/auth2api/src/server.ts
```

</details>

---

## 9. 附录：文档校对备忘 — 待补 / 待修

这份文档由 8 个并行 agent 撰写、8 个 adversarial verifier 审过。下面记录 verifier 找到的事实疑点 + 缺漏 topic + 风格问题，作为接手者继续完善的 backlog。**对较大的事实分歧或需要现场重新验证的，集中在此处。**

### 9.1 总览与架构拓扑（verifier 评分 7/10）

**事实疑点**：

- 声明：这台机器 auth2api 不是 git repo（在「编译产物 dist/ 而非 ts-node runtime」段说「备份命名约定…让回滚不靠 git（这台机器 auth2api 不是 git repo）」）
  - 问题：实际跑 git status 与 git log 都正常工作；/Users/wy/auth2api/.git 存在，有完整 commit 历史（最新 commit: 7915477 'feat: add browser monitor dashboard'），还配了 3 个 remote（ccpa/fork/origin）。当前在 main 分支跟踪 ccpa/main。
  - 修正：把'这台机器 auth2api 不是 git repo'整句删掉；'备份命名约定让回滚不靠 git'若想保留，要重写成原因别的（比如热修要快速回滚不想 git commit pollute history）
- 声明：refresh 失败有指数 backoff 60s→30min（2026-06-09 加的，避免 401 风暴打爆 OAuth endpoint）
  - 问题：git log src/accounts/manager.ts 只有一个 commit（a58ccc0 'Add single-account proxy hardening and smoke tests' 3 个月前），REFRESH_FAIL_BASE_MS/REFRESH_FAIL_MAX_MS 是当初引入的，不是 2026-06-09 加的。今天日期是 2026-06-09，文件里 2026-06-06 的 PATCHED 注释是另一处改动（refresh 失败不再冷却账号），跟 backoff 无关。
  - 修正：「2026-06-09 加的」整段删掉，或改写成「refresh 失败有指数 backoff 60s→30min（manager.ts:11-12），失败 1→60s,2→2min,…封顶 30min；2026-06-06 另加 PATCHED 让 refresh 失败不再冷却账号」
- 声明：providers/claude.ts:32 ClaudeProvider.handleChatCompletions
  - 问题：claude.ts:32 是构造函数里的 `this.chatHandler = createChatCompletionsHandler(this.config, this.manager);`，handleChatCompletions 方法本身在 line 81-83。在生命周期图中标 'ClaudeProvider.handleChatCompletions providers/claude.ts:32' 行号错。
  - 修正：改为 'ClaudeProvider.handleChatCompletions providers/claude.ts:81'，或者改用构造函数实际行号并改文字 'ClaudeProvider 构造期装载 chatHandler providers/claude.ts:32'
- 声明：claude-api.ts (86 行)
  - 问题：wc -l 实测是 85 行，不是 86。
  - 修正：改 '85 行'
- 声明：passthrough.ts (~330 行)
  - 问题：wc -l 实测 291 行。'~330' 偏大不止 10%。
  - 修正：改 '~290 行' 或 '291 行'
- 声明：CORS (localhost only)           server.ts:154-167
  - 问题：CORS 中间件实际从 line 153 (LOCALHOST_RE 常量声明) 开始；如果只算 app.use(...) 则是 155-167。154 不是任何边界。
  - 修正：改 'server.ts:153-167' 或 '155-167'
- 声明：codex-upstream.ts 1-34 / providers/codex-upstream.ts:13 callCodexResponses（在请求生命周期图里）
  - 问题：文件总行数是 45 不是 34。file_refs 写 codex-upstream.ts:1-34 漏掉了第 13 行 callCodexResponses 之后的实现细节和 isTransientFetchError/delay 这两个函数。
  - 修正：改 file_refs 的 codex-upstream.ts:1-34 为 codex-upstream.ts:1-45；正文 line 13 引用正确不用动
- 声明：Stainless headers (X-Stainless-Runtime=node, User-Agent=claude-cli/2.1.63)
  - 问题：User-Agent 不是 Stainless header；Stainless 系列前缀都是 X-Stainless-*。User-Agent 是单独的 header，应分开描述。
  - 修正：改 'User-Agent=claude-cli/2.1.63 加 Stainless headers（X-Stainless-Runtime=node 等 8 个 X-Stainless-* 头）'

**缺漏 topic（建议下一轮补）**：

- Anthropic-Beta header 实际值（5 个 flag：claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, context-management-2025-06-27, prompt-caching-scope-2026-01-05），现在简写为'claude-code/oauth/cach
- config.yaml 关键字段默认值（port 8317, body-limit 200mb, cloaking.mode auto, timeouts.messages-ms 120000 默认/600000 当前生效）— 既然章节叫'总览'，配置全景应该有一节
- /v1/responses 端点（responses.ts 624 行是仅次于 dashboard 的最大文件）section 完全没提，只提 /v1/chat/completions 和 /v1/messages
- /v1/images/generations 端点（codex 独有，model 默认 gpt-image-2）只在模块分层里露了一行没解释
- /admin/* 端点（/admin/accounts /admin/usage /admin/usage/recent）和 /monitor dashboard 缺失，做'总览'应该列全
- rate-limit 配置（默认 enabled=false，window-ms 60000，max-requests 60）只说'disabled default'，配置全貌缺
- package.json 关键信息：'auth2api' 1.1.0、main=dist/index.js、Node 依赖（express 4.21 / undici 7.25 / js-yaml / uuid），有助读者校准技术栈
- launchd plist 集成（com.wy.ccpa，KeepAlive，HTTPS_PROXY=http://127.0.0.1:6152，NO_PROXY=localhost,127.0.0.1,::1,.local 在 plist 而非代码读）— 既然提了'改 proxy 端口只改 plist'，plist 路径和关键 envvar 应该列出

**风格 / 表述问题**：

- '当前用户：本机老登写作 / 老外看中国管线 / 选题候选生成、50.9 上的 podcast pipeline' 在 OPS GUIDE 概述里太私人化，发布给读者不好读；可挪到 deployment 章节或脚注
- '当前用户' '当前 8 alias hardcode' 等措辞带时间戳但不写日期，未来读起来歧义；改成 '截至 2026-06-09' 或落到具体 commit
- '业务全部已切 thu 主线（clade_safe_thu.py），CCPA 当兜底；恢复 health 后可切回' — 这是 caller 侧策略，不该在 CCPA 总览章节抢戏；应该挪到独立章节或脚注
- 'codex 路径同构但更简单' 这种'同构但'的对照表达式可以更具体，直接列「codex 跟 claude 路径少了：① 多账户 manager / cooldown ② OAuth refresh ③ cloaking」
- ASCII tree 里 'src/index.ts:8 ProxyAgent → setGlobalDispatcher' 的行号写在节点旁不一致（其他节点写 server.ts:138/154 一致风格），建议统一
- '抉择'章节四条 bullet 前三条说理充分，第四条 'HTTPS_PROXY 走环境变量而非 config.yaml' 多重否定（NO_PROXY=localhost 确保 callback-server 不绕回去）读起来绕；可改为'HTTPS_PROXY 走环境变量（plist 的 EnvironmentVariables）—— 改 proxy 端口不重 build；同时 NO_PROXY
- '路径 fetch() → undici ProxyAgent (HTTPS_PROXY=http://127.0.0.1:6152)' 端口 6152 是 Surge 默认 HTTP 端口的硬编码，在概览里出现得突然，可挪到 '抉择' 或 deployment 章节

### 9.2 部署清单（本机 + 50.9）（verifier 评分 7/10）

**事实疑点**：

- 声明：50.9 `config.yaml` 关键字段 ... `codex.models: gpt-5.4`（白名单短）
  - 问题：实际 50.9 `~/ccpa/config.yaml` 里 `codex.models` 有 4 个：`gpt-5.4`、`gpt-5.5`、`gpt-5.4-mini`、`gpt-5.2`。而本机 `~/auth2api/config.yaml` 只有 3 个（`gpt-5.4`、`gpt-5.5`、`gpt-image-2`）。所谓「白名单短」事实上反了——50.9 比本机更长，且本机独有 `gpt-image-2` 而 50.9 没有。
  - 修正：改成：50.9 `codex.models: [gpt-5.4, gpt-5.5, gpt-5.4-mini, gpt-5.2]`；本机 `codex.models: [gpt-5.4, gpt-5.5, gpt-image-2]`。两边并集不一致是已知静默降级踩坑点（参见 memory `feedback_ccpa_silent_downgrade.md`），尤其本机能跑 `gpt-image-2`、50.9 不能；50.9 能跑 `gpt-5.4-mini`/`gpt-5.2`、本机不能。
- 声明：对比表里没列 `codex.models` 白名单这一行
  - 问题：这是两边最容易踩坑的差异（model 静默降级），用户私人 memory 里专门拎过；只列 host/port/api-key 而漏掉 models 白名单，对比表的核心价值受损。
  - 修正：在对比表里加一行：`codex.models | 本机: gpt-5.4, gpt-5.5, gpt-image-2 | 50.9: gpt-5.4, gpt-5.5, gpt-5.4-mini, gpt-5.2`。
- 声明：`src/auth/token-storage.ts:5-15` 把 ... `tokenToStorage` 把 ... 映射成磁盘 `TokenStorage`
  - 问题：`tokenToStorage` 函数实际是 5-14 行（return 对象结束于 13、闭花括号 14），`storageToToken` 在 16-23 行。section 在 file_refs 里也声明了 5/17/25 三个锚点，但正文写「5-15」横跨了一个空行 15，没准确指到任一函数。
  - 修正：改成 `src/auth/token-storage.ts:5-14`（tokenToStorage）和 `:16-23`（storageToToken），分别指。
- 声明：Codex token ... 由 codex CLI 自己维护，CCPA 在 `src/providers/codex-auth.ts` 只读不写，401 时不主动 refresh
  - 问题：前两个结论正确（只读、不写），但「401 时不主动 refresh，依赖 codex CLI 续期」这一句源代码没直接支撑——`codex-auth.ts` 只负责读快照，没有 401 处理逻辑；401 行为在 `codex.ts`/`codex-chat.ts`/`codex-upstream.ts` 等。section 把 401 的责任完全归到 codex-auth.ts 这一个文件容易误导读者去翻错文件。
  - 修正：改成：「`codex-auth.ts` 只 `load()` 读快照、不写；401 后是否 retry/refresh 看 `src/providers/codex.ts` 等上层 provider，目前没有主动 refresh 逻辑，依赖 codex CLI 后台续期 `~/.codex/auth.json` 后下次请求重新 load。」并补 file_ref。
- 声明：`6152` 是 Surge 本机的 HTTP 代理端口（今天才从误写的 `8234` 改回来）
  - 问题：port 数字本身没法用本仓库代码验证（只能 plist 自证 6152 这一项已生效），「今天才从 8234 改回来」是 session 内的口述历史，没有任何 git/log/plist 证据；如果有人六个月后翻这份文档，会困惑「8234 是怎么回事」。
  - 修正：删掉「（今天才从误写的 8234 改回来）」这种 ephemeral 注释，或者放进单独的「踩坑历史」段。正文留事实：`HTTPS_PROXY=http://127.0.0.1:6152` 是 Surge 默认 HTTP proxy。
- 声明：本机 stderr ... 是今天加的 backoff 在工作（`src/accounts/manager.ts` REFRESH_FAIL_BASE_MS）
  - 问题：REFRESH_FAIL_BASE_MS 在 `manager.ts:11`，REFRESH_FAIL_MAX_MS 在 `:12`，backoff 计算在 `:260-264`，错误日志在 `:268`。section 只笼统点了「manager.ts」没给行号，但 file_refs 里只声明了 `manager.ts:67`——67 这一行跟 REFRESH 完全无关。
  - 修正：file_refs 把 `src/accounts/manager.ts:67` 改成 `:11`（REFRESH_FAIL_BASE_MS 常量）或 `:260`（backoff 计算）。

**缺漏 topic（建议下一轮补）**：

- 对比表漏列 codex.models 白名单差异（本机有 gpt-image-2 50.9 没有，50.9 有 gpt-5.4-mini/gpt-5.2 本机没有）——这是 silent downgrade 最常见的根因
- 本机 git status 有大量 modified（README/config.example/src/proxy/ 等都改了未 commit），section 只说『今天还没 commit』，没说『50.9 的 dist 是 14:58 本机 build 后 scp 过去的，但本机 src 还在动』——意味着两边 binary 同源、src 不同源；运维时容易踩
- 两边 token 文件用同一 email 这条说了，但漏说『access_token/refresh_token 内容是否同步』——实际两边各自跑各自 refresh，磁盘文件内容大概率不同；现在的描述容易让人误以为是软链/同步
- 本机 stderr 现在的 oauth refresh failure 来源——没说是 6152 (Surge) 出站失败、还是 anthropic.com 那头拒了。`fetch failed` 是 undici 没透露细节的标准报错，给读者一个排查方向更稳
- 健康检查 endpoint 只列了 /health，没提其他常用的 /v1/models / /v1/messages / 监控页面 /monitoring/dashboard——监控页面正是 HEAD `7915477 feat: add browser monitor dashboard` 引入的
- 本机 plist 没有 ThrottleInterval/Umask，50.9 plist 有；对比表也漏了这两项

**风格 / 表述问题**：

- 『下面给你两边的全部路径事实，再用对比表把差异一次说清』属于元描述/铺垫废话，删掉直接进事实
- 『（注意是 ccpa/ 不是 auth2api/）』『（注意是 0.0.0.0 不是 127.0.0.1，所以局域网可达）』这两个『注意』口播感，删括号直接放在表里更清爽
- 『（今天才从误写的 8234 改回来）』『（已知问题）』这种 session-ephemeral 注释不适合放在长期参考文档里，会让半年后的读者困惑
- 结尾段『两边 token 文件用同一个 Claude 邮箱：业务上是同一订阅、各自跑 refresh、互不知道对方』表达可以更紧——『同 email、各自 refresh、不互相同步，一边把 refresh_token 用废、另一边下次 refresh 也挂』一句话讲清
- 对比表里 `Git remote` 写「`ccpa` + `fork` + `origin` 三个」对应不上下面正文里说 origin 是『fork 上游 AmazingAng/auth2api』——读者会迷糊到底 fork 和 origin 谁是谁，需要在表里直接标注 remote 名 → URL

### 9.3 端点参考（verifier 评分 7/10）

**事实疑点**：

- 声明：CCPA 在 `127.0.0.1:8317` 暴露 9 个公开端点 + 3 个 `/admin` 端点
  - 问题：实际只有 8 个公开端点：POST /v1/chat/completions, /v1/responses, /v1/images/generations, /v1/messages, /v1/messages/count_tokens, GET /v1/models, /health, /monitor。section 自己列出来也只是 8 个 + 一个明确不存在的 /v1/embeddings。`server.ts:193-269` 注册的就是 8 个。Admin 端点 3 个正确。
  - 修正：改成 `8 个公开端点 + 3 个 /admin 端点`，或者把 /v1/embeddings 单独说明不算公开端点。
- 声明：`prompt_tokens_details.cached_tokens` 是 2026-06-09 新加的，从 Claude 的 `cache_read_input_tokens` 提取（`src/proxy/translator.ts`）
  - 问题：`git log -S 'prompt_tokens_details'` 显示是 commit 7b45925（2026-04-10 "Refactor/restructure and api fixes (#13)"）引入的，不是 2026-06-09。
  - 修正：去掉 "2026-06-09 新加的" 这个具体日期，或改成 "2026-04-10 引入"。最稳：直接说 "OpenAI 兼容的 cached_tokens 已暴露在 prompt_tokens_details 下"。
- 声明：POST /v1/messages：注意要带 `anthropic-version` header（`callClaudeAPI` 内部固定 `2023-06-01`）
  - 问题：两句话自相矛盾。`claude-api.ts:26` 在 `buildHeaders` 里硬编码 `Anthropic-Version: 2023-06-01`，而 passthrough.ts 调用 `callClaudeAPI` 时不传客户端原 header（`callClaudeAPI(account.accessToken, claudeBody, stream, ...)` 签名里没 headers）。实测 curl 不带 anthropic-version header 也能正常调通（已验证返回完整消息）。客户端 send 与不 send 都没区别。
  - 修正：改成 "CCPA 内部固定加 `Anthropic-Version: 2023-06-01`，客户端可不带（带了也会被忽略）"。
- 声明：CCPA 在 `127.0.0.1:8317` 暴露
  - 问题：config.yaml `host: "0.0.0.0"`，server 实际监听所有 interface（0.0.0.0:8317）。127.0.0.1 只是其中一种访问入口。在 LAN 上别的机器也能直连。
  - 修正：改成 "监听 0.0.0.0:8317（本机可走 127.0.0.1，LAN 内可走真实 IP）"，或者说明这是 config 默认。
- 声明：/admin/usage/recent — 最近 N 条请求的 detail
  - 问题：实际响应不是裸数组，是 `{items: [...]}` 包了一层（实测：`{"items": [{"id": 45, "timestamp": ..., "failureContext": null}, ...]}`），客户端要 `.items` 取数组。每条 item 还有 `id, timestamp, provider, endpoint, model, statusCode, success, stream, latencyMs, inputTokens, outputTokens, totalTokens, failureContext`，section 完全没列。
  - 修正：补响应形状 `{items: [{id, timestamp, provider, endpoint, model, statusCode, success, stream, latencyMs, inputTokens, outputTokens, totalTokens, failureContext}]}`。
- 声明：/admin/usage 响应 `{totals: {totalRequests, inputTokens, outputTokens, ...}, providers: {claude: {...}, codex: {...}}}`
  - 问题：漏了顶层第三个 key `endpoints`（每个 endpoint 的 totalRequests / inputTokens / outputTokens / ... 聚合）。也漏了 `totals` 里的 `successCount, failureCount, totalTokens, lastRequestAt`，以及 `providers` 里可能出现的 `unknown` 兜底 bucket。
  - 修正：改成 `{totals: {totalRequests, successCount, failureCount, inputTokens, outputTokens, totalTokens, lastRequestAt}, providers: {claude, codex, unknown}, endpoints: {<endpoint>: {...}}}`。
- 声明：/health 和 /monitor 不要 key（`src/server.ts:189-190` 注册顺序）
  - 问题：189-190 是 `app.use("/v1", requireApiKey); app.use("/admin", requireApiKey);` —— 这是 path-prefixed middleware，不依赖注册顺序。/health 和 /monitor 不要 key 是因为它们的 path 不以 /v1 或 /admin 开头，跟注册顺序无关；就算 /health 注册在 189-190 之前也照样不要 key。
  - 修正：改成 "/health 和 /monitor 不要 key —— `requireApiKey` 中间件只挂在 /v1 和 /admin 路径前缀上（server.ts:189-190）"。

**缺漏 topic（建议下一轮补）**：

- /v1 上挂的 rate-limit 中间件（server.ts:169-171 + 26-62），如果 config.rate-limit.enabled=true 会按 IP 限流，超限返 429 `{error: {message: "Too many requests"}}`，跟 401/403 是不同形状的 error 包
- CORS 限制：只接受 origin=localhost/127.0.0.1（server.ts:154-167），LAN 上其它机器虽然能连但浏览器跨域会被卡
- POST /v1/responses 流式：CCPA 不管客户端 stream=false/true，对 codex 上游永远是 stream=true（codex-responses.ts:98-101），非流式客户端会从 SSE 聚合（collectCodexResponseFromSse）再回包
- 正常 chat.completions 响应里 usage 还有 `cache_creation_input_tokens` + `cache_read_input_tokens` 两个 Claude 原生字段（translator.ts:253-254），section 只提了 prompt_tokens_details.cached_tokens
- /v1/messages 错误形状用 `type: "invalid_request_error" | "api_error"`（passthrough.ts），跟 chat completions 走的 `upstream_error` 不一样；section 通用错误形状段把 type 列错了
- GET /admin/accounts 里 codex 子对象的字段：`authMode, accountId, lastRefresh, path` 等，对排查 codex auth 问题很关键

**风格 / 表述问题**：

- "OpenAI 标准是允许 string 的，CCPA 当前不兼容" 后面又写 "要么客户端自己包成"，但 "要么" 后面只给了一个选项，没有第二个选项配对——句式没收住
- "实测 11 条全列出，详见'模型'section" —— 引用了一个本文档没出现的章节名（"模型" section）
- 鉴权速记里 "两种都给 Claude Code 客户端和 OpenAI SDK 用同一份 api-key 走通" 有点别扭，建议改成 "Claude Code 客户端用 x-api-key、OpenAI SDK 用 Authorization: Bearer，CCPA 都认"
- 通用错误形状里 "claude 路径：`{error: {message, type: "upstream_error"|"api_error"}}`" 表述偏概括，实际 chat completions 用 upstream_error、messages 用 api_error / invalid_request_error，应该分开说清楚否则读者会误判要 catch 哪个 type
- "DALL-E 兼容" 用语过宽——/v1/images/generations 只对得上 OpenAI 的 Images API 形状，跟 DALL-E 模型语义没关系（实际后端是 gpt-5.5 + image_generation tool）

### 9.4 模型矩阵与路由（verifier 评分 7/10）

**事实疑点**：

- 声明：路由规则代码注释里说 "其它 → null（404 unsupported_model）"
  - 问题：实测 curl 不存在的 model 返回的是 HTTP 400 不是 404。src/server.ts:106、133、223 三处全部 `res.status(400).json(...)`，error body 是 `{"error":{"message":"Unsupported model: <name>"}}`。我跑 `curl -w '%{http_code}' ... -d '{"model":"nonexistent-model-xyz",...}'` 直接拿到 `400`。
  - 修正：把 "404" 改成 "400"，例如 "其它 → null（400 Unsupported model）"。后面 "否则 router 会 404" 那句也得同步改成 "400"。
- 声明：stream 抽测里 "再下来 `data: [DONE]`（codex 路径）或直接关流（claude 路径）"，即声明 claude 路径流式响应不发 [DONE] 直接关流
  - 问题：实测 claude 路径也发 `data: [DONE]\n\n` 后才关流。hexdump 显示 claude-haiku-4-5 stream 末尾字节是 `...}}\n\ndata: [DONE]\n\n`，跟 gpt-5.5 完全一样。另外 claude 路径的倒数第二个 chunk 还带 `usage` 字段（含 prompt_tokens/completion_tokens/total_tokens/cache_creation_input_tokens/cache_read_input_tokens），不是只有 codex 才有。
  - 修正：改成 "两条路径都以 `data: [DONE]` 收尾；最末一条带 usage 的 chunk 之后才发 [DONE] 然后关流"。claude 那条 usage 还多带 cache_creation_input_tokens / cache_read_input_tokens，值得一起提。
- 声明：file_refs 里 `config.yaml:22-29` 指向 codex 块
  - 问题：config.yaml 总共 30 行，codex 块实际是 22-28 行（line 28="- gpt-image-2"，line 29 是空行，line 30 是 `debug: "off"`）。引文 yaml 块本身也只截到 line 28。
  - 修正：把范围改成 `config.yaml:22-28`。

**缺漏 topic（建议下一轮补）**：

- /v1/messages 这个 Anthropic 原生端点上各 model 的支持情况（claude.ts:89 有 messagesHandler，文档只提了 /v1/chat/completions 和 /v1/images/generations）
- router.ts:24 的 /^o\d/ 规则——o1/o3/o4 这类裸名会被判为 codex，但只有同时在 config.yaml 的 codex.models[] 里才真正可用，否则照样 400；当前文档完全没提这条捷径
- 400 错误体的具体形状（{error:{message:'Unsupported model: X'}}），方便业务方写错误处理

**风格 / 表述问题**：

- 开头 "下表把每个 model 的上游、用途、能力位都标清楚（cache 列特指 prompt caching；codex 路径没启用 cache_control，所以全 N）" 是 meta 描述，可直接删掉，让表自己说话
- 表里 `opus`/`sonnet`/`haiku`/`claude-haiku-4-5` 几条 alias 行的 "用途/tools/stream/caching" 列重复了它们解析后的真名行——已经在 "alias 等价" 列点明指向，这几列写 "同上" 或干脆只列 5 个真名 + 一列别名更紧凑
- 末尾 "声明的 file refs / 声明跑过的命令" 两块明显是 audit metadata，不该出现在交付文档里，发布前必须删
- "加新模型" 小节最后那句 "CCPA 不校验，写错了请求时上游会 400/404" 跟上面 router 部分的 "404" 错误纠缠在一起，纠完后这句也得对齐：codex 上游错误其实是 400 invalid_model（auth2api 会把上游 status 透传出来）
- 实测验证表的 latency 是单次抽样，没说样本数；可加一句 "单发，未求平均，仅作可用性验证" 防误读

### 9.5 业务集成范例（verifier 评分 7/10）

**事实疑点**：

- 声明：manager.ts:67 是单账户硬约束的位置（错误处理表里 429 行写 '单账户硬约束（manager.ts:67）'）
  - 问题：/Users/wy/auth2api/src/accounts/manager.ts:67 实际是 'private refreshTimer: NodeJS.Timeout | null = null;'，纯字段声明，跟单账户约束无关。真正的 single-account 检查在 line 76-78（throw new Error('Single-account mode only supports one token in ...')）。
  - 修正：把 manager.ts:67 改为 manager.ts:76-78，或者改写成 'single-account mode 在 load() 里硬卡（manager.ts:76-78）'
- 声明：错误处理表里 'stream 永远不返回' 行写 '根因 = httpx 默认无超时'
  - 问题：httpx 实测默认 timeout=5.0s（httpx.Client() 默认 Timeout(5.0)），并不是无超时；这跟 requests 库（确实无默认超时）搞混了。section 自己的 chat_once 代码也设了 connect=15/read=180，能看出来作者知道 httpx 有默认值。
  - 修正：改成 '根因：httpx 默认 5s 超时对 stream 不够、上游 socket 死后 read 仍可能 hang' 或 '默认 5s connect/read 超时对长 stream 不够，必须显式调大 read=120'
- 声明：file_ref 写 /Users/wy/auth2api/src/proxy/translator.ts:1 来支撑 'cache 命中字段（translator.ts 今天加的）'
  - 问题：translator.ts:1 是 'import { v4 as uuidv4 } from "uuid"'，跟 cache 字段无关。真正实现 cache_creation_input_tokens / cache_read_input_tokens / prompt_tokens_details.cached_tokens 在 translator.ts:228-254（claude → openai 转换路径）和 translator.ts:361-371（stream usage 转换）。
  - 修正：把 translator.ts:1 改成 translator.ts:228-254 或 translator.ts:228-254 + 361-371

**缺漏 topic（建议下一轮补）**：

- 代码示例里曾 hardcode 真实 api key，作为对外文档（即使内部）建议统一改成 `sk-XXX` 占位 + 注明 '从 ~/auth2api/config.yaml api-keys[0] 读取'，避免随手 copy 流出仓库
- section 完全没提 /v1/models 端点（实测 11 个 model：5 个 claude alias、3 个短别名 opus/sonnet/haiku、gpt-5.4、gpt-5.5、gpt-image-2），业务侧做模型探测要用
- reasoning_effort / thinking 参数（translator.ts:21-23 EFFORT_TO_BUDGET：none/low/medium/high/xhigh→0/1024/8192/24576/32768）业务侧怎么传没提，opus 走 thinking 是常见场景
- ccpa 没有 anthropic 原生 /v1/messages 端点的提及（section 默认所有人都用 openai 兼容接口，但 ccpa 实际同时支持 anthropic 原生 schema，对接 SDK 时可以选）
- ccpa 错误返回 SSE 还是 JSON 的区分（stream=true 时 error 是 'event: error\ndata: {...}'，section 的 chat_stream 没处理 error 事件，遇到 401/429 会被静默丢掉）

**风格 / 表述问题**：

- 开头 'CCPA 对外就是一个 OpenAI 兼容的 HTTP endpoint，所以业务侧能用的姿势就三套' 略口语化堆叠 ('就是一个'/'就三套'), 'just one short opening claim' 也行
- section 编号写到 6 但开头说 '下面四种是已经在管线里跑通的写法'，4 跟 6 对不上（5 是 clade_safe_thu 历史说明、6 是错误处理表）, 改成 '下面几种' 或编号调整
- 第 4 节 'Image generation 三种触发方式' 跟全篇 'CCPA 业务集成' 主线弱相关 — image gen 已经在 CLAUDE.md 默认走豆包，section 自己也承认 'ccpa 的 gpt-image-2 当 codex 订阅顺路出图用'，篇幅可以砍一半只留 (a) 显式端点 + 一句 '中英文自然语言也能触发 image_generation tool 自动注入
- 第 5 节 'clade_safe_thu 兜底机制为什么仍保留' 是历史/策略叙事，跟 '业务集成范例' 的功能定位不一致 — 应该挪到单独的 '运行时策略' 或 'fallback 设计' 章节
- 代码块里曾出现真实 `sk-*` key，已统一脱敏成 `sk-XXX`；后续不要把真实 key 写进文档。
- 'http_client 要传 trust_env=False 否则 SDK 默认从环境读 HTTPS_PROXY，跟 ccpa 本机 LaunchAgent 注的 Surge proxy 重复套娃' — '套娃' 表述含糊，准确意思是 '业务进程的 HTTPS_PROXY → Surge → ccpa(127.0.0.1)，但 127.0.0.1 走 proxy 没意义且会被 Surge 反弹回
- 错误处理表 503 行 'manager.ts REFRESH_FAIL_BASE_MS 60s→30min' 准确但跟 503 现象的关联弱（REFRESH_FAIL 是 oauth refresh 失败的退避，不是请求 503 的退避；503 现象对应的是 FAILURE_BACKOFF.rate_limit/server 的 baseMs/maxMs，在 manager.ts:16-22），

### 9.6 运维 Runbook（verifier 评分 7/10）

**事实疑点**：

- 声明：Section 4 步骤说『停 ccpa 释放 54545 端口』再跑 `--login --manual`
  - 问题：查 src/index.ts:43-68 和 src/auth/callback-server.ts:62，`--manual` 模式下 *不会* 启动本地 callback server (port 54545 只在自动模式的 waitForCallback() 里 listen)。ccpa 主进程也不监听 54545。所以 manual 模式下根本无端口冲突，停 ccpa 不是为了『释放 54545』而是因为 manual 模式仍然需要 manager.load() 写 token 文件——但如果不停 ccpa，单账号模式下 addAccount 仍会工作（同 email 时直接覆盖 to
  - 修正：改成『停 ccpa（避免 auto-refresh 跟手动 login 抢同一份 token 文件）』；或者直接说『推荐先停 ccpa 避免读写竞争』。54545 端口冲突只在 `--login`（无 --manual）时才相关。
- 声明：Section 4 示例『浏览器跳转到 http://127.0.0.1:54545/callback?code=...』
  - 问题：src/auth/oauth.ts:6 写 `REDIRECT_URI = "http://localhost:54545/callback"`，redirect_uri 是 `localhost`（不是 `127.0.0.1`），浏览器会跳到 `http://localhost:54545/callback?code=...&state=...`。
  - 修正：改成 `http://localhost:54545/callback?code=...&state=...`。
- 声明：Section 3 admin/accounts 『看 cooldown / failureCount / nextRefreshAttemptAt』
  - 问题：查 src/accounts/manager.ts:43-57 的 AccountSnapshot 定义和实际 curl 输出，/admin/accounts 返回的字段只有 cooldownUntil/failureCount/lastError/lastFailureAt/lastSuccessAt/lastRefreshAt/totalRequests/totalSuccesses/totalFailures/expiresAt/refreshing。`nextRefreshAttemptAt` 只在内部 AccountState（line 40）使用，*不* 出现在 HTTP 响应里。
  - 修正：把 `nextRefreshAttemptAt` 去掉，或者改成『cooldownUntil / failureCount / lastError』。如果想看 refresh 退避就只能从 stderr `next attempt in Ns` 里看。
- 声明：Section 5 『ccpa 端不需要重启，CodexAuthStore 每次请求 re-read auth-file』
  - 问题：src/providers/codex-auth.ts:48-67 的 CodexAuthStore.load() 用 stat 比较 mtimeMs，**只有 mtime 变化才 re-read**，并不是『每次请求都 re-read』。如果 codex CLI 在原地写文件且 mtime 真的变了，是会被发现的；但说『每次请求都 re-read』在技术上不准确。
  - 修正：改成『CodexAuthStore 用 mtime 缓存，codex CLI 续期改动 auth.json 后下一次请求会自动 re-read，无需 ccpa 重启』。
- 声明：Section 5 救援只提了 `codex login` CLI
  - 问题：ccpa 自带 `--login-codex` 命令（src/index.ts:122, src/auth/codex-login.ts），内部 spawn `codex login`，可以直接 `cd ~/auth2api && node dist/index.js --login-codex` 不依赖外层 shell 的 codex CLI 安装路径。
  - 修正：加一行 `# 或在 ccpa 仓里 \n cd ~/auth2api && HTTPS_PROXY=http://127.0.0.1:6152 node dist/index.js --login-codex`。
- 声明：Section 6 错误模式映射『Rate limited on the configured account』根因写『上游 401/quota』
  - 问题：查 src/proxy/handler.ts:50-65 和 passthrough.ts:201-206，这条消息是 ccpa **在 cooldown 期间**返回的，HTTP 是 429（不是 401）。cooldown 触发原因是 *上游 429（rate_limit）或 401/403（auth/forbidden）* 任一种把账号扔进退避，根因不止 401。
  - 修正：改成『上游已 429 或被扣分进 cooldown（auth/forbidden/rate_limit 都触发）』，HTTP 状态 429。

**缺漏 topic（建议下一轮补）**：

- Codex 内置登录命令 `--login-codex`（src/index.ts:122）应替代外层 codex CLI 那段，统一在 ccpa 仓内操作
- 刚 OAuth 完之后第一次启动需要『检验 token 已写入』的最小测一遍（curl /v1/chat/completions 一发 ping）这步只在『改代码』节有，OAuth 节里漏了
- /monitoring dashboard 页（src/server.ts:6 + dashboard-page.ts）能在浏览器看实时 usage/cooldown，调试时比 curl /admin/accounts 直观，可以一句话提一下
- REFRESH_LEAD_MS=4h（manager.ts:5）这个 4 小时窗口的存在——『为什么 expired 还剩 4h 时就会触发 refresh』，否则用户看不懂为什么离过期还远就有 refresh failed
- node 二进制路径（本机用 nvm: /Users/wy/.nvm/versions/node/v22.14.0/bin/node；50.9 用 /opt/homebrew/bin/node）。改 plist/调试 path 时容易踩坑，section 只提了 50.9 那条

**风格 / 表述问题**：

- 开头『下面所有操作默认本机...50.9 段落标注』+『命令都在 2026-06-09 当前 token 状态下跑过一遍』属于元描述/自我证明话术，删掉直接给命令更利落
- Section 4 里『我刚看 stderr 就是这状态』『但当前 expired=... 还有 ~4h 才到，所以业务还能跑』夹杂了第一人称叙事，runbook 应保持指令式：把『此时业务还能跑、真过期才必须 oauth』提到段首作为判定条件即可
- Section 1『刚看到 PID 39642, ELAPSED 11:26, RSS ~50MB』 是当下快照数据，runbook 不该写死实时数据（下次跑 PID 变了反而误导读者），改成『典型输出形如 PID xxxxx, ELAPSED 几分钟, RSS ~50MB』
- Section 8 末尾『注意：codex-chat.ts 当前 md5 5c3fa713...已被覆盖』这段是对『背景文档』的元评注，不属于 runbook 本身，应该作为脚注或干脆删掉（如果背景文档已修就不必再说）
- Section 7/9『scp 单文件』和『50.9 同步回滚后的版本』高度重复——两段命令套路一样，可以抽个 helper 一句话或合并成一节

### 9.7 更新日志与备份清单（verifier 评分 8/10）

**事实疑点**：

- 声明：新 token 2026-06-09T11:36Z 起 8h 有效
  - 问题：Z 后缀严格表示 UTC。token 文件里 last_refresh=2026-06-09T03:36:15.044Z（=北京时间 11:36），expired=2026-06-09T11:36:15.042Z（=北京时间 19:36）。section 写的 11:36Z 实际上是 token 的过期时刻而不是签发时刻。正确的写法要么用本地时间（2026-06-09 11:36 北京时间起 8h 有效，至 19:36），要么 UTC 全程统一（03:36Z 起 8h 有效，至 11:36Z）。
  - 修正：改为「新 token 2026-06-09 11:36（本地）起 8h 有效，到期 19:36」或「03:36Z 起 8h 有效，到期 11:36Z」
- 声明：rebuild + restart 用 `launchctl kickstart -k gui/$(id -u)/com.wy.ccpa`
  - 问题：kickstart 命令本身没问题（实测 path=/Users/wy/Library/LaunchAgents/com.wy.ccpa.plist, label gui/503/com.wy.ccpa 都对），但 section 上下文里没提到必须先 `npm run build` 才会更新 dist/index.js（launchd 跑的是 dist 编译产物，不是 ts 源码）。回滚步骤里写了 `npm run build` 这一步，验证步只 curl /health 不能确保新代码真在跑——应当在 kickstart 之后多一步 grep 进程 mtime 或 /version。
  - 修正：在第 6 步前加 `ps -o lstart= -p $(pgrep -f 'auth2api/dist/index.js')` 或检查 dist/index.js 的 mtime 晚于 build 时间，确认 launchd 真的拉到了新编译产物。

**缺漏 topic（建议下一轮补）**：

- 升级前需要的最小冒烟测试：除了 /health，应该列一条 `curl -sS -X POST http://127.0.0.1:8317/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"claude-opus-4-8","messages":[{"role":"user","content":"ping"
- 如何区分 working tree 改动与 6/6 backport：`git diff HEAD -- src/accounts/manager.ts src/providers/codex-chat.ts src/providers/codex-sse.ts src/proxy/translator.ts` 能直接看到「真正变了多少行」，section 提到 next sync 前要留 pat
- untracked .bak 文件（`src/providers/codex-chat.ts.bak-pre-merge-2026-06-09` 和 `codex-sse.ts.bak-pre-merge-2026-06-09`）会出现在 `git status` 里——是否要加入 .gitignore 或要单独 stash，回滚流程没说

**风格 / 表述问题**：

- 「6/6 patches 起源」整段跟 changelog 表第二行/第三行严重重叠，cooldownfix 和 toolsfix 的修法描述被分别叙述了两遍，建议起源段只保留 MEMORY 关联和因果链，把「修法 =」那两句删掉
- 「按动手时间排序（备份文件 mtime 是最可靠的时间锚点）」是元描述/自我说明，删掉直接给表更直接
- 回滚顺序步骤 1 的「记到工单」是过于场景化的废话，对独自维护的小工具不适用，建议删
- 回滚顺序总结段「极端情况，比如今天改完 ccpa 全线挂掉」过于戏剧化，写成「整体回滚（v1.1.0 + 6/6 patch）」更冷静
- 「下次清理工作树前先 git diff HEAD -- src/ 留 patch」放到了 commit hash 段尾，应该并入回滚顺序段或单独提一行操作 SOP，目前埋得太深
- 「md5 a8f0ab08」「md5 c866d593」这种 8-char md5 缩写在文档第一次出现时没说明缩写规则（实际是 md5 全 hash 前 8 字符），读者会困惑，要么加一句「md5 仅显示前 8 字符」要么直接给全 hash

### 9.8 已知问题与未来工作（verifier 评分 6/10）

**事实疑点**：

- 声明：P2 表里 '/admin/accounts 只列 claude 无 codex'
  - 问题：实测 curl http://127.0.0.1:8317/admin/accounts 返回里既有 claude 块也有 codex 块（authMode/accountId/lastRefresh/path 全在），server.ts:271-281 的 admin handler 已经同时调 claudeProvider.getStatus() 和 codexProvider.getStatus() 拼进去了。这条 issue 在今天的代码里根本不存在。
  - 修正：整条删掉，或改成验证不通过的真实漏点，比如 /admin/usage 没暴露 cache 数据、recentRecords 默认 200 上限不可配等。
- 声明：P1 第 4 条「`/v1/responses` 不接 string input」复现的输出是 「'error.message: string' 模板字符串原样吐回」
  - 问题：实测 curl 返回 `{"error":{"message":"{\"detail\":\"Input must be a list\"}"}}` —— 即上游 codex 后端正常的 schema 校验错误「Input must be a list」被 CCPA 用 `{error:{message:...}}` 套了一层，没有什么「模板字符串原样吐回」。底层结论（CCPA 没把 string 包成 list）是对的，但「模板字符串」这个描述是误读了之前 prettify 的输出。
  - 修正：把复现块的输出改成实际返回：`{"error":{"message":"{\"detail\":\"Input must be a list\"}"}}`，并直接说「upstream 拒收 string，CCPA 没本地化错误」。
- 声明：P3「`--login` 必须显式 `export HTTPS_PROXY` …`src/index.ts:6` 已读 env 但 `--login` 跑在独立 shell，没继承 plist 的 EnvironmentVariables」
  - 问题：src/index.ts 里 `--login` 走的是同一个 Node 进程的 main()→doLogin() 分支（line 124-126），没有 spawn 任何「独立 shell」。issue 的本质是：plist 的 EnvironmentVariables 只在 launchd 启动 server 时生效，用户在 terminal 手动跑 `node dist/index.js --login` 时是当前 shell 的 env —— 跟「独立 shell」无关。
  - 修正：改成「plist 的 EnvironmentVariables 只对 launchd 拉起的 server 生效；用户手动 cli `--login` 时拿的是当前 shell 的 env，所以得自己 export HTTPS_PROXY」。
- 声明：P3 表里 codex `tool_choice` 字符串 passthrough 未验证，定位在「`src/providers/codex-chat.ts:313-316` 的 `convertChatToolChoiceToResponses`」
  - 问题：313-316 是 convertChatToolChoiceToResponses 的**调用**位置；函数定义在 codex-chat.ts:240-251。引位置错了，未来照行号定位会找空。
  - 修正：改成「src/providers/codex-chat.ts:240-251 的 convertChatToolChoiceToResponses 定义；调用在 314」。

**缺漏 topic（建议下一轮补）**：

- codex-upstream.ts 内置 2 次 retry（CODEX_RESPONSES_MAX_ATTEMPTS=2，仅对 fetch failed/TypeError 重试），值得在 P3 codex 401 retry 那条里点一下「已有 transient retry，但不重读 token」
- config.yaml 当前实际配置（host: 0.0.0.0 监听全部 interface）跟 「家网 OK 挂公网就完蛋」的 rate-limit 条目是直接呼应的——host 0.0.0.0 + rate-limit disabled 是组合 risk，section 里 P1#6 应该并指出 host 配置
- /v1/models 列表里 codex 也被列了（gpt-5.4 / gpt-5.5 / gpt-image-2），section 没提 models endpoint 这一块的潜在不一致
- translator.ts 已经在响应体里输出 cache_creation_input_tokens / cache_read_input_tokens 给客户端，但 UsageTracker 不收集 —— section 措辞偏向 dashboard 不聚合，可补一句「客户端能看到，但 ccpa 自家不积累」

**风格 / 表述问题**：

- 开篇「下面这些 issue 在今天的 review 里逐条 verified 过」是元描述废话，正文是 issue 清单，无需自我背书；删掉直接进 P1 更好
- 「按图索骥」「半小时把外部接入两大坑修了」「白搭」「不要无脑提前写」掺杂口语化总结，跟前面冷静的 file:line + 改法风格不一致
- P4 末尾「WebSocket realtime…现在白搭。**未估**」既然「未估」就不需要列条目，要列就给至少一档时间
- Roadmap 第 5 条把 dashboard 多账号/codex/cache 三件合一描述为「半天打包做」，但前面 P2 表里这三条加起来明确写的是 3 小时，roadmap 应该一致一下
- 「8 个 alias 写死成 const ... as const」用了 alias 这个词稍含糊，建议改成「8 个模型 id 硬编码（包含别名 opus/sonnet/haiku 和具体版本号）」

---

_文档结束。生成自 2026-06-09 ccpa 全面评估 workflow（agent_count=16, subagent_tokens=1022919, 1627s）。_
