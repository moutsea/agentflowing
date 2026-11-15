# 外部优惠券与兑换码 API

本文档描述当前 Worker 实际挂载的两套 `/api/external` 接口。兑换码面值只使用整数 `credits`；接口不定义货币金额字段，也不做汇率换算。

## 鉴权与通用约定

每个请求必须使用下面两种写法之一：

```http
Authorization: Bearer <TOKEN>
```

或：

```http
x-api-token: <TOKEN>
```

鉴权 header 字段：

| Header          | 类型   | 必填                      | 默认值 | 上限/规则                                 |
| --------------- | ------ | ------------------------- | ------ | ----------------------------------------- |
| `Authorization` | string | 与 `x-api-token` 二选一   | 无     | 必须是 `Bearer <TOKEN>`；若存在则优先校验 |
| `x-api-token`   | string | 与 `Authorization` 二选一 | 无     | 使用对应资源的 token；无单独长度上限      |

当两个 header 同时存在时，服务端只校验 `Authorization`。因此，即使 `x-api-token` 正确，只要 `Authorization` 缺少 `Bearer`、格式错误或 token 错误，结果仍为 `401`。

两套 token 完全隔离：

| 资源   | 服务端配置                           | 可访问路径                         |
| ------ | ------------------------------------ | ---------------------------------- |
| 兑换码 | `EXTERNAL_REDEMPTION_CODE_API_TOKEN` | `/api/external/redemption-codes/*` |
| 优惠券 | `EXTERNAL_COUPON_API_TOKEN`          | `/api/external/coupons/*`          |

通过 `Origin` 检查后，把另一套 token 用在错误资源上返回 `401`；写请求若显式携带错误的 `Origin`，会先返回 `403`，尚未进入 token 鉴权。对应服务端 token 未配置或为空时返回 `503`。token 不出现在响应、日志或示例中；本文示例只使用占位符 `<TOKEN>`。

所有下列接口响应都带：

```http
Cache-Control: no-store
x-request-id: <REQUEST_ID>
```

服务端会生成 `x-request-id`，或回显符合格式的请求头值。时间字段均为 ISO 8601 UTC 字符串；没有值时为 `null`。

写请求若显式带 `Origin`，必须与服务端 `APP_URL` 的 origin 一致，否则返回 `403`。没有 `Origin` 的命令行请求不会触发这一项检查。

## 兑换码 API

