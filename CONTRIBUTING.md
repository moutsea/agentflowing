# Contributing to AgentFlowing

English | [简体中文](#简体中文)

Thank you for helping improve AgentFlowing. Small, focused changes with clear tests are the easiest to review and maintain.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Open an issue before large features, schema changes, billing changes, or new infrastructure dependencies.
- Never include credentials, customer data, production logs, or private prompts in an issue or test fixture.
- Report security vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Local Setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm cf-typegen
pnpm db:migrate:local
pnpm dev
```

Use Node.js 22+ and pnpm 10+. The remote Workers AI binding may require `pnpm exec wrangler login`.

## Development Workflow

1. Create a focused branch from the latest `main`.
2. Keep changes scoped to one problem.
3. Add or update tests for behavior changes.
4. Run the narrowest useful test while iterating.
5. Run the full suite before opening a pull request:

   ```bash
   pnpm format
   pnpm check
   pnpm exec wrangler deploy --dry-run
   ```

6. Explain user-visible behavior, architecture tradeoffs, migrations, and deployment changes in the pull request.

## Architecture Rules

- Scope every business query by `organizationId` and, where required, `userId`.
- Keep HTTP concerns in Hono routes and business rules in domain services.
- Treat model IDs, prices, output caps, and tool limits as server-authoritative values.
- Represent credit changes as immutable ledger entries; do not update balances directly.
- Preserve idempotency for payments, Agent runs, retries, refunds, and webhook handling.
- Read refund amounts from the captured run, not the Agent's current configuration.
- Do not expose Worker secrets through `VITE_*`, API responses, logs, or client bundles.
- Keep Durable Object recovery, cancellation, and stale-run behavior explicit and tested.

Read [docs/architecture.md](docs/architecture.md) before changing billing, tenancy, Durable Objects, Stripe webhooks, or the external API.

## Database Changes

1. Update `src/server/db/schema.ts`.
2. Generate a migration with `pnpm db:generate`.
3. Review the generated SQL; do not treat generated migrations as automatically correct.
4. Add explicit SQL invariants or triggers when application checks cannot protect concurrency.
5. Run `pnpm db:migrate:local` and the full test suite.

Never rewrite a migration that may already have been deployed. Add a new migration instead.

## Pull Request Checklist

- [ ] The change is focused and linked to an issue when appropriate.
- [ ] Tests cover new behavior and failure paths.
- [ ] English and Chinese UI copy remain synchronized.
- [ ] README or API documentation is updated when contracts change.
- [ ] No secrets, generated builds, or local Cloudflare state are included.
- [ ] `pnpm check` passes.
- [ ] `wrangler deploy --dry-run` passes for configuration changes.

By contributing, you agree that your contribution is licensed under the repository's MIT License.

---

## 简体中文

感谢你参与改进 AgentFlowing。范围清晰、改动聚焦并带有测试的贡献最容易评审和长期维护。

### 开始之前

- 创建 Issue 或 PR 前先搜索是否已有相关讨论。
- 大功能、Schema 变更、计费改动或新增基础设施依赖，请先创建 Issue 对齐方案。
- 不要在 Issue、日志或测试数据中提交密钥、客户数据、生产日志或私有提示词。
- 安全漏洞请按照 [SECURITY.md](SECURITY.md) 私密报告。

### 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm cf-typegen
pnpm db:migrate:local
pnpm dev
```

需要 Node.js 22+ 和 pnpm 10+。远程 Workers AI binding 可能需要先运行 `pnpm exec wrangler login`。

### 开发流程

1. 基于最新 `main` 创建聚焦的分支。
2. 一个 PR 只解决一个主要问题。
3. 行为变化需要增加或更新测试。
4. 开发期间优先运行最相关的小范围测试。
5. 提交 PR 前运行：

   ```bash
   pnpm format
   pnpm check
   pnpm exec wrangler deploy --dry-run
   ```

6. 在 PR 中说明用户可见变化、架构取舍、迁移和部署影响。

### 架构约束

- 所有业务查询必须按 `organizationId` 隔离，必要时同时按 `userId` 隔离。
- Hono route 负责 HTTP，领域 service 负责业务规则。
- 模型、价格、输出上限和工具步数必须由服务端权威控制。
- 积分变化必须追加不可变账目，不能直接修改余额。
- 支付、Agent 运行、重试、退款和 Webhook 必须保持幂等。
- 退款金额必须来自运行时捕获价格，而不是 Agent 当前价格。
- 不得通过 `VITE_*`、API、日志或客户端 Bundle 暴露 Worker 密钥。
- Durable Object 的恢复、取消和 stale-run 行为必须显式实现并测试。

修改计费、多租户、Durable Objects、Stripe Webhook 或外部 API 前，请先阅读 [docs/architecture.md](docs/architecture.md)。

### 数据库变更

1. 修改 `src/server/db/schema.ts`。
2. 运行 `pnpm db:generate` 生成迁移。
3. 人工检查 SQL，不要默认生成结果一定正确。
4. 并发安全无法由应用检查保障时，应增加数据库约束或 Trigger。
5. 运行本地迁移和完整测试。

不要重写可能已经部署的迁移，应新增迁移。

提交贡献即表示你同意按本仓库的 MIT License 授权该贡献。
