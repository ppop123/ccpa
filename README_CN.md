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

codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"
    - "gpt-5.4-mini"
    - "gpt-5.2"

debug: "off"
```

完整配置可以直接看 [config.example.yaml](/Users/wy/auth2api/config.example.yaml)。

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
| `POST /v1/messages` | Claude 原生消息接口 |
| `POST /v1/messages/count_tokens` | Claude 原生 token 计数接口 |
| `GET /v1/models` | 列出可用模型 |
| `GET /admin/accounts` | 查看 provider 可用性和登录提示 |
| `GET /admin/usage` | 查看聚合使用统计 |
| `GET /admin/usage/recent` | 查看最近请求摘要 |
| `GET /monitor` | 浏览器监控页入口 |
| `GET /health` | 健康检查 |

`/v1` 和 `/admin` 都需要 API key。

## 监控

`/admin/accounts` 用来判断 Claude 和 Codex 当前是否可用。

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
