import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit, RateLimitExceededError } from "../../middleware/rate-limit";
import { requirePlatformAdmin } from "../../middleware/platform-admin";
import { logEvent } from "../../observability";
import type { AppContext } from "../../types";
import type { Coupon } from "../../db/schema";
import {
  CouponServiceError,
  CouponValidationError,
  couponBpsToRate,
  getCouponView,
  isCouponCodeFormat,
  issueCoupons,
  normalizeCouponCode,
  revokeCoupon,
} from "../coupons/service";
import {
  getRedemptionCode,
  getRedemptionCodeIssuanceStatus,
  isRedemptionCodeFormat,
  issueRedemptionCodes,
  normalizeRedemptionCode,
  RedemptionCodeDailyCapError,
  RedemptionCodeError,
  RedemptionCodeIdempotencyConflictError,
  RedemptionCodeValidationError,
  revokeRedemptionCode,
} from "../redemption-codes/service";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_NOTE_LENGTH = 1000;
const MAX_SOURCE_LENGTH = 128;

const couponIssueSchema = z
  .object({
    rate: z.number().int().min(1).max(50),
    count: z.number().int().min(1).max(100),
    validDays: z.number().int().min(1).max(7).optional(),
    note: z.string().trim().max(MAX_NOTE_LENGTH).nullable().optional(),
    source: z.string().trim().max(MAX_SOURCE_LENGTH).optional(),
  })
  .strict();

const redemptionIssueSchema = z
  .object({
    credits: z.number().int().positive().safe().optional(),
    count: z.number().int().min(1).max(100),
    validDays: z.number().int().min(1).max(365).optional(),
    note: z.string().trim().max(MAX_NOTE_LENGTH).nullable().optional(),
    source: z.string().trim().max(MAX_SOURCE_LENGTH).optional(),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const invalidRequest = {
  error: "invalid_request",
  message: "Check the issuance fields and try again.",
  messages: {
    en: "Check the issuance fields and try again.",
    "zh-CN": "请检查发码参数后重试。",
  },
} as const;

const validateCouponIssue = zValidator("json", couponIssueSchema, (result, context) => {
  if (!result.success) return context.json(invalidRequest, 400, NO_STORE);
});

const validateRedemptionIssue = zValidator("json", redemptionIssueSchema, (result, context) => {
  if (!result.success) return context.json(invalidRequest, 400, NO_STORE);
});

/** Headers are set before auth so 401/403 responses are never cacheable. */
const setAdminHeaders = createMiddleware<AppContext>(async (context, next) => {
  context.header("cache-control", "no-store");
  await next();
});

const protectAdminRequest = createMiddleware<AppContext>(async (context, next) => {
  const origin = context.req.header("origin");
  if (origin && origin !== new URL(context.env.APP_URL).origin) {
    return context.json(
      {
        error: "forbidden",
        message: "Invalid request origin",
        messages: { en: "Invalid request origin", "zh-CN": "请求来源无效。" },
      },
      403,
      NO_STORE,
    );
  }
  await next();
});

const limitAdminRequest = createMiddleware<AppContext>(async (context, next) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `admin-codes:${context.var.user.id}`,
    scope: "admin_codes",
    requestId: context.var.requestId,
  });
  await next();
});

class AdminIdempotencyConflictError extends Error {
  readonly status = 409 as const;
  readonly reason = "idempotency_conflict" as const;
  readonly messages = {
    en: "The Idempotency-Key was already used with different parameters.",
    "zh-CN": "Idempotency-Key 已用于不同的参数。",
  } as const;

  constructor() {
    super("The Idempotency-Key was already used with different parameters.");
    this.name = "AdminIdempotencyConflictError";
  }
}

type CouponBatch = Awaited<ReturnType<typeof issueCoupons>>;
type CouponReplay = {
  fingerprint: string;
  createdAt: number;
  promise: Promise<CouponBatch>;
};

