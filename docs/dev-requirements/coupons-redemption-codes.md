# 优惠券与兑换码开发需求

## 1. 目标与参考范围

为 AgentFlowing 增加两种平台营销凭证：

- 优惠券：只减少一次 Stripe 充值的应付金额，不增加 credits。
- 兑换码：携带预付 credits，登录用户兑换后直接写入当前 workspace 的不可变账本，不经过支付。

本文是开发、评审和验收的唯一需求基线。API 路径、字段名、数据库列名、函数名和环境变量名保持英文。CodeByAi 的行为只按以下已读取的实现作为参考：`EXTERNAL_COUPON_API.md`、`EXTERNAL_REDEMPTION_CODE_API.md`、`coupon_service.ts`、`redemption_code_service.ts` 及其对应路由。

当前模板的账本事实：`credit_ledger` 是不可变流水，唯一键为 `(organization_id, idempotency_key)`；D1 触发器在插入流水的同一数据库操作中更新 `credit_account`。新增入账不得直接修改 `credit_account.balance`，必须插入 `type = 'grant'` 的流水。当前平台管理员鉴权由 `PLATFORM_ADMIN_USER_IDS` 和 `requirePlatformAdmin` 提供，普通 workspace 的 `owner`/`admin` 角色不能替代平台管理员。

## 2. 已确认决策

1. 不实现邀请码、邀请奖励、注册页公开校验或任何注册准入门槛。
2. 优惠券只提供登录用户的内部校验预览，并在 Stripe 充值结账时使用；不提供对外创建优惠券接口，也不返回 `410` 的占位接口。
3. 兑换码面值字段使用 `credits` 整数，不使用美元、`quotaAmount`、`quotaUnit` 或汇率换算；默认面值为 `5` credits。
4. 发码、查码、撤销和发行额度管理统一放在平台 admin，使用 `PLATFORM_ADMIN_USER_IDS` 鉴权。
5. 对外接口使用两套互不通用的 token：`EXTERNAL_REDEMPTION_CODE_API_TOKEN` 只允许兑换码发行/核查/撤销，`EXTERNAL_COUPON_API_TOKEN` 只允许优惠券核查/撤销。

## 3. 范围与非目标

### 3.1 本次范围

- D1/Drizzle 的 `coupon`、`redemption_code` 数据模型和必要的现有 `order` 字段扩展。
- 优惠券的生成、规范化、预览、预留、支付确认、放弃释放、撤销和核查。
- 兑换码的批量发行、每日发行上限、发行幂等、预览、原子兑换、撤销和核查。
- 平台 admin 的发码、查码、撤销页面和审计事件。
- `/api/external` 下的两套独立 token API 及单独的对外 API 文档。
- vitest Workers pool 核心规则测试和 `pnpm check`。

### 3.2 非目标

- 邀请码、邀请奖励、注册页公开校验。
- Stripe 原生 coupon/promotion code 对象。
- 对外创建优惠券。
- 注册准入门槛。
- 改动现有订阅的产品规则、现有直充二维码之外的组织邀请流程。

## 4. 领域规则与状态

### 4.1 优惠券

优惠券是单次使用的百分比折扣。发行时 `rate` 为整数百分比，必须满足 `1 <= rate <= 50`；数据库以整数 `discount_rate_bps` 保存，`20%` 保存为 `2000`，禁止保存浮点折扣率。未指定有效期时从创建时刻起 `7` 天；指定值必须为正整数且不超过 `7` 天。有效期边界使用 UTC 时间，`expiresAt` 到达即不可用。

代码格式沿用 CodeByAi：`CB` 加 `10` 位字符，总长 `12`；字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，排除 `I`、`O`、`0`、`1`。输入 `trim` 后转大写，数据库只存大写；优惠券输入不因大小写不同而产生第二个代码。

状态对外统一为 `active`、`used`、`expired`、`revoked`。`reserved` 是内部状态：结账打开时占用使用次数，对外可映射为 `used`，但核查详情必须能区分“仅预留”和“已支付确认”。同一优惠券只能有一个未完成预留。当前用户自己的未支付预留允许再次预览；其他用户看到不可用。

预览接口只读，不改变优惠券状态。创建充值结账时必须在订单与优惠券同一原子边界内预留；支付成功时确认，支付失败、取消或结账过期时释放。放弃结账的预留最迟在 `60` 分钟内释放；定时任务释放前必须确认对应 Stripe 订单没有成功支付，避免 webhook 延迟造成重复使用。撤销只允许未确认使用的代码；与正在支付的预留竞争时返回冲突，先由支付状态决定胜负。

