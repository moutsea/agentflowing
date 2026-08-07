import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { createDatabase } from "../../db";
import { subscription } from "../../db/schema";
import { requireAuth } from "../../middleware/auth";
import { anonymousRateLimitKey, enforceRateLimit } from "../../middleware/rate-limit";
import { logEvent } from "../../observability";
import type { AppContext } from "../../types";
import { requireWorkspaceManager } from "../workspaces/permissions";
import { getPublicCatalog } from "./catalog";
import {
  createStripeCheckout,
  createStripePortal,
  StripeConfigurationError,
  StripeWebhookInProgressError,
  verifyAndProcessStripeWebhook,
} from "./stripe";

const checkoutSchema = z.object({ planId: z.enum(["pro", "scale"]) });

export const billingRoutes = new Hono<AppContext>();

billingRoutes.get("/catalog", (context) => context.json({ data: getPublicCatalog(context.env) }));

billingRoutes.post(
  "/checkout",
  requireAuth,
  requireWorkspaceManager,
  zValidator("json", checkoutSchema),
  async (context) => {
    await enforceRateLimit({
      limiter: context.env.API_RATE_LIMITER,
      key: `${context.var.organization.id}:${context.var.user.id}`,
      scope: "billing_checkout",
      requestId: context.var.requestId,
    });
    try {
      const result = await createStripeCheckout({
        env: context.env,
        organizationId: context.var.organization.id,
        userId: context.var.user.id,
        userEmail: context.var.user.email,
        planId: context.req.valid("json").planId,
      });
      return context.json({ data: result }, 201);
    } catch (error) {
      if (error instanceof StripeConfigurationError) {
        return context.json({ error: "billing_not_configured", message: error.message }, 503);
      }
      throw error;
    }
  },
);

billingRoutes.post("/portal", requireAuth, requireWorkspaceManager, async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${context.var.organization.id}:${context.var.user.id}`,
    scope: "billing_portal",
    requestId: context.var.requestId,
  });
  try {
    const result = await createStripePortal({
      env: context.env,
      organizationId: context.var.organization.id,
    });
    return context.json({ data: result });
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      return context.json({ error: "billing_not_configured", message: error.message }, 503);
    }
    return context.json(
      {
        error: "portal_unavailable",
        message: error instanceof Error ? error.message : "Billing portal is unavailable",
      },
      409,
    );
  }
});

billingRoutes.get("/subscription", requireAuth, async (context) => {
  const [item] = await createDatabase(context.env)
    .select()
    .from(subscription)
    .where(eq(subscription.organizationId, context.var.organization.id))
    .orderBy(desc(subscription.updatedAt))
    .limit(1);
  return context.json({ data: item ?? null });
});

billingRoutes.post("/webhooks/stripe", async (context) => {
  await enforceRateLimit({
    limiter: context.env.WEBHOOK_RATE_LIMITER,
    key: anonymousRateLimitKey(context.req.raw),
    scope: "stripe_webhook",
    requestId: context.var.requestId,
  });
  const signature = context.req.header("stripe-signature");
  if (!signature) {
    return context.json({ error: "invalid_signature", message: "Missing Stripe signature" }, 400);
  }
  try {
    const result = await verifyAndProcessStripeWebhook({
      env: context.env,
      payload: await context.req.text(),
      signature,
    });
    return context.json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      return context.json({ error: "billing_not_configured", message: error.message }, 503);
    }
    if (error instanceof StripeWebhookInProgressError) {
      return context.json({ error: "webhook_in_progress", message: error.message }, 409);
    }
    logEvent("error", "stripe.webhook_failed", {
      requestId: context.var.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return context.json({ error: "webhook_failed", message: "Stripe webhook failed" }, 400);
  }
});
