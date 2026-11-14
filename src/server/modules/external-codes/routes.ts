import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import {
  anonymousRateLimitKey,
  enforceRateLimit,
  RateLimitExceededError,
} from "../../middleware/rate-limit";
import { logEvent } from "../../observability";
import type { AppContext } from "../../types";
import {
  CouponServiceError,
  couponBpsToRate,
  getCouponByCode,
  getCouponState,
  isCouponCodeFormat,
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
import { requireExternalToken } from "./auth";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ISSUE_SCHEMA = z
  .object({
    credits: z.number().int().optional(),
    count: z.number().int().min(1).max(100).optional(),
    validDays: z.number().int().optional(),
    note: z.string().nullable().optional(),
    source: z.string().optional(),
  })
  .strict();

const INVALID_REQUEST = {
  error: "invalid_request",
  message: "The request is invalid.",
  messages: {
    en: "The request is invalid.",
    "zh-CN": "请求无效。",
  },
} as const;

const INTERNAL_ERROR = {
  error: "internal_error",
  message: "A temporary server error occurred. Please retry.",
  messages: {
    en: "A temporary server error occurred. Please retry.",
    "zh-CN": "服务器暂时不可用，请稍后重试。",
  },
} as const;

const protectExternalRequest = createMiddleware<AppContext>(async (context, next) => {
  context.header("Cache-Control", "no-store");
  const origin = context.req.header("origin");
  if (
    !["GET", "HEAD"].includes(context.req.method) &&
    origin &&
    origin !== new URL(context.env.APP_URL).origin
  ) {
    return context.json(
      {
        error: "forbidden",
        message: "Invalid request origin.",
        messages: { en: "Invalid request origin.", "zh-CN": "请求来源无效。" },
      },
      403,
      NO_STORE,
    );
  }
  await next();
});

function isoDate(value: Date | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const milliseconds =
    value instanceof Date ? value.getTime() : value * (value > 10_000_000_000 ? 1 : 1000);
  return new Date(milliseconds).toISOString();
}

type RedemptionResponseRow =
  | NonNullable<Awaited<ReturnType<typeof getRedemptionCode>>>
  | Awaited<ReturnType<typeof issueRedemptionCodes>>["codes"][number];

function redemptionCodeResponse(row: RedemptionResponseRow | null) {
  if (!row) return null;
  return {
    code: row.code,
    credits: row.credits,
    status: "status" in row ? row.status : "active",
    expiresAt: isoDate(row.expiresAt),
    redeemedAt: isoDate(row.redeemedAt),
    revokedAt: isoDate(row.revokedAt),
    note: row.note,
    source: row.source,
    createdAt: isoDate(row.createdAt),
    redeemedByUserId: row.redeemedByUserId,
  };
}

function couponResponse(row: Awaited<ReturnType<typeof getCouponByCode>>) {
  if (!row) return null;
  const state = getCouponState(row);
  const reservationStatus = state.usageState === "reserved" ? "reserved" : "not_reserved";
  const paymentStatus = row.redeemedAt
    ? "confirmed"
    : state.usageState === "reserved"
      ? "pending"
      : "not_confirmed";
  return {
    code: row.code,
    rate: couponBpsToRate(row.discountRateBps),
    status: state.status,
    expiresAt: isoDate(row.expiresAt),
    reservedAt: isoDate(row.reservedAt),
    redeemedAt: isoDate(row.redeemedAt),
    revokedAt: isoDate(row.revokedAt),
    note: row.note,
    source: row.source,
    createdAt: isoDate(row.createdAt),
    usageState: state.usageState,
    isReservationActive: state.isReservationActive,
    reservationStatus,
    paymentStatus,
  };
}

function validationResponse(context: Context<AppContext>) {
  return context.json(INVALID_REQUEST, 400, NO_STORE);
}

function logTransientFailure(context: Context<AppContext>, objectId: string) {
  logEvent("error", "external_codes.request_failed", {
    requestId: context.var.requestId,
    objectId,
    retryable: true,
  });
  return context.json(INTERNAL_ERROR, 500, NO_STORE);
}

function redemptionErrorResponse(
  context: Context<AppContext>,
  error: unknown,
  objectId: string,
): Response {
  if (error instanceof RedemptionCodeError) {
    return context.json(
      {
        error: error.reason,
        reason: error.reason,
        message: error.message,
        messages: error.messages,
      },
      error.status as 400 | 404 | 409,
      NO_STORE,
    );
  }
  if (
    error instanceof RedemptionCodeValidationError ||
    error instanceof RedemptionCodeIdempotencyConflictError ||
    error instanceof RedemptionCodeDailyCapError
  ) {
    return context.json(
      {
        error: error.reason,
        message: error.message,
        messages: error.messages,
      },
      error.status as 400 | 404 | 409,
      NO_STORE,
    );
  }
  return logTransientFailure(context, objectId);
}

function couponErrorResponse(
  context: Context<AppContext>,
  error: unknown,
  objectId: string,
): Response {
  if (error instanceof CouponServiceError) {
    return context.json(
      {
        error: error.code,
        reason: error.code,
        message: error.message,
        messages: error.messages,
      },
      error.status as 400 | 404 | 409,
      NO_STORE,
    );
  }
  return logTransientFailure(context, objectId);
}

async function limitExternalRequest(context: Context<AppContext>, scope: string) {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: anonymousRateLimitKey(context.req.raw),
    scope,
    requestId: context.var.requestId,
  });
}