折扣永不叠加。结账计算所有可用折扣候选，只使用最大 `rate`；没有其他候选时使用优惠券，有更大自动折扣时优惠券只作记录而不降低价格。折后 Stripe 金额使用整数最小货币单位计算，推荐公式为 `floor(baseMinor * (10000 - effectiveRateBps) / 10000)`，最少保留 `1` 个最小货币单位。不得调用 Stripe 原生 coupon 或 promotion code。

### 4.2 兑换码

兑换码是预付额度，一次只能被一个登录用户兑换。面值字段为正整数 `credits`，未指定时为 `5`。建议沿用 CodeByAi 的可读格式：`RC` 加 `12` 位同字符集字符；输入 `trim`、转大写并去掉空格和连字符后再校验，数据库存规范化大写值。

发行时可指定 `validDays`，默认 `30` 天，必须为正整数且不超过 `365` 天；`expiresAt` 到达后不能兑换。每日发行上限按 UTC 日累计“已发行的 credits”计算，默认 `5000`，由 `REDEMPTION_CODE_DAILY_CREDITS_CAP` 配置；撤销、过期或已兑换的码仍计入当日已发行额度。单请求最多 `100` 个码，批量必须全成或全败。

发行必须支持 `Idempotency-Key`。同一 key 和同一规范化请求指纹重放时返回原批次，不生成新码；同一 key 搭配不同参数返回 `409`。并发重放只能有一个批次成功占用每日额度，所有重放者得到同一结果。

兑换必须是原子 claim：只有一个请求能把代码从可兑换状态改为已兑换；并发请求中只有获胜者能插入一条 `credit_ledger` 的 `grant` 流水，其他请求返回 `already_used`。claim、流水插入和状态落库必须在同一 D1 原子操作中完成；失败或超时必须让代码保持未兑换，重试不能重复发钱。入账目标是登录用户当前 active workspace 的 `organizationId`，幂等键固定包含代码 ID，例如 `redemption-code:<id>`。

## 5. 数据模型与迁移要求

### 5.1 `coupon`

在 `src/server/db/schema.ts` 增加 `coupon` 表，至少包含：`id`、唯一大写 `code`、整数 `discountRateBps`、`status`、`expiresAt`、`reservationId`、`reservedByUserId`、`reservedOrganizationId`、`reservedAt`、`reservationExpiresAt`、`redeemedByUserId`、`redeemedOrganizationId`、`redeemedAt`、`revokedAt`、`note`、`source`、`createdBy`、`createdAt`、`updatedAt`。使用外键关联 `user`/`organization`，为 `code`、`status + expiresAt`、`reservationExpiresAt` 建索引；约束 `discountRateBps` 在 `1..5000`。

### 5.2 `redemption_code`

增加 `redemption_code` 表，至少包含：`id`、唯一大写 `code`、整数 `credits`、`expiresAt`、`redeemedByUserId`、`redeemedOrganizationId`、`redeemedAt`、`revokedAt`、`note`、`source`、`idempotencyKey`、`requestFingerprint`、`batchIndex`、`createdBy`、`createdAt`。以 `(idempotencyKey, batchIndex)` 唯一索引支持批量重放，以 `code`、`createdAt`、`expiresAt` 建查询索引；约束 `credits > 0`，所有发行输入必须为安全整数。

### 5.3 `order` 扩展

在现有 `order` 上增加能恢复优惠券结算的整数和引用字段，例如 `couponId`、`couponCode`、`baseAmount`、`discountAmount`、`discountRateBps`、`couponReservationId`。`amount` 始终是最终 Stripe 金额的最小货币单位，`credits` 仍是订单产生的整数 credits。订单必须能从 webhook、状态轮询和定时恢复任务重建优惠券状态。

### 5.4 迁移

使用下一个现有编号（当前应为 `migrations/0009_*.sql`）生成 SQL 迁移，并同步 Drizzle snapshot/journal。禁止通过脚本直接改 D1 或在运行时隐式建表。迁移必须能在本地 D1 应用、回滚评审，并保留现有数据与账本不变。

## 6. HTTP 接口需求

### 6.1 登录用户接口

路由继续采用 Hono module、`requireAuth`、`API_RATE_LIMITER` 和全局 observability；所有写操作校验同源 `origin`，响应带 `x-request-id` 和 `Cache-Control: no-store`。