兑换码格式为 `RC` 加 12 个字符，字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`。路径参数会转为大写并去除空格和连字符后校验。

### `POST /api/external/redemption-codes`

发行一批兑换码。成功状态为 `201 Created`，返回 `codes` 数组。请求 JSON 是严格字段集，未知字段会得到 `400`。

请求 body：

| 字段        | 类型             | 必填 | 默认值  | 上限/规则                                                 |
| ----------- | ---------------- | ---- | ------- | --------------------------------------------------------- |
| `credits`   | integer          | 否   | `5`     | 正的安全整数，最大 `9007199254740991`；面值单位是 credits |
| `count`     | integer          | 否   | `1`     | `1..100`                                                  |
| `validDays` | integer          | 否   | `30`    | `1..365` 天                                               |
| `note`      | string 或 `null` | 否   | `null`  | 服务端会 trim；无单独长度上限                             |
| `source`    | string           | 否   | `admin` | 空字符串 trim 后也使用 `admin`；无单独长度上限            |

幂等请求头：

| Header            | 类型   | 必填 | 默认值                       | 上限/规则                                                   |
| ----------------- | ------ | ---- | ---------------------------- | ----------------------------------------------------------- |
| `Idempotency-Key` | string | 否   | 未提供时由服务端生成随机 key | trim 后必须为 `1..128` 个字符；重试发行时必须复用同一个 key |

成功响应：

```json
{
  "codes": [
    {
      "code": "RCABCDEFGHJKLM",
      "credits": 5,
      "status": "active",
      "expiresAt": "2026-12-14T00:00:00.000Z",
      "redeemedAt": null,
      "revokedAt": null,
      "note": null,
      "source": "admin",
      "createdAt": "2026-11-14T00:00:00.000Z",
      "redeemedByUserId": null
    }
  ]
}
```

| 字段    | 类型          | 说明                                                 |
| ------- | ------------- | ---------------------------------------------------- |
| `codes` | array<object> | 本次发行的 code 对象数组，元素数量等于请求的 `count` |

`codes` 中每个对象的字段：

| 字段               | 类型                                   | 说明                        |
| ------------------ | -------------------------------------- | --------------------------- |
| `code`             | string                                 | 生成的兑换码                |
| `credits`          | integer                                | 此码可兑换的 credits        |
| `status`           | `active \| expired \| revoked \| used` | 新发行的码为 `active`       |
| `expiresAt`        | string                                 | 到期时间                    |
| `redeemedAt`       | string 或 `null`                       | 成功兑换时间                |
| `revokedAt`        | string 或 `null`                       | 撤销时间                    |
| `note`             | string 或 `null`                       | 请求中的备注                |
| `source`           | string                                 | 来源，默认 `admin`          |
| `createdAt`        | string                                 | 创建时间                    |
| `redeemedByUserId` | string 或 `null`                       | 兑换用户；未兑换时为 `null` |

每日额度以 UTC 日为边界，按整数 credits 原子扣减。`REDEMPTION_CODE_DAILY_CREDITS_CAP` 未配置或不是有限数字时使用实现中的默认值 `5000`；批次所需 `credits * count` 超过剩余额度时返回 `429`，不会部分发行或消耗额度。

### `GET /api/external/redemption-codes/issuance-status`

只查询当前 UTC 日的发行量，不创建代码。成功状态为 `200 OK`。

请求字段：

| 位置 | 字段 | 类型 | 必填 | 默认值 | 上限/规则                   |
| ---- | ---- | ---- | ---- | ------ | --------------------------- |
| —    | 无   | —    | —    | —      | 无 body、query 或 path 参数 |

成功响应字段：

| 字段               | 类型    | 说明                                      |
| ------------------ | ------- | ----------------------------------------- |
| `creditsIssued`    | integer | 当日已发行的 credits 总量                 |
| `creditsRemaining` | integer | `max(0, dailyCreditsCap - creditsIssued)` |
| `dailyCreditsCap`  | integer | 当前每日 credits 上限                     |
| `codeCount`        | integer | 当日发行的兑换码数量                      |
| `capReached`       | boolean | `creditsIssued >= dailyCreditsCap`        |

### `GET /api/external/redemption-codes/:code`

查询单个兑换码。格式错误的 `:code` 返回 `400`；格式正确但不存在返回 `404`。成功状态为 `200 OK`，响应对象字段与发行响应中的单个 code 对象相同。

请求字段：

| 位置 | 字段   | 类型   | 必填 | 默认值 | 上限/规则                                                |
| ---- | ------ | ------ | ---- | ------ | -------------------------------------------------------- |
| path | `code` | string | 是   | 无     | `^RC[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$`（规范化后） |

成功响应字段：使用“`POST` 发行”中的单个 code 对象字段表。

### `DELETE /api/external/redemption-codes/:code`

撤销尚未兑换的兑换码。成功状态为 `200 OK`，返回被撤销的 code 对象（`status: "revoked"`）。对已经撤销的 code 重复调用返回原撤销结果并保持 `200`；已兑换的 code 返回 `409`。

请求字段：

| 位置 | 字段   | 类型   | 必填 | 默认值 | 上限/规则                                                |
| ---- | ------ | ------ | ---- | ------ | -------------------------------------------------------- |
| path | `code` | string | 是   | 无     | `^RC[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$`（规范化后） |

成功响应字段：使用“`POST` 发行”中的单个 code 对象字段表。

兑换码状态含义：

| `status`  | 含义                           |
| --------- | ------------------------------ |
| `active`  | 未过期、未撤销、未兑换，可兑换 |
| `expired` | `expiresAt` 已到期             |
| `revoked` | 已撤销，不能兑换               |
| `used`    | 已兑换，不能再次兑换           |

兑换动作由登录用户接口执行；对外接口只发行、查询和撤销。登录用户兑换语义中的格式错误可使用 `invalid_code`，但它不是外部 GET/DELETE 的响应值。外部 GET/DELETE 的 code 格式错误统一返回 `400` 和 `error: "invalid_request"`；格式正确但不存在返回 `not_found`（`404`）。兑换相关的 `expired`、`revoked`、`already_used` 表示状态冲突（`409`）。

### 发行幂等

`Idempotency-Key` 的参数指纹包含 `credits`、`count`、`validDays`、`note` 和 `source`。同一个 key 搭配相同参数重放会返回原批次（代码、顺序、面值及有效期不变）和 `201`，不会生成第二批；状态及兑换/撤销字段反映查询时的当前事实，与 GET 核查一致，不是发行时快照。同一个 key 搭配不同参数返回 `409`，错误为 `idempotency_conflict`。并发使用同一个 key 时只有一个事务占用每日额度，其余请求重放已提交的同一批次。没有提供 key 时每次请求都会生成新 key，不能依靠超时重试来去重。

例如，网络超时后完整重放下面的请求会得到原批次（仍为 `201`）：

```bash
curl -i -X POST 'https://api.example.com/api/external/redemption-codes' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-issue-001' \
  --data '{"credits":5,"count":2,"validDays":30,"note":"demo","source":"partner"}'
```

若保留 `demo-issue-001` 却把 `count` 改成 `1`，响应为 `409 idempotency_conflict`。

## 优惠券 API

优惠券格式为 `CB` 加 10 个字符，字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`。路径参数会 trim 并转为大写后校验。

优惠券接口只接受 `EXTERNAL_COUPON_API_TOKEN`，只提供查询和撤销。**没有 `POST /api/external/coupons` 创建接口**；兑换码发行 API 也不是优惠券创建的别名。调用该 POST 路径在资源 token 已认证后返回 `404`；未认证（缺少或错误 token）时返回 `401`。

### `GET /api/external/coupons/:code`

查询优惠券。格式错误返回 `400`，不存在返回 `404`，成功状态为 `200 OK`。

请求字段：

| 位置 | 字段   | 类型   | 必填 | 默认值 | 上限/规则                                                |
| ---- | ------ | ------ | ---- | ------ | -------------------------------------------------------- |
| path | `code` | string | 是   | 无     | `^CB[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$`（规范化后） |

成功响应字段：

| 字段                  | 类型                                    | 说明                                           |
| --------------------- | --------------------------------------- | ---------------------------------------------- |
| `code`                | string                                  | 优惠券代码                                     |
| `rate`                | integer                                 | 折扣百分比整数，范围由优惠券服务保证为 `1..50` |
| `status`              | `active \| used \| expired \| revoked`  | 对外状态；内部 `reserved` 映射为 `used`        |
| `expiresAt`           | string                                  | 到期时间                                       |
| `reservedAt`          | string 或 `null`                        | 预留时间                                       |
| `redeemedAt`          | string 或 `null`                        | 支付确认并最终使用的时间                       |
| `revokedAt`           | string 或 `null`                        | 撤销时间                                       |
| `note`                | string 或 `null`                        | 备注                                           |
| `source`              | string                                  | 来源                                           |
| `createdAt`           | string                                  | 创建时间                                       |
| `usageState`          | `available \| reserved \| redeemed`     | 细分使用状态                                   |
| `isReservationActive` | boolean                                 | 当前预留是否仍有效                             |
| `reservationStatus`   | `reserved \| not_reserved`              | 是否存在当前预留                               |
| `paymentStatus`       | `pending \| confirmed \| not_confirmed` | 支付确认状态                                   |

预留和支付确认的区分：

| 外部响应                                                                                                                             | 含义                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status: "active"`, `usageState: "available"`, `reservationStatus: "not_reserved"`, `paymentStatus: "not_confirmed"`                 | 可用，尚未预留                                                                                                                                                                       |
| `status: "used"`, `usageState: "reserved"`, `isReservationActive: true`, `reservationStatus: "reserved"`, `paymentStatus: "pending"` | 仅为结账预留，尚未支付确认；内部 `reserved` 对外显示为 `used`                                                                                                                        |
| `status: "used"`, `usageState: "redeemed"`, `redeemedAt` 非 `null`, `paymentStatus: "confirmed"`                                     | 支付已确认并最终使用                                                                                                                                                                 |
| `status: "expired"`                                                                                                                  | 已过期，不可新使用；到期前建立且尚未释放的预留仍返回 `usageState: "reserved"`、`reservationStatus: "reserved"` 和 `paymentStatus: "pending"`，`isReservationActive` 独立反映预留窗口 |
| `status: "revoked"`                                                                                                                  | 已撤销                                                                                                                                                                               |

### `DELETE /api/external/coupons/:code`

撤销尚未确认使用的优惠券。成功状态为 `200 OK`，返回完整优惠券详情且 `status: "revoked"`。重复撤销是幂等的，返回原撤销结果和 `200`。已支付确认或正在结账预留竞争时返回 `409`，错误分别可能为 `already_used` 或 `reserved`；其他并发状态变化返回 `conflict`。

请求字段：

| 位置 | 字段   | 类型   | 必填 | 默认值 | 上限/规则                                                |
| ---- | ------ | ------ | ---- | ------ | -------------------------------------------------------- |
| path | `code` | string | 是   | 无     | `^CB[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$`（规范化后） |

成功响应字段：使用“`GET` 优惠券核查”中的完整优惠券详情字段表。

## 状态码与错误响应

除成功响应外，服务端错误响应均为 JSON，并带 `Cache-Control: no-store` 与 `x-request-id`。常见结构如下；`reason` 在对应领域错误中提供，通用校验错误可能只有 `error`：

```json
{
  "error": "invalid_request",
  "reason": "invalid_request",
  "message": "The request is invalid.",
  "messages": {
    "en": "The request is invalid.",
    "zh-CN": "请求无效。"
  }
}
```

| HTTP  | `error`/`reason` 示例                                          | 含义与处理                                                                                        |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `400` | `invalid_request`                                              | 输入、JSON schema、字段范围或代码格式错误；修正请求后再发                                         |
| `401` | `unauthorized`                                                 | 缺少 token、token 错误、使用了另一资源的 token，或两个 header 同时存在但 `Authorization` 校验失败 |
| `403` | `forbidden`                                                    | 写请求显式携带了与 `APP_URL` 不同的 `Origin`                                                      |
| `404` | `not_found`                                                    | 资源不存在，或已认证资源下未实现的路径/方法；`POST /api/external/coupons` 也属于此类              |
| `409` | `idempotency_conflict`、`already_used`、`reserved`、`conflict` | 同 key 不同参数、已兑换/已确认、结账预留竞争或状态并发冲突                                        |
| `429` | `daily_cap_reached`、`rate_limited`                            | 达到每日 credits 发行额度，或触发 API 限流；限流响应带 `Retry-After`                              |
| `500` | `internal_error`                                               | 暂时性服务端故障，响应文案提示可重试                                                              |
| `503` | `service_unavailable`                                          | 对应资源的服务端 token 未配置                                                                     |

兑换码发行触及每日额度使用 `daily_cap_reached`；它与一般请求限流的 `rate_limited` 都是 `429`，但前者通常应等到下一个 UTC 日或额度调整后再试。

## 重试策略

- `429`：指数退避并加入抖动；若有 `Retry-After`，至少等待该时长。每日额度错误应等待额度恢复。发行请求每次重试必须带相同的 `Idempotency-Key` 和相同 body。
- `500`：按指数退避重试。发行请求仍必须复用同一个 `Idempotency-Key`，以便恢复已提交批次而不重复发码。
- `400`、`401`、`404`、`409`：不可盲目重试；修正输入、鉴权、资源或幂等参数，或等待业务状态改变后再发起新的请求。`409 idempotency_conflict` 必须更换 key 或恢复原 body。
- `403`：修正 `Origin` 后再试。`503` 需要服务端先配置对应 token，不应在未配置时循环重试。

## curl 示例

以下命令中的 `<TOKEN>` 必须替换为调用方自己的 token。示例 code 使用合法格式的占位 code，查询不存在时会按契约返回 `404`。

### 兑换码发行（两种鉴权头）

```bash
curl -i -X POST 'https://api.example.com/api/external/redemption-codes' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-issue-001' \
  --data '{"credits":5,"count":2,"validDays":30,"note":"demo","source":"partner"}'
```

```bash
curl -i -X POST 'https://api.example.com/api/external/redemption-codes' \
  -H 'x-api-token: <TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-issue-001' \
  --data '{"credits":5,"count":2,"validDays":30,"note":"demo","source":"partner"}'
```

### 兑换码发行状态

```bash
curl -i 'https://api.example.com/api/external/redemption-codes/issuance-status' \
  -H 'Authorization: Bearer <TOKEN>'
```

### 兑换码查询

```bash
curl -i 'https://api.example.com/api/external/redemption-codes/rcabcdefghjklm' \
  -H 'x-api-token: <TOKEN>'
```

### 兑换码撤销

```bash
curl -i -X DELETE 'https://api.example.com/api/external/redemption-codes/RCABCDEFGHJKLM' \
  -H 'Authorization: Bearer <TOKEN>'
```

### 优惠券查询

```bash
curl -i 'https://api.example.com/api/external/coupons/cbabcdefghjk' \
  -H 'Authorization: Bearer <TOKEN>'
```

### 优惠券撤销

```bash
curl -i -X DELETE 'https://api.example.com/api/external/coupons/CBABCDEFGHJK' \
  -H 'x-api-token: <TOKEN>'
```