const issueBody = zValidator("json", ISSUE_SCHEMA, (result, context) => {
  if (!result.success) return context.json(INVALID_REQUEST, 400);
});

const redemptionRoutes = new Hono<AppContext>();
redemptionRoutes.use("*", requireExternalToken("redemption"));

redemptionRoutes.post("/", issueBody, async (context) => {
  await limitExternalRequest(context, "external_redemption_code_issue");
  try {
    const input = context.req.valid("json");
    const issued = await issueRedemptionCodes({
      env: context.env,
      ...input,
      idempotencyKey: context.req.header("idempotency-key") ?? undefined,
    });
    return context.json({ codes: issued.codes.map(redemptionCodeResponse) }, 201, NO_STORE);
  } catch (error) {
    return redemptionErrorResponse(context, error, "issuance");
  }
});

redemptionRoutes.get("/issuance-status", async (context) => {
  await limitExternalRequest(context, "external_redemption_code_issuance_status");
  try {
    return context.json(await getRedemptionCodeIssuanceStatus(context.env), 200, NO_STORE);
  } catch {
    return logTransientFailure(context, "issuance-status");
  }
});

redemptionRoutes.get("/:code", async (context) => {
  await limitExternalRequest(context, "external_redemption_code_read");
  const normalized = normalizeRedemptionCode(context.req.param("code"));
  if (!isRedemptionCodeFormat(normalized)) return validationResponse(context);
  try {
    const row = await getRedemptionCode(context.env, normalized);
    if (!row) {
      return context.json(
        {
          error: "not_found",
          message: "This redemption code does not exist.",
          messages: {
            en: "This redemption code does not exist.",
            "zh-CN": "兑换码不存在。",
          },
        },
        404,
        NO_STORE,
      );
    }
    return context.json(redemptionCodeResponse(row), 200, NO_STORE);
  } catch (error) {
    return redemptionErrorResponse(context, error, normalized);
  }
});

redemptionRoutes.delete("/:code", async (context) => {
  await limitExternalRequest(context, "external_redemption_code_revoke");
  const normalized = normalizeRedemptionCode(context.req.param("code"));
  if (!isRedemptionCodeFormat(normalized)) return validationResponse(context);
  try {
    const row = await revokeRedemptionCode(context.env, normalized);
    return context.json(redemptionCodeResponse(row), 200, NO_STORE);
  } catch (error) {
    return redemptionErrorResponse(context, error, normalized);
  }
});

redemptionRoutes.all("*", (context) =>
  context.json({ error: "not_found", message: "Not found" }, 404, NO_STORE),
);

const couponRoutes = new Hono<AppContext>();
couponRoutes.use("*", requireExternalToken("coupon"));

couponRoutes.get("/:code", async (context) => {
  await limitExternalRequest(context, "external_coupon_read");
  const normalized = normalizeCouponCode(context.req.param("code"));
  if (!isCouponCodeFormat(normalized)) return validationResponse(context);
  try {
    const row = await getCouponByCode(context.env, normalized);
    if (!row) {
      return context.json(
        {
          error: "not_found",
          message: "Coupon not found.",
          messages: { en: "Coupon not found.", "zh-CN": "优惠券不存在。" },
        },
        404,
        NO_STORE,
      );
    }
    return context.json(couponResponse(row), 200, NO_STORE);
  } catch (error) {
    return couponErrorResponse(context, error, normalized);
  }
});

couponRoutes.delete("/:code", async (context) => {
  await limitExternalRequest(context, "external_coupon_revoke");
  const normalized = normalizeCouponCode(context.req.param("code"));
  if (!isCouponCodeFormat(normalized)) return validationResponse(context);
  try {
    const row = await revokeCoupon(context.env, normalized);
    return context.json(couponResponse(row), 200, NO_STORE);
  } catch (error) {
    return couponErrorResponse(context, error, normalized);
  }
});

couponRoutes.all("*", (context) =>
  context.json({ error: "not_found", message: "Not found" }, 404, NO_STORE),
);

export const externalCodesRoutes = new Hono<AppContext>();
externalCodesRoutes.use("*", protectExternalRequest);
externalCodesRoutes.route("/redemption-codes", redemptionRoutes);
externalCodesRoutes.route("/coupons", couponRoutes);
externalCodesRoutes.onError((error, context) => {
  if (error instanceof RateLimitExceededError) {
    context.header("Retry-After", String(error.retryAfterSeconds));
    return context.json(
      {
        error: "rate_limited",
        message: "Too many requests. Try again shortly.",
        messages: {
          en: "Too many requests. Try again shortly.",
          "zh-CN": "请求过于频繁，请稍后重试。",
        },
      },
      429,
      NO_STORE,
    );
  }
  return logTransientFailure(context, "request");
});

export const externalCodeRoutes = externalCodesRoutes;