// Coupon rows predate an idempotency column. Keep the replay boundary scoped to
// the D1 binding so tests, local databases, and separate Worker isolates cannot
// accidentally replay a batch from another database. The client also disables
// duplicate submission; this cache covers an in-flight retry in one isolate.
const couponReplayByDatabase = new WeakMap<object, Map<string, CouponReplay>>();

function couponReplayMap(env: Env) {
  const database = env.DB as unknown as object;
  let map = couponReplayByDatabase.get(database);
  if (!map) {
    map = new Map();
    couponReplayByDatabase.set(database, map);
  }
  return map;
}

function issueFingerprint(input: Record<string, unknown>) {
  return JSON.stringify({
    rate: input.rate,
    count: input.count,
    validDays: input.validDays ?? null,
    note: typeof input.note === "string" ? input.note.trim() || null : (input.note ?? null),
    source: typeof input.source === "string" ? input.source.trim() || "admin" : "admin",
  });
}

async function issueCouponsWithReplay(
  env: Env,
  key: string | undefined,
  actorUserId: string,
  input: Parameters<typeof issueCoupons>[0],
) {
  if (!key) return { batch: await issueCoupons(input), replayed: false };
  const replayKey = `${actorUserId}:${key}`;
  const fingerprint = issueFingerprint(input as unknown as Record<string, unknown>);
  const map = couponReplayMap(env);
  const existing = map.get(replayKey);
  if (existing && Date.now() - existing.createdAt < 15 * 60 * 1000) {
    if (existing.fingerprint !== fingerprint) throw new AdminIdempotencyConflictError();
    return { batch: await existing.promise, replayed: true };
  }
  map.delete(replayKey);
  const promise = issueCoupons(input);
  map.set(replayKey, { fingerprint, createdAt: Date.now(), promise });
  promise.catch(() => {
    const current = map.get(replayKey);
    if (current?.promise === promise) map.delete(replayKey);
  });
  return { batch: await promise, replayed: false };
}

function iso(value: Date | number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
}

type CouponResponseInput = Coupon | NonNullable<Awaited<ReturnType<typeof getCouponView>>>;