| 方法与路径                                    | 请求                  | 成功响应                                                          | 规则                                                            |
| --------------------------------------------- | --------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /api/billing/coupons/validate`          | `{ "code": "CB..." }` | `{ "valid": true, "rate": 20, "expiresAt": "..." }`               | 只预览，不预留、不消耗；无效时 `valid: false` 和稳定 `reason`。 |
| `POST /api/billing/redemption-codes/validate` | `{ "code": "RC..." }` | `{ "valid": true, "credits": 5, "expiresAt": "..." }`             | 只预览，不 claim，不暴露兑换人。                                |
| `POST /api/billing/redemption-codes/redeem`   | `{ "code": "RC..." }` | `{ "data": { "credits": 5, "balance": 105, "ledgerId": "..." } }` | 原子 claim + `grant` 入账；重复、过期、撤销分别返回稳定错误。   |

结账请求允许携带 `couponCode`，但优惠券只能影响 `order.kind = "credit_pack"` 的充值订单；确认后的折扣、金额和优惠券引用必须写入订单。订阅结账继续按原有订阅规则运行。

### 6.2 平台 admin 接口

所有 `/api/admin/coupons`、`/api/admin/redemption-codes` 路由依次使用 `requireAuth`、`requirePlatformAdmin`、请求来源保护和 `API_RATE_LIMITER`，不使用 `requireWorkspaceManager`。建议接口如下：

- `POST /api/admin/coupons`：发行一批优惠券，body 为 `rate`、`count`、`validDays`、`note`、`source`；`count` 范围 `1..100`。
- `GET /api/admin/coupons/:code`、`DELETE /api/admin/coupons/:code`：查状态、撤销。
- `POST /api/admin/redemption-codes`：发行一批兑换码，body 为 `credits`、`count`、`validDays`、`note`、`source` 和可选 `idempotencyKey`；`count` 范围 `1..100`，`credits` 为整数。
- `GET /api/admin/redemption-codes/:code`、`DELETE /api/admin/redemption-codes/:code`：查状态、撤销。
- `GET /api/admin/redemption-codes/issuance-status`：返回 UTC 当日 `creditsIssued`、`creditsRemaining`、`dailyCreditsCap`、`codeCount` 和 `capReached`。

发码和撤销都写结构化审计事件，至少包含 `actorUserId`、`action`、对象 ID、数量、参数摘要、`requestId` 和结果；不得记录任何外部 token，不在日志中记录可直接滥用的完整码批次。审计事件使用现有 `logEvent`/observability 管道，且不能因为日志失败而回滚已经成功的业务写入。

### 6.3 对外兑换码 API

对外路径为 `/api/external/redemption-codes`，只接受 `EXTERNAL_REDEMPTION_CODE_API_TOKEN`。鉴权支持二选一：`Authorization: Bearer <TOKEN>` 或 `x-api-token: <TOKEN>`；若两者同时存在，按 `Authorization` 校验。优惠券 token 必须返回 `401`。

- `POST /api/external/redemption-codes`：发行 `credits`、`count`、`validDays`、`note`、`source`；`credits` 默认 `5`，`validDays` 默认 `30`，`count <= 100`；用 `Idempotency-Key` 保证安全重试，成功返回 `201` 和 `codes` 数组。
- `GET /api/external/redemption-codes/issuance-status`：返回当日发行额度，不创建代码。
- `GET /api/external/redemption-codes/:code`：返回 `code`、`credits`、`status`、`expiresAt`、`redeemedAt`、`revokedAt`、`note`、`source`、`createdAt`、`redeemedByUserId`。
- `DELETE /api/external/redemption-codes/:code`：撤销未兑换代码；重复撤销返回原撤销结果，已兑换返回 `409`。

发行触及每日额度返回 `429`；同 key 不同参数返回 `409`；输入错误返回 `400`；不存在返回 `404`；服务端 token 未配置返回 `503`；其他暂时性故障返回 `500`。所有响应 `Cache-Control: no-store`。

### 6.4 对外优惠券 API

对外路径为 `/api/external/coupons`，只接受 `EXTERNAL_COUPON_API_TOKEN`，鉴权头与兑换码 API 相同，但两 token 绝不互通。只提供：

- `GET /api/external/coupons/:code`：返回 `code`、`rate`、`status`、`expiresAt`、`reservedAt`、`redeemedAt`、`revokedAt`、`note`、`source`、`createdAt`，并明确预留与支付确认状态。
- `DELETE /api/external/coupons/:code`：撤销未确认使用的代码；重复撤销幂等，已确认或正在结账竞争时返回 `409`。

不提供 `POST /api/external/coupons`。不得以兑换码 API 作为优惠券创建的隐式别名。无效 token `401`、格式错误 `400`、不存在 `404`、服务未配置 `503`、服务端故障 `500`；所有响应不缓存。

T8 需要把以上契约、鉴权示例、字段表、状态、错误码、幂等重放示例和重试建议单独写入 `docs/api-external-coupons-redemption-codes.md`，体例参考 CodeByAi 的 `EXTERNAL_REDEMPTION_CODE_API.md`，但必须使用本模板的 `credits` 语义。

## 7. 计费一致性与失败恢复

- 优惠券预留、Stripe 订单写入、最终金额和引用必须可由同一 `order` 恢复；预览不得改变账本或优惠券消耗状态。
- 支付成功确认、credits `grant`、订单标记 `paid` 和 Stripe `payment_event` 完成标记必须使用现有 webhook 幂等模式；任何 webhook 重试最多产生一笔优惠券确认和一笔账本入账。
- 兑换码的 `claim` 与 `credit_ledger` 插入失败时整体回滚；使用固定 idempotency key 防止超时重试重复发钱。
- 发行幂等、Stripe webhook lease、订单恢复任务、优惠券释放任务和账本唯一索引共同构成防重复边界，rate limit 只用于防滥用，不承担资金或 credits 一致性。
- 所有状态迁移必须是条件更新，不能用先读后写作为并发控制；并发兑换、撤销与兑换、支付成功与释放都要以 D1 条件写入结果决定胜负。
- 失败消息同时提供 en 与 zh-CN 文案；服务端错误日志包含 `requestId`、对象 ID 和可重试判断，不记录 token 或完整敏感凭证。

## 8. 双语与前端要求

新增用户可见文案加入 `src/client/i18n.ts` 的 en/zh-CN 资源，覆盖输入提示、预览结果、已使用、过期、撤销、兑换成功、余额更新、权限不足、每日额度用尽和网络重试。新增页面沿用现有 AppShell、`WorkspaceSession.isPlatformAdmin` 和 `apiRequest`，不在前端复制状态机或折扣计算。

增加 `/app/admin/codes` 平台 admin 页面，至少包含优惠券/兑换码切换、批量发行表单、发行额度、代码搜索、状态详情、撤销确认和最近操作结果。普通用户不应通过前端路由或 API 看到平台 admin 数据；直接调用 API 仍由服务端返回 `403`。

## 9. 验收标准总表

### A. 优惠券

- A1：发行或测试构造 `rate = 0`、负数、小数、`> 50` 均被拒绝；`1..50` 的整数可用，存储和金额计算无浮点。
- A2：默认有效期为创建后 `7` 天，指定有效期不得超过 `7` 天；到期、撤销、已确认使用的代码不能通过预览或结账。
- A3：生成的代码全部匹配 `^CB[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$`；大小写输入得到同一条记录，数据库只保存大写。
- A4：同一代码的第二次成功支付不能再次享受折扣；同一代码的两个并发结账最多一个得到预留。
- A5：预览接口不会改变 `status`、预留字段、订单或 `credit_ledger`；用户能看到有效折扣和过期时间。
- A6：结账使用最大折扣候选，绝不叠加；折后金额为整数最小货币单位；Stripe 中不存在为此创建的 native coupon/promotion code。
- A7：支付成功确认；支付失败、取消或放弃后预留在 `60` 分钟内释放；释放任务与支付成功竞争时不会把已支付订单重新开放。
- A8：外部核查与撤销遵守独立 token、状态、`404`/`409`/`503` 错误和不缓存要求。

### B. 兑换码

- B1：未提供面值时发行 `5` credits；非正数、小数、超出安全整数的面值拒绝；绝不出现美元字段或汇率换算。
- B2：`validDays` 默认 `30` 天，超过 `365` 天或到期后不能兑换；撤销后不能兑换。
- B3：每日 UTC 发行总量按整数 credits 原子扣减，达到 `REDEMPTION_CODE_DAILY_CREDITS_CAP` 后返回 `429`；批量中途失败不消耗额度。
- B4：同一 `Idempotency-Key` 的同参重放返回完全相同的批次，不产生第二批；不同参数返回 `409`。
- B5：至少两路并发兑换同一码时恰好一路成功；恰好一条 `grant` 账本流水和一次余额变化，失败方不产生流水。
- B6：兑换入当前 workspace 的 `creditAccount`，成功响应余额与事务提交后的实际余额一致；账本 `idempotencyKey` 可重放且不重复入账。
- B7：登录用户预览不 claim、不入账；兑换、过期、撤销、已使用均有稳定 reason 和 en/zh-CN 文案。
- B8：外部核查、撤销、发行上限和 token 隔离符合 6.3 的契约。

### C. 对外 API

- C1：兑换码 token 和优惠券 token 互相调用均返回 `401`，正确 token 只获得自己的资源和动作。
- C2：两种 header 均可鉴权，缺 token、错误 token、服务端未配置分别得到明确状态码；响应不缓存并带 `x-request-id`。
- C3：兑换码发行每请求最多 `100` 个，支持发行状态查询、幂等重放和错误码文档。
- C4：对外不存在优惠券创建接口；`GET`/`DELETE` 可核查和撤销已有优惠券。

### D. 管理端

- D1：只有 `PLATFORM_ADMIN_USER_IDS` 中的登录用户能访问页面和管理 API；workspace `owner`/`admin` 单独不能访问。
- D2：平台 admin 能分别发行优惠券和兑换码、查询状态、撤销未使用代码，界面显示每日兑换码发行额度。
- D3：每次发码至少记录 actor、动作、对象/批次、数量、结果和 `requestId` 的结构化审计事件；token 和完整密钥不落日志。
- D4：所有用户可见文案 en 与 zh-CN 完整；刷新、重复提交、权限失败不会导致重复发码。

### E. 计费一致性

- E1：Stripe webhook 重试、订单状态轮询、定时释放和网络超时均不会重复确认优惠券、重复发放 credits 或重复扣减。
- E2：任一业务步骤失败后可由重试或恢复任务继续，不能留下“已支付但未入账”或“已入账但代码仍可用”的状态。
- E3：D1 迁移可应用，账本触发器继续工作，`pnpm check` 全部通过。

## 10. 原子任务拆解

每个任务只解决一个目标，能独立提交、评审和回滚；任务之间按依赖顺序执行。

### T1：建立优惠券与兑换码的 D1 数据基础

- **目标**：新增 `coupon`、`redemption_code` schema 和订单优惠券字段，并生成下一编号 SQL 迁移。
- **验收标准**：迁移在 Workers pool/local D1 可应用；唯一、范围、外键、索引和时间约束生效；既有组织、订单、账本数据不变；无运行时建表。
- **涉及文件**：`src/server/db/schema.ts`、`migrations/0009_*.sql`、`migrations/meta/*`。
- **依赖**：无。

### T2：抽取可重用的 credits grant 与幂等边界

- **目标**：提供只通过 `credit_ledger` 写入 `grant` 的服务函数，供兑换码和支付恢复共同使用。
- **验收标准**：同一 `(organizationId, idempotencyKey)` 重放只产生一笔流水；余额由现有触发器更新；失败不会留下半条 claim；服务返回实际提交后的账本/余额信息。
- **涉及文件**：`src/server/modules/billing/service.ts` 或新增 `src/server/modules/billing/credit-grant.ts`、相关 `test/*`。
- **依赖**：T1。

### T3：实现优惠券领域服务与登录用户预览

- **目标**：实现代码生成/规范化、状态判断、发行核心、查询、撤销和 `POST /api/billing/coupons/validate`。
- **验收标准**：A1-A5、A8 的服务级规则通过；预览绝不消耗；撤销与并发状态更新使用条件写入；Hono 路由复用 `requireAuth`、rate limit、origin/observability。
- **涉及文件**：新增 `src/server/modules/coupons/service.ts`、`src/server/modules/coupons/routes.ts`，`src/server/index.ts`，相关 `test/*`。
- **依赖**：T1、T2。

### T4：把优惠券接入 Stripe 充值结账

- **目标**：完成 credit pack 订单的优惠券预留、最大折扣计算、支付确认和 `60` 分钟内释放。
- **验收标准**：A6-A7、E1-E2 通过；订单可恢复优惠券关系；Stripe webhook/轮询/定时任务幂等；不创建 Stripe native coupon/promotion code；现有订阅路径行为不变。
- **涉及文件**：`src/server/modules/billing/routes.ts`、`src/server/modules/billing/stripe.ts`、`src/server/modules/billing/direct-qr-routes.ts`、`src/server/modules/billing/direct-qr-service.ts`、`src/server/modules/billing/catalog.ts`、相关 `test/*`。
- **依赖**：T3。

### T5：实现兑换码发行核心、预览与原子兑换

- **目标**：实现发行幂等、UTC 每日额度、查询/撤销、登录用户预览和原子 claim + `grant`。
- **验收标准**：B1-B7、E1-E2 通过；并发兑换恰好一次成功；同 key 同参返回原批次；批量超过 `100`、额度不足、过期、撤销均返回稳定结果；余额属于当前 active workspace。
- **涉及文件**：新增 `src/server/modules/redemption-codes/service.ts`、`src/server/modules/redemption-codes/routes.ts`，`src/server/modules/billing/service.ts`（仅调用 T2），相关 `test/*`。
- **依赖**：T1、T2。

### T6：增加两套独立 token 的对外 API

- **目标**：发布兑换码发行/核查/撤销和优惠券核查/撤销的 `/api/external` 路由。
- **验收标准**：C1-C4 通过；支持 `Authorization Bearer` 与 `x-api-token`；两个 token 不能互用；发行上限 `100`、`Idempotency-Key`、`400/401/404/409/429/500/503` 和 `no-store` 行为稳定；路由注册在 `/api` catch-all 之前。
- **涉及文件**：新增 `src/server/modules/external-codes/routes.ts`、`src/server/modules/external-codes/auth.ts`（或等价命名）、`src/server/index.ts`、`.env.example`、`.dev.vars.example`、相关 `test/*`。
- **依赖**：T3、T5。

### T7：完成平台 admin 发码与管理页面

- **目标**：在既有平台 admin 体系内提供优惠券/兑换码发码、查码、撤销和额度查看。
- **验收标准**：D1-D4 通过；服务端始终执行 `requirePlatformAdmin`；双击/刷新不重复发行；发码和撤销写审计事件；页面覆盖 en/zh-CN 并复用现有 session 能力。
- **涉及文件**：新增 `src/server/modules/admin-codes/routes.ts` 或并入对应 admin module、`src/client/pages/admin-codes-page.tsx`、`src/client/app.tsx`、`src/client/components/app-shell.tsx`、`src/client/i18n.ts`、`src/client/styles.css`、相关 `test/*`。
- **依赖**：T3、T5、T6。

### T8：编写对外 API 文档

- **目标**：把实际可用的两套 token API 写成独立集成文档。
- **验收标准**：文档包含鉴权头、token 隔离、所有路径/字段/默认值/上限、状态、幂等、错误码、重试策略、`curl` 示例和 credits 语义；明确没有优惠券创建接口；示例与实现逐项一致。
- **涉及文件**：新增 `docs/api-external-coupons-redemption-codes.md`。
- **依赖**：T6。

### T9：补齐核心测试并通过 `pnpm check`

- **目标**：验证核心规则并完成格式、lint、类型、测试和构建收尾。
- **验收标准**：vitest Workers pool 覆盖单次兑换并发安全、发行幂等重放、过期/撤销、折扣上限与取最大、优惠券预留/确认/释放、token 隔离、每日额度和 webhook 重试；`pnpm check` 中 format、lint、typecheck、test、build 全部通过。
- **涉及文件**：新增或修改 `test/*`、必要的实现文件和测试夹具；不得为了通过检查删减既有测试。
- **依赖**：T1-T8。

## 11. 需要注意的现状冲突

当前 `src/server/modules/billing/stripe.ts` 的 `createStripeCheckout` 是 `mode: "subscription"` 的订阅结账，并且设置了 `allow_promotion_codes: true`；当前一次性 `order.kind = "credit_pack"` 由 `/api/billing/qr` 创建 Stripe `PaymentIntent`。因此“在 Stripe 充值结账应用优惠券”与“改动现有订阅、使用 Stripe 原生 coupon”不能直接对应同一个现有入口。

本文按“不改现有订阅、不使用 Stripe 原生 coupon”的决策，将优惠券目标限定为 `credit_pack` 充值订单，并要求 T4 接入现有直充 PaymentIntent。2026-11-14 用户已拍板：优惠券只接直充二维码，不新增卡片式 credit pack Checkout。同时开发时应审查并关闭现有 `allow_promotion_codes` 对本需求路径的影响，避免非本需求的 Stripe 原生 promotion code 与内部优惠券混用。
