# AgentFlowing

[English](README.md) | 简体中文

一个 Cloudflare 原生的开源模板，用于构建通过订阅和积分计费盈利的 AI Agent SaaS。

AgentFlowing 将 React 产品界面、Better Auth、组织多租户、持久化流式对话、用量积分、Stripe 计费、API 访问和文件上下文整合到一个可部署的 Cloudflare Worker 中。你可以保留 SaaS 基础设施，替换示例 Agent、提示词和产品文案，快速构建自己的产品。

> **项目状态：** 早期模板（`0.1.x`）。核心计费和租户边界已有测试保障，但每次正式部署仍需完成与你的业务相关的安全评审、定价校准、服务商配置和运行监控。

## 为什么选择 AgentFlowing

大多数 Agent Demo 只做到聊天框。真正的商业产品还需要身份认证、租户隔离、计费、重放保护、文件存储、API 接入和故障恢复。AgentFlowing 提供这些基础能力，同时不需要常驻应用服务器或 Kubernetes 集群。

## 功能

- React 19 产品界面，支持英文和简体中文
- Better Auth 邮箱密码、GitHub/Google OAuth、Magic Link 和密码重置
- 组织工作空间及 owner/admin/member 权限控制
- Agent 创建、编辑、发布、归档、可见性和模型策略
- 基于 Cloudflare Agents SDK 与 Durable Objects 的流式对话
- Workers AI 模型执行，服务端限制输出长度和工具步数
- 不可变 D1 积分账本，具备防透支、幂等扣费和幂等退款
- Stripe Checkout、客户门户、订阅 Webhook 和周期积分发放
- R2 文件上传，包含租户校验、MIME 校验和大小限制
- 面向服务端集成的作用域 API Key，仅保存哈希
- Cloudflare Rate Limiting、请求 ID、结构化日志、CSP 和安全响应头
- Worker 运行时集成测试、Cloudflare 类型生成和 GitHub Actions CI

### 功能启用条件

| 能力                  | 默认本地状态   | 额外配置                                     |
| --------------------- | -------------- | -------------------------------------------- |
| 邮箱密码              | 已启用         | 设置 `BETTER_AUTH_SECRET`                    |
| GitHub/Google OAuth   | 未配置时隐藏   | Provider 凭据和回调地址                      |
| Magic Link/密码重置   | 未配置时隐藏   | Cloudflare Email Sending 域名和 `EMAIL_FROM` |
| Stripe 订阅           | 保持免费模式   | Stripe 密钥、Price 和 Webhook                |
| Workers AI            | 已启用远程绑定 | 登录 Cloudflare 并具备账号权限               |
| D1/R2/Durable Objects | 本地模拟       | 上线前创建生产资源                           |

默认不强制邮箱验证。模板暂未集成 Turnstile，也未绑定 Cloudflare Workflows；如果你的产品需要更强的注册防护或长任务执行，可以基于现有边界继续扩展。

## 技术栈

| 层级         | 技术                                                |
| ------------ | --------------------------------------------------- |
| 产品界面     | React 19、Vite、Tailwind CSS、`react-i18next`       |
| HTTP 运行时  | Cloudflare Workers、Hono                            |
| Agent 运行时 | Cloudflare Agents SDK、Durable Objects、Workers AI  |
| 身份认证     | Better Auth、OAuth、Magic Link、organization plugin |
| 数据         | D1、Drizzle ORM、SQL migrations                     |
| 文件         | R2                                                  |
| 计费         | Stripe 订阅和不可变积分账本                         |
| 质量保障     | Vitest Workers pool、TypeScript、Oxlint、Oxfmt      |

## 架构

```text
React SPA
  ├─ Cloudflare Worker 中的 Hono API
  │  ├─ Better Auth + 组织工作空间
  │  ├─ D1 业务数据 + 不可变积分账本
  │  ├─ Stripe Checkout + Webhook 验签
  │  ├─ R2 文件 + 作用域 API Key
  │  └─ 限流 + 可观测性
  └─ Cloudflare Agents SDK
     └─ 每个对话一个 Durable Object
        ├─ 有序消息 + 流式输出
        └─ 工具调用 + 恢复钩子
```

计费、租户隔离、恢复策略和模块边界详见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

### 环境要求

- Node.js 22+
- pnpm 10+
- Cloudflare 账号，用于远程 Workers AI 绑定

### 本地启动

```bash
git clone https://github.com/moutsea/agentflowing.git
cd agentflowing
pnpm install
cp .dev.vars.example .dev.vars
pnpm exec wrangler login
pnpm cf-typegen
pnpm db:migrate:local
pnpm dev
```

