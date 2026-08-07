# Security Policy / 安全策略

## Supported Versions

AgentFlowing is currently an early-stage starter. Security fixes target the latest release and the current `main` branch. Older snapshots are not maintained.

AgentFlowing 目前是早期模板。安全修复仅面向最新 Release 和当前 `main` 分支，不维护更早的代码快照。

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use the repository's **Security → Report a vulnerability** flow to create a private GitHub Security Advisory. If private reporting is unavailable, contact a maintainer through a private address listed on the repository owner's GitHub profile and ask for a secure disclosure channel. Do not include exploit details in a public issue.

请勿使用公开 Issue 报告疑似漏洞。

优先通过仓库的 **Security → Report a vulnerability** 创建私密 GitHub Security Advisory。如果私密报告未启用，请通过仓库所有者 GitHub 资料中的私密联系方式联系维护者，并索取安全披露渠道。不要在公开 Issue 中包含漏洞利用细节。

Include, when possible:

- affected commit or version;
- impact and affected trust boundary;
- minimal reproduction steps;
- whether the issue has been exploited or publicly disclosed;
- a proposed fix or mitigation, if available.

建议包含：

- 受影响的 Commit 或版本；
- 影响和涉及的信任边界；
- 最小复现步骤；
- 是否已被利用或公开披露；
- 可用的修复或缓解建议。

Maintainers will respond on a best-effort basis, validate the report, coordinate a fix, and credit the reporter unless anonymity is requested. Please allow time for a patch before public disclosure.

维护者会尽力确认报告、协调修复，并在报告者未要求匿名时给予致谢。请在公开披露前为修复和发布预留合理时间。

## Deployment Responsibility

This repository is a starter, not a managed service. Operators are responsible for secrets, Cloudflare account security, OAuth applications, email domains, Stripe configuration, pricing, privacy obligations, monitoring, backups, and incident response.

本仓库是模板，不是托管服务。部署者需要自行负责密钥、Cloudflare 账号安全、OAuth 应用、邮件域名、Stripe 配置、定价、隐私义务、监控、备份和事件响应。

Never commit `.dev.vars`, `.env`, Cloudflare API tokens, Stripe secrets, OAuth secrets, customer data, or production logs.

绝不要提交 `.dev.vars`、`.env`、Cloudflare API Token、Stripe 密钥、OAuth 密钥、客户数据或生产日志。
