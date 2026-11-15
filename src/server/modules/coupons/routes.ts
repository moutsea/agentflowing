import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth";
import { requireSameOrigin } from "../../middleware/origin";
import { enforceRateLimit } from "../../middleware/rate-limit";
import type { AppContext } from "../../types";
import { COUPON_REASON_MESSAGES, previewCoupon } from "./service";

const validateCouponSchema = z.object({ code: z.unknown() }).strict();
const NO_STORE = { "Cache-Control": "no-store" } as const;

export const couponRoutes = new Hono<AppContext>();
export const couponsRoutes = couponRoutes;
couponRoutes.use("*", requireSameOrigin);

couponRoutes.post(
  "/validate",
  requireAuth,
  zValidator("json", validateCouponSchema, (result, context) => {
    if (!result.success) {
      return context.json(
        {
          error: "invalid_request",
          message: "Coupon code is required",
          messages: { en: "Coupon code is required", "zh-CN": "请输入优惠券代码。" },
        },
        400,
        NO_STORE,
      );
    }
  }),
  async (context) => {
    await enforceRateLimit({
      limiter: context.env.API_RATE_LIMITER,
      key: `coupons:validate:${context.var.user.id}`,
      scope: "coupon_validate",
      requestId: context.var.requestId,
    });
    const result = await previewCoupon({
      env: context.env,
      code: context.req.valid("json").code,
      userId: context.var.user.id,
    });
    if (!result.valid) {
      return context.json(
        {
          valid: false,
          reason: result.reason,
          message: result.messages.en,
          messages: result.messages,
        },
        200,
        NO_STORE,
      );
    }
    return context.json(
      { valid: true, rate: result.rate, expiresAt: result.expiresAt },
      200,
      NO_STORE,
    );
  },
);

export const couponReasonMessages = COUPON_REASON_MESSAGES;