function couponResponse(view: CouponResponseInput | null) {
  if (!view) return null;
  const internalStatus = "internalStatus" in view ? view.internalStatus : view.status;
  const status =
    "usageState" in view
      ? view.status
      : internalStatus === "revoked"
        ? "revoked"
        : internalStatus === "used"
          ? "used"
          : internalStatus === "expired" || view.expiresAt.getTime() <= Date.now()
            ? "expired"
            : "active";
  return {
    id: view.id,
    code: view.code,
    rate: couponBpsToRate(view.discountRateBps),
    discountRateBps: view.discountRateBps,
    status,
    internalStatus,
    usageState:
      "usageState" in view ? view.usageState : status === "used" ? "redeemed" : "available",
    isReservationActive: "isReservationActive" in view ? view.isReservationActive : false,
    expiresAt: iso(view.expiresAt),
    reservationId: view.reservationId,
    reservedByUserId: view.reservedByUserId,
    reservedOrganizationId: view.reservedOrganizationId,
    reservedAt: iso(view.reservedAt),
    reservationExpiresAt: iso(view.reservationExpiresAt),
    redeemedByUserId: view.redeemedByUserId,
    redeemedOrganizationId: view.redeemedOrganizationId,
    redeemedAt: iso(view.redeemedAt),
    revokedAt: iso(view.revokedAt),
    note: view.note,
    source: view.source,
    createdBy: view.createdBy,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

function redemptionResponse(view: Awaited<ReturnType<typeof getRedemptionCode>>) {
  if (!view) return null;
  return {
    id: view.id,
    code: view.code,
    credits: view.credits,
    status: view.status,
    expiresAt: iso(view.expiresAt),
    redeemedByUserId: view.redeemedByUserId,
    redeemedOrganizationId: view.redeemedOrganizationId,
    redeemedAt: iso(view.redeemedAt),
    revokedAt: iso(view.revokedAt),
    note: view.note,
    source: view.source,
    createdBy: view.createdBy,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

function responseWithData<T extends Record<string, unknown>>(data: T) {
  // `data` follows the existing admin API convention. The top-level fields make
  // the small management API convenient for scripts without exposing anything
  // beyond the same sanitized object.
  return { data, ...data };
}

function audit(
  context: Context<AppContext>,
  fields: {
    action: string;
    objectType: string;
    objectId?: string | null;
    count: number;
    parameters: Record<string, unknown>;
    result: string;
  },
) {
  try {
    logEvent("info", "admin_codes.audit", {
      actorUserId: context.var.user?.id ?? "unknown",
      action: fields.action,
      objectType: fields.objectType,
      objectId: fields.objectId ?? null,
      count: fields.count,
      parameters: JSON.stringify(fields.parameters),
      requestId: context.var.requestId,
      result: fields.result,
    });
  } catch {
    // Observability must never turn a committed issuance or revoke into a 500.
  }
}

function errorResponse(context: Context<AppContext>, error: unknown, objectType: string) {
  if (error instanceof RateLimitExceededError) {
    context.header("Retry-After", String(error.retryAfterSeconds));
    return context.json(
      {
        error: "rate_limited",
        message: error.message,
        messages: {
          en: "Too many requests. Try again shortly.",
          "zh-CN": "请求过于频繁，请稍后重试。",
        },
      },
      429,
      NO_STORE,
    );
  }
  if (
    error instanceof CouponServiceError ||
    error instanceof CouponValidationError ||
    error instanceof RedemptionCodeError ||
    error instanceof RedemptionCodeValidationError ||
    error instanceof RedemptionCodeDailyCapError ||
    error instanceof RedemptionCodeIdempotencyConflictError ||
    error instanceof AdminIdempotencyConflictError
  ) {
    return context.json(
      {
        error: "reason" in error ? error.reason : "invalid_request",
        reason: "reason" in error ? error.reason : "invalid_request",
        message: error.message,
        messages: "messages" in error ? error.messages : invalidRequest.messages,
      },
      error.status as 400 | 404 | 409 | 429,
      NO_STORE,
    );
  }
  audit(context, {
    action: `admin.${objectType}.request`,
    objectType,
    count: 0,
    parameters: { retryable: true },
    result: "error",
  });
  return context.json(
    {
      error: "internal_error",
      message: "The request could not be completed. Try again.",
      messages: {
        en: "The request could not be completed. Try again.",
        "zh-CN": "请求未完成，请重试。",
      },
    },
    500,
    NO_STORE,
  );
}

export const adminCodeRoutes = new Hono<AppContext>();

adminCodeRoutes.use("*", setAdminHeaders);
// Keep this order deliberate: workspace roles never substitute for the
// platform-admin allow-list, and origin/rate checks happen after authorization.
adminCodeRoutes.use("*", requireAuth, requirePlatformAdmin, protectAdminRequest, limitAdminRequest);

adminCodeRoutes.post("/coupons", validateCouponIssue, async (context) => {
  const input = context.req.valid("json");
  const idempotencyKey = context.req.header("idempotency-key")?.trim() || undefined;
  try {
    const issuance = await issueCouponsWithReplay(
      context.env,
      idempotencyKey,
      context.var.user.id,
      {
        env: context.env,
        ...input,
        createdBy: context.var.user.id,
      },
    );
    const issued = issuance.batch;
    const data = {
      codes: issued.codes.map((row) => couponResponse(row)),
      count: issued.count,
      rate: issued.rate,
      validDays: issued.validDays,
      idempotentReplay: issuance.replayed,
    };
    audit(context, {
      action: "coupon.issue",
      objectType: "coupon_batch",
      objectId: issued.codes[0]?.id,
      count: issued.count,
      parameters: {
        rate: input.rate,
        validDays: input.validDays ?? 7,
        count: input.count,
        source: input.source ?? "admin",
        noteLength: input.note?.length ?? 0,
        hasIdempotencyKey: Boolean(idempotencyKey),
      },
      result: issuance.replayed ? "idempotent_replay" : "success",
    });
    return context.json(responseWithData(data), 201, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "coupon");
  }
});

adminCodeRoutes.get("/coupons/:code", async (context) => {
  try {
    const code = normalizeCouponCode(context.req.param("code"));
    if (!isCouponCodeFormat(code)) {
      return context.json(
        {
          error: "invalid_code",
          message: "Coupon code has an invalid format.",
          messages: {
            en: "Coupon code has an invalid format.",
            "zh-CN": "优惠券代码格式无效。",
          },
        },
        400,
        NO_STORE,
      );
    }
    const data = couponResponse(await getCouponView(context.env, code));
    if (!data)
      return context.json(
        {
          error: "not_found",
          message: "Coupon not found.",
          messages: { en: "Coupon not found.", "zh-CN": "优惠券不存在。" },
        },
        404,
        NO_STORE,
      );
    return context.json(responseWithData(data), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "coupon");
  }
});

adminCodeRoutes.delete("/coupons/:code", async (context) => {
  try {
    const data = couponResponse(await revokeCoupon(context.env, context.req.param("code")));
    audit(context, {
      action: "coupon.revoke",
      objectType: "coupon",
      objectId: data?.id,
      count: 1,
      parameters: { codeProvided: true },
      result: data?.status === "revoked" ? "success" : "idempotent_replay",
    });
    return context.json(responseWithData(data!), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "coupon");
  }
});

adminCodeRoutes.post("/redemption-codes", validateRedemptionIssue, async (context) => {
  const input = context.req.valid("json");
  const idempotencyKey =
    context.req.header("idempotency-key")?.trim() || input.idempotencyKey || undefined;
  try {
    const issued = await issueRedemptionCodes({
      env: context.env,
      ...input,
      idempotencyKey,
      createdBy: context.var.user.id,
    });
    const data = {
      codes: issued.codes.map((row) => redemptionResponse({ ...row, status: "active" })),
      count: issued.count,
      credits: issued.credits,
      validDays: issued.validDays,
      idempotencyKey: issued.idempotencyKey,
    };
    audit(context, {
      action: "redemption_code.issue",
      objectType: "redemption_code_batch",
      objectId: issued.codes[0]?.id,
      count: issued.count,
      parameters: {
        credits: input.credits ?? 5,
        validDays: input.validDays ?? 30,
        count: input.count,
        source: input.source ?? "admin",
        noteLength: input.note?.length ?? 0,
        hasIdempotencyKey: Boolean(idempotencyKey),
      },
      result: "success",
    });
    return context.json(responseWithData(data), 201, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.get("/redemption-codes/issuance-status", async (context) => {
  try {
    const data = await getRedemptionCodeIssuanceStatus(context.env);
    return context.json(responseWithData(data), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.get("/redemption-codes/:code", async (context) => {
  try {
    const code = normalizeRedemptionCode(context.req.param("code"));
    if (!isRedemptionCodeFormat(code)) {
      return context.json(
        {
          error: "invalid_code",
          message: "Redemption code has an invalid format.",
          messages: {
            en: "Redemption code has an invalid format.",
            "zh-CN": "兑换码格式无效。",
          },
        },
        400,
        NO_STORE,
      );
    }
    const data = redemptionResponse(await getRedemptionCode(context.env, code));
    if (!data)
      return context.json(
        {
          error: "not_found",
          message: "Redemption code not found.",
          messages: { en: "Redemption code not found.", "zh-CN": "兑换码不存在。" },
        },
        404,
        NO_STORE,
      );
    return context.json(responseWithData(data), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.delete("/redemption-codes/:code", async (context) => {
  try {
    const data = redemptionResponse(
      await revokeRedemptionCode(context.env, context.req.param("code")),
    );
    audit(context, {
      action: "redemption_code.revoke",
      objectType: "redemption_code",
      objectId: data?.id,
      count: 1,
      parameters: { codeProvided: true },
      result: data?.status === "revoked" ? "success" : "idempotent_replay",
    });
    return context.json(responseWithData(data!), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.onError((error, context) => errorResponse(context, error, "admin_codes"));

export const adminCodesRoutes = adminCodeRoutes;
