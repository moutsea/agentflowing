import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { QR_PAYMENT_METHODS } from "../../../shared/direct-qr";
import { readRuntimeString } from "../../env";
import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit } from "../../middleware/rate-limit";
import { logEvent } from "../../observability";
import type { AppContext } from "../../types";
import { canManageWorkspace, requireWorkspaceManager } from "../workspaces/permissions";
import { toDirectQrStatus } from "./direct-qr";
import {
  cancelDirectQrIntent,
  createDirectQrCheckout,
  DirectQrError,
  fulfillDirectQrIntent,
  getDirectQrAvailability,
  loadOwnedDirectQrIntent,
} from "./direct-qr-service";
import { StripeConfigurationError } from "./stripe";

/**
 * WeChat Pay / Alipay paid by scanning a code this app renders itself, mounted
 * at `/api/billing/qr`. Availability is workspace-level; the lifecycle of one
 * payment is keyed by the Stripe PaymentIntent id.
 */

const createQrCheckoutSchema = z.object({
  planId: z.enum(["pro", "scale"]),
  method: z.enum(QR_PAYMENT_METHODS),
});

export const directQrRoutes = new Hono<AppContext>();

// A status poll must never be served from a cache: the whole point is to see
// the payment land.
const NO_STORE = { "Cache-Control": "no-store" } as const;

directQrRoutes.get("/", requireAuth, (context) =>
  context.json(
    {
      data: getDirectQrAvailability(context.env, {
        userId: context.var.user.id,
        // Reported so the pricing page can hide a button that would only fail
        // with 403 on submit.
        canManage: canManageWorkspace(context.var.role),
      }),
    },
    200,
    NO_STORE,
  ),
);

directQrRoutes.post(
  "/",
  requireAuth,
  requireWorkspaceManager,
  zValidator("json", createQrCheckoutSchema),
  async (context) => {
    // The intent's return_url is built from APP_URL, so a missing value would
    // confirm a payment we cannot finish. Fail as a configuration problem
    // rather than let the required-secret error surface as a 500.
    const appUrl = readRuntimeString(context.env, "APP_URL");
    if (!appUrl) {
      return context.json(
        { error: "billing_not_configured", message: "APP_URL is not configured" },
        503,
      );
    }
    await enforceRateLimit({
      limiter: context.env.API_RATE_LIMITER,
      key: `${context.var.organization.id}:${context.var.user.id}`,
      scope: "billing_qr",
      requestId: context.var.requestId,
    });
    try {
      const result = await createDirectQrCheckout({
        env: context.env,
        organizationId: context.var.organization.id,
        userId: context.var.user.id,
        userEmail: context.var.user.email,
        planId: context.req.valid("json").planId,
        method: context.req.valid("json").method,
        appUrl,
      });
      // The order id stays server-side: the dialog only ever needs the payment,
      // and the intent id it carries is what every later call is keyed by.
      logEvent("info", "billing.direct_qr_created", {
        requestId: context.var.requestId,
        orderId: result.orderId,
        paymentIntentId: result.payment.paymentIntentId,
        method: result.payment.method,
        currency: result.payment.currency,
      });
      return context.json({ data: result.payment }, 201, NO_STORE);
    } catch (error) {
      if (error instanceof DirectQrError) {
        return context.json({ error: error.code, message: error.message }, error.status);
      }
      if (error instanceof StripeConfigurationError) {
        return context.json({ error: "billing_not_configured", message: error.message }, 503);
      }
      throw error;
    }
  },
);

/**
 * Polled by the dialog while the code is on screen.
 *
 * Manager-only like the rest of the flow, and rate limited under its own key:
 * a 3-second poll must never eat the shared billing budget, which is also what
 * keeps the endpoint from being used to hammer Stripe.
 */
directQrRoutes.get("/:id", requireAuth, requireWorkspaceManager, async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${context.var.organization.id}:${context.var.user.id}:qr-status`,
    scope: "billing_qr_status",
    requestId: context.var.requestId,
  });
  try {
    const intent = await loadOwnedDirectQrIntent({
      env: context.env,
      organizationId: context.var.organization.id,
      paymentIntentId: context.req.param("id"),
    });
    const status = toDirectQrStatus(intent.status);

    // Credit now rather than wait for the webhook, so the balance the dialog
    // shows is already updated.
    if (status === "succeeded") {
      try {
        await fulfillDirectQrIntent(context.env, intent);
      } catch (error) {
        // The payment did succeed. The webhook will retry the credit, so the
        // customer must still be told it worked.
        logEvent("error", "billing.direct_qr_fulfill_failed", {
          requestId: context.var.requestId,
          paymentIntentId: intent.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return context.json({ data: { status } }, 200, NO_STORE);
  } catch (error) {
    if (error instanceof DirectQrError) {
      return context.json({ error: error.code, message: error.message }, error.status, NO_STORE);
    }
    // Talking to Stripe without a key is a configuration problem, not a crash.
    if (error instanceof StripeConfigurationError) {
      return context.json(
        { error: "billing_not_configured", message: error.message },
        503,
        NO_STORE,
      );
    }
    throw error;
  }
});

/** Called when the dialog is dismissed, so an unwanted code stops being payable. */
directQrRoutes.delete("/:id", requireAuth, requireWorkspaceManager, async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${context.var.organization.id}:${context.var.user.id}:qr-cancel`,
    scope: "billing_qr_cancel",
    requestId: context.var.requestId,
  });
  try {
    const status = await cancelDirectQrIntent({
      env: context.env,
      organizationId: context.var.organization.id,
      paymentIntentId: context.req.param("id"),
    });
    return context.json({ data: { status } }, 200, NO_STORE);
  } catch (error) {
    if (error instanceof DirectQrError) {
      return context.json({ error: error.code, message: error.message }, error.status, NO_STORE);
    }
    // Talking to Stripe without a key is a configuration problem, not a crash.
    if (error instanceof StripeConfigurationError) {
      return context.json(
        { error: "billing_not_configured", message: error.message },
        503,
        NO_STORE,
      );
    }
    throw error;
  }
});