在 `.dev.vars` 中将 `BETTER_AUTH_SECRET` 设置为至少 32 个字符的随机值，例如：

```bash
openssl rand -base64 32
```

默认访问地址是 [http://localhost:5173](http://localhost:5173)。如果 Vite 自动选择其他端口，需要同步修改 `wrangler.jsonc` 中的 `APP_URL` 和 OAuth 回调地址，确保来源完全一致。

运行完整检查：

```bash
pnpm check
pnpm exec wrangler deploy --dry-run
```

## 配置

AgentFlowing 使用 `wrangler.jsonc` 保存非敏感默认值和 Cloudflare bindings。本地密钥放在 `.dev.vars`，生产密钥应使用 `wrangler secret put` 写入。仓库也提供常规的 `.env.example` 方便工具识别，但本地 Worker 配置以 `.dev.vars.example` 为准。

### 应用变量

| 变量                      | 必需 | 默认值                  | 作用                                                      |
| ------------------------- | ---- | ----------------------- | --------------------------------------------------------- |
| `APP_NAME`                | 是   | `AgentFlowing`          | Worker 和认证邮件使用的产品名                             |
| `APP_URL`                 | 是   | `http://localhost:5173` | Better Auth、Stripe 和跳转使用的规范来源                  |
| `DEFAULT_AI_MODEL`        | 是   | GLM 4.7 Flash           | 示例 Agent 默认模型，必须存在于 `src/shared/ai-models.ts` |
| `FREE_CREDITS`            | 是   | `100`                   | 新工作空间赠送积分                                        |
| `MESSAGE_CREDIT_COST`     | 是   | `1`                     | 示例 Agent 初始价格，不得低于模型最低价格                 |
| `AGENT_RUN_STALE_SECONDS` | 是   | `1800`                  | Cron 收割并退款卡住运行的超时时间                         |

### 密钥和可选服务商

| 变量                                            | 必需 | 作用                                            |
| ----------------------------------------------- | ---- | ----------------------------------------------- |
| `BETTER_AUTH_SECRET`                            | 是   | Better Auth 签名/加密密钥，至少 32 个字符       |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`     | 否   | 两者同时设置后启用 GitHub OAuth                 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`     | 否   | 两者同时设置后启用 Google OAuth                 |
| `EMAIL_FROM`                                    | 否   | 配合 `EMAIL` binding 启用 Magic Link 和密码重置 |
| `EMAIL_FROM_NAME`                               | 否   | 认证邮件发件人名称                              |
| `MAGIC_LINK_EXPIRES_SECONDS`                    | 否   | Magic Link 有效期，默认 900 秒                  |
| `STRIPE_SECRET_KEY`                             | 否   | 启用 Stripe Checkout 和客户门户                 |
| `STRIPE_WEBHOOK_SECRET`                         | 否   | 验证 Stripe Webhook 签名                        |
| `STRIPE_PRO_PRICE_ID` / `STRIPE_SCALE_PRICE_ID` | 否   | 服务端权威订阅 Price                            |

不要给密钥添加 `VITE_` 前缀；带该前缀的变量会暴露给浏览器代码。

### Cloudflare Bindings

`wrangler.jsonc` 定义了：

- `DB`：D1 数据库
- `FILES`：R2 Bucket
- `MonetizedAgent`：Durable Object namespace
- `AI`：Workers AI
- `EMAIL`：Email Sending
- `AUTH_RATE_LIMITER`、`API_RATE_LIMITER`、`AI_RATE_LIMITER`、`WEBHOOK_RATE_LIMITER`

## 登录服务商

只有在对应凭据完整时，`GET /api/auth/capabilities` 才会让前端显示 OAuth 按钮。服务商密钥不会发送到浏览器。

在 GitHub 和 Google 后台配置：

```text
https://your-domain.example/api/auth/callback/github
https://your-domain.example/api/auth/callback/google
```

认证邮件使用 Cloudflare Email Sending，不需要额外的第三方邮件 API Key：

```bash
pnpm exec wrangler email sending enable mail.your-domain.example
pnpm exec wrangler email sending dns get mail.your-domain.example
```

发布 Cloudflare 返回的 DNS 记录后，将 `EMAIL_FROM` 设置为该域名下的邮箱地址。

## 生产部署

1. 创建 Cloudflare 资源：

   ```bash
   pnpm exec wrangler d1 create agentflowing-db
   pnpm exec wrangler r2 bucket create agentflowing-files
   ```

2. 替换 `wrangler.jsonc` 中的 D1 database ID 和 Rate Limit namespace ID 占位值。
3. 设置生产 `APP_URL`，并检查模型和积分默认值。
4. 写入密钥，不要提交到 Git：

   ```bash
   pnpm exec wrangler secret put BETTER_AUTH_SECRET
   pnpm exec wrangler secret put STRIPE_SECRET_KEY
   pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET
   pnpm exec wrangler secret put STRIPE_PRO_PRICE_ID
   pnpm exec wrangler secret put STRIPE_SCALE_PRICE_ID
   ```

5. 执行迁移并部署：

   ```bash
   pnpm db:migrate:remote
   pnpm deploy
   ```

6. 配置 Stripe Webhook：

   ```text
   https://your-domain.example/api/billing/webhooks/stripe
   ```

   订阅 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`customer.subscription.created`、`customer.subscription.updated`、`customer.subscription.deleted`、`invoice.paid` 和 `invoice.payment_failed`。

### 接受真实付款前

- 根据最新模型价格和支付手续费校准每个模型的最低积分价格。
- 替换示例套餐、价格、Agent 提示词和产品文案。
- 配置 OAuth/邮件域名，并决定是否强制邮箱验证。
- 如果匿名注册可能被滥用，增加机器人防护。
- 评审数据保留、隐私、税务、退款和服务条款要求。
- 根据流量调整限流、日志、Trace 采样和 stale-run 超时时间。
- 在 Stripe Sandbox 覆盖支付、续费、失败、重试和退款流程。
- 从干净检出的仓库运行 `pnpm check` 和 `wrangler deploy --dry-run`。

## 计费语义

系统按模型运行次数计费，而不是按用户消息计费。工具续跑可能触发额外模型调用并再次消耗积分。Worker 在推理前按 Agent 配置价格扣费；失败、取消、中断和超时的运行会依据不可变的原始扣款额幂等退款。

浏览器消息 ID 会拒绝重放。外部 API 的幂等键会返回已完成的缓存结果，不会再次调用模型或扣费。积分安全由 D1 约束保障，而不是依赖限流器。

## 外部 API

在 **Settings → API keys** 创建作用域 API Key。密钥只显示一次，数据库仅保存 SHA-256 哈希。

```bash
curl https://your-domain.example/api/v1/agents \
  -H "Authorization: Bearer af_live_your_key"
```

Scopes、Agent 执行、附件、幂等和错误格式详见 [docs/api.md](docs/api.md)。

## 项目结构

```text
src/
  client/                     React 产品与管理界面
  server/
    agents/                   持久化对话运行时
    auth/                     Better Auth 与事务邮件
    db/                       Drizzle schema
    middleware/               身份、限流、可观测性
    modules/                  领域服务和 Hono routes
  shared/                     产品和模型目录
migrations/                   D1 迁移与计费约束
public/                       静态安全响应头
test/                         Workers 运行时集成测试
docs/                         架构和外部 API 文档
```

## 常用命令

| 命令                     | 作用                                  |
| ------------------------ | ------------------------------------- |
| `pnpm dev`               | 启动本地全栈 Worker                   |
| `pnpm cf-typegen`        | 根据 Wrangler 配置重新生成 `env.d.ts` |
| `pnpm db:migrate:local`  | 本地执行 D1 迁移                      |
| `pnpm db:migrate:remote` | 远程执行 D1 迁移                      |
| `pnpm format`            | 格式化仓库                            |
| `pnpm check`             | 格式、Lint、类型、测试和生产构建      |
| `pnpm deploy`            | 构建并使用 Wrangler 部署              |

## 路线图

- 可选邮箱验证和重发流程
- 面向公开注册和密码恢复的 Turnstile 集成
- 面向长时间、可恢复任务的 Cloudflare Workflows 适配器
- 团队邀请和席位管理界面
- 用量分析和运营后台
- 自动部署与 Release 工作流

路线图不代表交付承诺。建议先创建 Issue 讨论范围和架构，再开始较大的实现。

## 贡献与安全

提交 Pull Request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。可复现 Bug 和聚焦的功能建议请通过 GitHub Issues 提交。

请勿在公开 Issue 中报告漏洞。私密披露方式见 [SECURITY.md](SECURITY.md)。

## 开源许可

[MIT](LICENSE) © 2026 AgentFlowing contributors。

AgentFlowing 是基于常见 SaaS 架构思想进行的 clean-room 实现，不包含 ShipAny 源代码或专有资产。
