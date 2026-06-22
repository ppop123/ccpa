# ccpa

Claude + Codex Proxy API

[English](./README.md)

`ccpa` 是一个本地代理，用来把你机器上已有的 Claude 和 Codex 登录态，变成可供脚本调用的 OpenAI 兼容 HTTP API。

它的目标很单纯：

- 给你自己的脚本用
- 用一个本地 `base_url` 同时接 Claude 和 Codex
- 按 `model` 自动路由

它不是多账号池，不是计费平台，也不是通用网关。

仓库名是 `ccpa`，但运行时日志和部分配置路径里仍然会看到旧的内部名字 `auth2api`。

## 它能做什么

- 一个进程同时服务 Claude 和 Codex
- 支持 `POST /v1/chat/completions`
- 支持 `POST /v1/responses`
- 支持 `GET /v1/models`
- 支持 Claude 原生 `POST /v1/messages` 和 `POST /v1/messages/count_tokens`
- 提供 `GET /admin/accounts` 查看 provider 状态
- 提供 `GET /admin/usage` 和 `GET /admin/usage/recent` 查看内存中的请求统计
- 提供 `GET /monitor` 作为浏览器监控页入口

路由规则很简单：

- `claude-*` -> Claude
- `gpt-*`、`o*`、`codex-*` -> Codex

## 运行前提

- Node.js 20+
- 如果要用 Claude，需要 Claude 登录态
- 如果要用 Codex，需要 Codex 登录态

Claude token 存在 `auth-dir` 目录里。

Codex 登录态优先读取 `codex.auth-file`，如果配置路径不存在，再回退到 `~/.codex/auth.json`。

服务支持三种启动方式：

- 只开 Claude
- 只开 Codex
- Claude + Codex 同时开

如果两边都不可用，启动会直接失败。

## 安装

```bash
git clone https://github.com/ppop123/ccpa
cd ccpa
npm install
npm run build
cp config.example.yaml config.yaml
```

## 5 分钟跑起来

1. 在 `config.yaml` 里填一个正式 API key。
2. 在 `codex.models` 里填允许访问的 Codex 模型。
3. 登录你要用的 provider。
4. 启动服务。

最小配置示例：

```yaml
host: ""
port: 8317

auth-dir: "~/.auth2api"

api-keys:
  - "sk-replace-with-a-long-random-key"

rate-limit:
  enabled: false

codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"
    - "gpt-image-2"

debug: "off"
```

完整配置可以直接看 [config.example.yaml](/Users/wy/auth2api/config.example.yaml)。

本地 `/v1` 限流默认关闭。只有在你明确设置 `rate-limit.enabled: true` 时才会启用，窗口和阈值可在 [config.example.yaml](/Users/wy/auth2api/config.example.yaml) 里调整。

启动：

```bash
node dist/index.js
```

默认地址：

```text
http://127.0.0.1:8317
```

## 登录

Claude 登录：

```bash
npm run login
```

远程 shell 下手动 Claude 登录：

```bash
node dist/index.js --login --manual
```

Codex 登录：

```bash
npm run login:codex
```

这会调用官方 `codex login`。如果本机没装 Codex CLI，ccpa 会直接给出安装提示。

如果当前只登录了一边 provider，服务仍然可以启动，只是另一边模型不可用；缺失信息会在 `/admin/accounts` 里直接提示。

## 给脚本调用

把它当成 OpenAI 兼容服务就行：

- `base_url = http://127.0.0.1:8317/v1`
- `api_key = config.yaml` 里的任意一个 `api-keys`

### curl

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Reply with ok."}],
    "stream": false
  }'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-sk-...",
    base_url="http://127.0.0.1:8317/v1",
)

resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Reply with ok."}],
)

print(resp.choices[0].message.content)
```

### 本机 shell 包装脚本

```bash
./scripts/call_ccpa.sh gpt-5.4 "Reply with ok."
./scripts/call_ccpa.sh claude-sonnet-4-6 "Reply with ok."
```

这个脚本会自动读取 `config.yaml`，拿 `api-keys[0]`，然后请求本机服务。

### 生图

`gpt-image-2` 复用同一份 Codex OAuth 登录态，并通过 OpenAI 兼容的 Images API 暴露。
这里的 `gpt-image-2` 是对外兼容名；内部会用 `gpt-5.5` 搭配 `image_generation`
tool 请求 Codex，因为 ChatGPT 账号下的 Codex 后端会拒绝把 `gpt-image-2` 当成原始模型 id。

```bash
curl http://127.0.0.1:8317/v1/images/generations \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A tiny blue icon on a white background",
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

## 模型规则

内置 Claude 模型：

- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001`
- `claude-haiku-4-5`

Claude 便捷别名：

- `opus`
- `sonnet`
- `haiku`

Codex 模型只来自 `codex.models`。

运行时关键规则：

- `codex.enabled: false` 会彻底关闭 Codex 路由
- 不在 `codex.models` 里的 Codex 模型会直接返回 `400 Unsupported model`
- `/v1/models` 返回 Claude 内置模型加上配置里的 Codex 模型

## 接口

| 接口 | 用途 |
|------|------|
| `POST /v1/chat/completions` | OpenAI 兼容聊天接口 |
| `POST /v1/responses` | OpenAI 兼容 responses 接口 |
| `POST /v1/images/generations` | 通过 Codex OAuth 生成图片的 OpenAI 兼容接口 |
| `POST /v1/messages` | Claude 原生消息接口 |
| `POST /v1/messages/count_tokens` | Claude 原生 token 计数接口 |
| `GET /v1/models` | 列出可用模型 |
| `GET /admin/accounts` | 查看 provider 可用性和登录提示 |
| `GET /admin/usage` | 查看聚合使用统计 |
| `GET /admin/usage/recent` | 查看最近请求摘要 |
| `GET /monitor` | 浏览器监控页入口 |
| `GET /health` | 公开进程健康检查和运行版本信息 |

`/v1` 和 `/admin` 都需要 API key。

## 监控

`/admin/accounts` 用来判断 Claude 和 Codex 当前是否可用。
它也会返回一个 `server` 对象，包含正在运行的包版本、进程启动时间、运行时长，以及 provider readiness 摘要。

`/health` 不需要 API key，并且刻意不返回账号或 provider 细节。它只返回非敏感的进程身份信息，例如 `service`、`version`、`started_at` 和 `uptime_ms`。

`/admin/usage` 提供进程启动以来的聚合统计，包括：

- 总请求数
- 按 provider 统计
- 按 endpoint 统计
- 按 model 统计

`/admin/usage/recent` 返回最近请求摘要，最新的在前面。

这些统计只存在内存里，重启后会清空。

如果你想在浏览器里看，直接打开：

```text
http://127.0.0.1:8317/monitor
```

`/monitor` 本身只是一个 HTML 壳页，不会在服务端直接嵌入实时统计。页面加载后会让你输入 API key，再由浏览器同源请求现有的 `/admin/accounts`、`/admin/usage`、`/admin/usage/recent`。

## Canary

构建、重启或调整 launchd 配置后，先跑一条低成本 canary：

```bash
npm run canary -- --url http://127.0.0.1:8317
```

canary 默认从 `config.yaml` 读取 `api-keys[0]`，不会打印 key。它检查 `/health`、`/admin/accounts`、`/v1/models`，以及 `/v1/embeddings` 是否返回预期的 JSON 404；不会向上游发送真实模型生成请求。默认还要求 provider readiness 至少达到 `degraded`，也就是至少一个 provider 可用。发布或完整巡检时可以加 `--require-provider-status ok` 要求 Claude 和 Codex 都可用；排障时可以用 `--require-provider-status any` 只检查服务契约。

如果本机存在 `dist/index.js`，canary 还会检查 live 进程的启动时间是否晚于本地 dist 构建时间。跨机器检查远端实例、且本机不共享同一份 dist 文件时，可以加 `--no-dist-check`。

如果希望做更完整、但仍不消耗上游额度的 OpenAI 兼容契约检查，可以跑：

```bash
npm run contract:check -- --url http://127.0.0.1:8317
```

它检查鉴权失败、admin readiness、模型列表、JSON 404、非法 JSON、unsupported model，以及 chat/responses/images 和 Claude native messages/count_tokens 路由的本地校验错误。所有请求都走本地 validation/error 路径，不会调用 Claude 或 Codex 的真实生成上游。

真正动 live 之前，可以先跑只读预检。它会检查本地 rollout 资产、复用低成本 canary 和 contract gate，并打印下一步手动命令：

```bash
npm run rollout:preflight
```

这个预检不会执行 `launchctl`，不会改 plist，不会替换外部 healthcheck，也不会清理真实 live 日志。

准备真正 rollout 时，先看 dry-run 执行计划：

```bash
npm run rollout:live
```

它只打印 build、`launchctl kickstart`、rollout 后 canary、contract gate 和 no-restart healthcheck 步骤，不会执行。只有显式加 `-- --apply` 才会真正执行 rollout。替换外部 `/Users/wy/ccpa-healthcheck.sh` 是额外 opt-in：`-- --apply --install-external-healthcheck`。

在 staging 或把 release candidate 交给其他 agent 前，先跑本地 readiness hygiene 检查：

```bash
npm run release:readiness
```

它是只读检查。dirty candidate changes 可以存在，但如果 `.DS_Store`、`.claude/`
worktree、`*.bak-pre-*` 备份文件这类本机临时副产物仍出现在 `git status` 里，
脚本会失败，避免误把它们带进候选变更。默认输出会按 runtime source、tests、
scripts、docs、project config 等 review bucket 分组统计候选文件。需要展开路径时用
`npm run release:readiness -- --list`；要交给另一个 agent 自动 review 时用
`npm run release:readiness -- --json`。如果要固化一份 handoff artifact，用
`npm run release:readiness -- --write-json /tmp/ccpa-release-readiness.json`；
JSON 里会包含生成时间、repo/status 来源、建议 review 命令，以及会花上游额度的
matrix 命令。

最终交付前，可以跑只读聚合门禁：

```bash
npm run release:verify
```

它会依次执行 release readiness、secret scan（`npm run secrets:scan`）、
配置安全姿态检查（`npm run security:posture`）、依赖安全审计
（`npm run security:audit`）、不花额度的 upstream matrix dry-run
（`npm run upstream:matrix`）、rollout preflight、TypeScript typecheck
（`npm run typecheck`）、provider/runtime 单元测试（`npm run test:unit`）、smoke 测试、运维脚本行为测试
（`npm run test:ops`）、`git diff --check`，以及自动发现的 `scripts/ccpa-*.mjs` /
`scripts/ccpa-*.sh` 运维脚本语法检查。
第一处失败会立刻停止，并对 email / API-key 形态输出脱敏。它不会 build、
不会重启 launchd、不会 stage 文件，也不会调用真实模型生成上游。

可以单独运行 `npm run secrets:scan`。它会扫描面向发布的 docs、scripts、src、
项目配置，以及 `git status` 中可见的候选文件；默认排除 `tests/`、`config.yaml`、
`dist/` 和本机 auth 目录，避免测试假 secret 或私有运行配置阻断发布。

可以单独运行 `npm run security:posture`。它会阻断缺失、占位或太弱的客户端
API key；如果服务监听所有网卡但本地 rate limit 关闭，只给 warning 不阻断，
因为“内网 + 强 API key”的自用部署是当前支持模式。

可以单独运行 `npm run security:audit`。它使用
`npm audit --audit-level=moderate`，中危及以上依赖安全公告会让 release gate 失败。

默认 rollout preflight 要求是 `degraded`，也就是至少一个 provider 可用。如果这次交付必须证明 Claude 和 Codex 都可用，用：

```bash
npm run release:verify -- --require-provider-status ok
```

如果你明确想花上游额度做真实端到端矩阵，先看 `release:verify` 也会使用的 dry-run 计划：

```bash
npm run upstream:matrix
```

只有显式加 `-- --apply` 才会通过本机 CCPA 发送真实生成请求。默认 apply 矩阵覆盖
Codex 和 Claude 的文本路径：`/v1/chat/completions` 与 `/v1/responses`；只有当你也想花一次图片生成请求时，才使用 `-- --apply --include-image`。

如果要接 launchd 或 cron 类守护，使用仓库里的 healthcheck wrapper：

```bash
npm run healthcheck -- --no-restart
```

它复用同一条低成本 canary，并默认继续跑 no-upstream contract gate；从配置或环境读取 API key，不会调用真实模型生成接口。作为守护脚本使用时保持 restart 开启，或显式设置 `CCPA_HEALTHCHECK_RESTART=true`；手动排障时用 `--no-restart`。只有在排障时想保留浅层健康检查，才设置 `CCPA_HEALTHCHECK_RUN_CONTRACT=false`。如果希望 healthcheck 在 canary 前顺手维护日志，设置 `CCPA_HEALTHCHECK_MAINTAIN_LOGS=true`；日志维护失败只会写入 healthcheck log，不会阻断 canary/contract 检查，也不会触发重启。

本地 launchd 日志可以定期跑仓库内的维护脚本：

```bash
npm run logs:maintain
```

它会脱敏默认的 `/tmp/ccpa.stdout.log`、`/tmp/ccpa.stderr.log` 和
`/tmp/ccpa-healthcheck.log`，把 email 与 `sk-*` 形态字符串替换成占位符。
如果日志超过 `CCPA_LOG_MAX_BYTES`（默认 `1048576`），脚本会把脱敏快照写到
`<log>.1`，再原地清空当前文件，让 launchd 继续写同一个路径。可用
`CCPA_LOG_PATHS`、`CCPA_LOG_MAX_BYTES`、`CCPA_LOG_KEEP` 调整路径、阈值和保留份数。

## 调试

`debug` 支持三档：

- `off`
- `errors`
- `verbose`

`verbose` 会输出访问日志；`errors` 只记录上游和网络错误。

## 配合 Claude Code

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code 走的是原生 `/v1/messages`，ccpa 会直接透传。

## Docker

```bash
docker build -t ccpa .

docker run -d \
  -p 8317:8317 \
  -v ~/.auth2api:/data \
  -v ~/.codex/auth.json:/root/.codex/auth.json:ro \
  -v ./config.yaml:/config/config.yaml \
  ccpa
```

如果你要把 Claude 登录态持久化到容器里，配置：

```yaml
auth-dir: "/data"
```

如果你改了容器内 Codex auth 文件路径，也要同步修改 `codex.auth-file`。

## Smoke 测试

```bash
npm run test:smoke
```

这套测试使用 mocked upstream，不会调用真实 Claude 或 Codex。

## Inspired by

- [auth2api](https://github.com/AmazingAng/auth2api)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
