import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit } from "../../middleware/rate-limit";
import type { AppContext } from "../../types";
import {
  RedemptionCodeError,
  RedemptionCodeIdempotencyConflictError,
  RedemptionCodeValidationError,
  redeemRedemptionCode,
  validateRedemptionCode,
} from "./service";

const codeSchema = z.object({ code: z.string().trim().min(1).max(64) }).strict();
const validateCodeBody = zValidator("json", codeSchema, (result, context) => {
  if (!result.success) {
    return context.json(
      {
        error: "invalid_request",
        message: "Redemption code is required.",
        messages: { en: "Redemption code is required.", "zh-CN": "请输入兑换码。" },
      },
      400,
    );
  }
});
const protectRequest = createMiddleware<AppContext>(async (context, next) => {
  context.header("Cache-Control", "no-store");
  const origin = context.req.header("origin");
  if (origin && origin !== new URL(context.env.APP_URL).origin) {
    return context.json({ error: "forbidden", message: "Invalid request origin" }, 403);
  }
  await next();
});

function errorResponse(context: Context<AppContext>, error: unknown): Response {
  if (error instanceof RedemptionCodeError) {
    return context.json(
      {
        error: error.reason,
        reason: error.reason,
        message: error.message,
        messages: error.messages,
      },
      error.status,
    );
  }
  if (error instanceof RedemptionCodeValidationError) {
    return context.json(
      { error: error.reason, message: error.message, messages: error.messages },
      error.status,
    );
  }
  if (error instanceof RedemptionCodeIdempotencyConflictError) {
    return context.json(
      { error: error.reason, message: error.message, messages: error.messages },
      error.status,
    );
  }
  throw error;
}

export const redemptionCodeRoutes = new Hono<AppContext>();
redemptionCodeRoutes.use("*", protectRequest, requireAuth);
redemptionCodeRoutes.post("/validate", validateCodeBody, async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `redemption-code:validate:${context.var.user.id}`,
    scope: "redemption_code_validate",
    requestId: context.var.requestId,
  });
  const result = await validateRedemptionCode(context.env, context.req.valid("json").code);
  if (!result.valid) {
    return context.json({
      valid: false,
      reason: result.reason,
      message: result.messages.en,
      messages: result.messages,
    });
  }
  return context.json({ valid: true, credits: result.credits, expiresAt: result.expiresAt });
});
redemptionCodeRoutes.post("/redeem", validateCodeBody, async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `redemption-code:redeem:${context.var.user.id}`,
    scope: "redemption_code_redeem",
    requestId: context.var.requestId,
  });
  try {
    const data = await redeemRedemptionCode({
      env: context.env,
      code: context.req.valid("json").code,
      userId: context.var.user.id,
      organizationId: context.var.organization.id,
    });
    return context.json({ data });
  } catch (error) {
    return errorResponse(context, error);
  }
});
