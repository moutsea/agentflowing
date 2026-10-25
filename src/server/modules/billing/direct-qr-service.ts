import type Stripe from "stripe";

import {
  DIRECT_QR_FLOW,
  getQrPaymentMethods,
  type DirectQrAvailability,
  type DirectQrPayment,
  type DirectQrStatus,
  type QrPaymentMethod,
} from "../../../shared/direct-qr";
import { readRuntimeString } from "../../env";
import { isPlatformAdmin } from "../../middleware/platform-admin";
import { logEvent } from "../../observability";
import { getBillingCurrency, getDirectQrStaleSeconds, getPaidPlan, getPlan } from "./catalog";
import {
  isCancelableDirectQrStatus,
  isDirectQrIntent,
  presentDirectQr,
  toDirectQrStatus,
} from "./direct-qr";
import { completedEventStatement, createStripe } from "./stripe";

/**
 * The server half of the direct-QR flow: confirm a WeChat Pay / Alipay
 * PaymentIntent ourselves and hand back something the browser can render, so
 * the customer never loads a Stripe-hosted page.
 *
 * Two properties matter more than anything else here:
 *
 * - A confirmed wallet intent is a payable code. If we cannot present it, it
 *   has to be cancelled, or a customer could pay against an order nobody shows.
 * - Credits are granted through the `credit_ledger` idempotency key, because
 *   the status poll, the webhook and any retry all race to credit the same
 *   payment.
 *
 * `direct-qr-service` and `stripe` import each other (this module reuses the
 * one client factory, `stripe.ts` calls back in to fulfill webhook events).
 * That cycle is safe: neither side touches the other at module-evaluation time,
 * only from inside request handlers.
 */

/**
 * Statuses are narrowed to what this module can answer with, so the routes can
 * pass them straight to `c.json` without widening to a plain number.
 */
type DirectQrErrorStatus = 400 | 403 | 404 | 409 | 502 | 503;

export class DirectQrError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "disabled"
      | "invalid_plan"
      | "unsupported_method"
      | "no_presentation"
      /** The wallet settled the intent before we could show a code. */
      | "already_paid"
      | "not_found",
    message: string,
    readonly status: DirectQrErrorStatus,
  ) {
    super(message);
    this.name = "DirectQrError";
  }
}

type StoredOrder = {
  id: string;
  organization_id: string;
  plan_id: string;
  kind: string;
  credits: number;
};

const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]+$/;

function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the `code` off a Stripe error without loading the error classes into the
 * Worker bundle just to narrow one field.
 */
function stripeErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function notFound() {
  return new DirectQrError("not_found", "QR payment was not found", 404);
}

/**
 * Stripe amounts are always in the currency's smallest unit, and the wallets on
 * offer include the yen, which has none — `price * 100` would bill a Japanese
 * customer a hundred times the price. The currency is normalized because the
 * same value is echoed back to the browser and compared against intents.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(["jpy", "krw"]);

function toMinorUnits(amount: number, currency: string) {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? Math.round(amount) : Math.round(amount * 100);
}

type DirectQrMode = "off" | "admins" | "all";

/**
 * An unreadable mode is treated as `off`: a typo in configuration must not
 * switch a payment path on that nobody meant to enable.
 */
function getDirectQrMode(env: Env): DirectQrMode {
  const raw = (readRuntimeString(env, "DIRECT_QR_PAYMENT_MODE") ?? "all").trim().toLowerCase();
  return raw === "all" || raw === "admins" || raw === "off" ? raw : "off";
}

function isStripeConfigured(env: Env) {
  return Boolean(readRuntimeString(env, "STRIPE_SECRET_KEY"));
}

type AvailabilityReason = "ok" | "stripe_not_configured" | "currency_without_qr_methods" | "mode";

/**
 * Why the flow is or is not available. Kept separate from the wire shape so
 * `createDirectQrCheckout` can reuse the decision without inventing a
 * `canManage` value it has no opinion about, and so the reason can be logged.
 */
function resolveAvailability(env: Env, userId: string) {
  const currency = getBillingCurrency(env);
  const methods = getQrPaymentMethods(currency);
  const mode = getDirectQrMode(env);
  const modeAllows = mode === "all" || (mode === "admins" && isPlatformAdmin(env, userId));
  const reason: AvailabilityReason = !isStripeConfigured(env)
    ? "stripe_not_configured"
    : methods.length === 0
      ? "currency_without_qr_methods"
      : modeAllows
        ? "ok"
        : "mode";
  return { currency, methods, reason, enabled: reason === "ok" };
}

export function getDirectQrAvailability(
  env: Env,
  identity: { userId: string; canManage: boolean },
): DirectQrAvailability {
  const { currency, methods, enabled } = resolveAvailability(env, identity.userId);

  // The method list is always the real one for the currency rather than an
  // empty list when disabled: the pricing UI renders the wallet buttons from
  // it and only `enabled` decides whether they are offered, so one source of
  // truth keeps the two from drifting apart. It is currency-level, public
  // information.
  return { enabled, currency, methods, canManage: identity.canManage };
}

/** Reuse the workspace's existing Stripe customer, if any; never create one. */
async function findStripeCustomerId(env: Env, organizationId: string) {
  const row = await env.DB.prepare(
    `SELECT provider_customer_id AS customerId
     FROM subscription
     WHERE organization_id = ? AND provider = 'stripe'
       AND provider_customer_id IS NOT NULL
     ORDER BY updatedAt DESC LIMIT 1`,
  )
    .bind(organizationId)
    .first<{ customerId: string }>();
  return row?.customerId ?? null;
}

/** Cancel best effort: the intent is already unusable, so a failure only logs. */
async function cancelQuietly(stripe: Stripe, paymentIntentId: string) {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (error) {
    logEvent("error", "billing.direct_qr_cancel_failed", {
      paymentIntentId,
      message: errorMessage(error),
    });
  }
}

export async function createDirectQrCheckout(params: {
  env: Env;
  organizationId: string;
  userId: string;
  /** Accepted for symmetry with `createStripeCheckout`; receipts are a Stripe setting. */
  userEmail: string;
  planId: string;
  method: QrPaymentMethod;
  appUrl: string;
}): Promise<{ orderId: string; payment: DirectQrPayment }> {
  const plan = getPaidPlan(params.env, params.planId);
  if (!plan) throw new DirectQrError("invalid_plan", "This paid plan is not configured", 400);

  const { currency, methods, enabled, reason } = resolveAvailability(params.env, params.userId);
  const amount = toMinorUnits(plan.monthlyPrice, currency);
  if (!enabled) {
    logEvent("warn", "billing.direct_qr_blocked", {
      reason,
      userId: params.userId,
      currency,
    });
    // A missing key is an operator problem the customer cannot act on, so it
    // is reported apart from the policy switch.
    if (reason === "stripe_not_configured") {
      throw new DirectQrError("not_configured", "Stripe is not configured", 503);
    }
    throw new DirectQrError("disabled", "QR payment is not available", 403);
  }
  if (!methods.includes(params.method)) {
    throw new DirectQrError(
      "unsupported_method",
      `${params.method} is not supported for ${currency.toUpperCase()}`,
      400,
    );
  }

  // Built before the order row exists: a missing key throws here, leaving no
  // orphan row behind, and the catch block below can release intents with it.
  const stripe = createStripe(params.env);
  const orderId = crypto.randomUUID();
  await params.env.DB.prepare(
    `INSERT INTO "order"
     (id, organization_id, provider, kind, plan_id, amount, currency, credits,
      status, createdAt, updatedAt)
     VALUES (?, ?, 'stripe', 'credit_pack', ?, ?, ?, ?, 'created',
             unixepoch(), unixepoch())`,
  )
    .bind(orderId, params.organizationId, plan.id, amount, currency, plan.credits)
    .run();

  // The intent this request created, if any, so the failure path can release it
  // and so a settled payment is never cancelled or marked failed.
  let intentId: string | null = null;
  let settled = false;

  try {
    const customerId = await findStripeCustomerId(params.env, params.organizationId);
    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount,
      currency,
      description: `${plan.name} credits`,
      confirm: true,
      payment_method_types: [params.method],
      payment_method_data: { type: params.method },
      // Alipay confirms through a redirect; this is also where a customer who
      // follows the fallback page lands.
      return_url: `${params.appUrl}/pricing?checkout=qr-return`,
      metadata: {
        orderId,
        organizationId: params.organizationId,
        userId: params.userId,
        planId: plan.id,
        flow: DIRECT_QR_FLOW,
      },
    };
    if (customerId) intentParams.customer = customerId;
    if (params.method === "wechat_pay") {
      // WeChat only produces a scannable web code for `client: 'web'`; without
      // it Stripe confirms the intent but returns no usable next_action.
      intentParams.payment_method_options = { wechat_pay: { client: "web" } };
    }

    const intent = await stripe.paymentIntents.create(intentParams, {
      idempotencyKey: `agentflowing-direct-qr:${orderId}`,
    });
    intentId = intent.id;

    const presentation = presentDirectQr(params.method, intent.next_action);
    if (!presentation) {
      // A wallet can settle an intent outright, leaving no `next_action` and
      // nothing to scan. Cancelling here would reverse a real payment, so grant
      // the credits and report it as already paid instead.
      if (intent.status === "succeeded") {
        await fulfillDirectQrIntent(params.env, intent);
        settled = true;
        logEvent("info", "billing.direct_qr_settled_without_code", {
          paymentIntentId: intent.id,
          method: params.method,
        });
        throw new DirectQrError("already_paid", "This payment has already been completed", 409);
      }

      // Nothing to show: release the intent instead of leaving a payable code
      // stranded in Stripe. Clearing `intentId` keeps the catch block from
      // cancelling twice.
      await cancelQuietly(stripe, intent.id);
      intentId = null;
      logEvent("error", "billing.direct_qr_no_presentation", {
        paymentIntentId: intent.id,
        status: intent.status,
        nextActionType: intent.next_action?.type ?? null,
        method: params.method,
      });
      throw new DirectQrError(
        "no_presentation",
        "Stripe returned no usable payment QR for this method",
        502,
      );
    }

    await params.env.DB.prepare(
      `UPDATE "order" SET provider_session_id = ?, status = 'processing', updatedAt = unixepoch()
       WHERE id = ?`,
    )
      .bind(intent.id, orderId)
      .run();

    return {
      orderId,
      // `amount` is major units, matching `DirectQrPayment`; the order row keeps
      // the smallest unit Stripe charges.
      payment: {
        paymentIntentId: intent.id,
        method: params.method,
        currency,
        amount: plan.monthlyPrice,
        ...presentation,
      },
    };
  } catch (error) {
    // Release anything this request made payable. A settled payment is left
    // alone: the credits are already granted and the customer must not be
    // refunded by us cancelling behind their wallet's back.
    if (intentId && !settled) await cancelQuietly(stripe, intentId);
    if (!settled) {
      await params.env.DB.prepare(
        `UPDATE "order" SET status = 'failed', updatedAt = unixepoch()
         WHERE id = ? AND status <> 'paid'`,
      )
        .bind(orderId)
        .run();
    }
    throw error;
  }
}

/**
 * Load an intent only if it is a direct-QR intent owned by this workspace.
 * Everything else answers 404, so intent ids cannot be probed across accounts.
 */
export async function loadOwnedDirectQrIntent(params: {
  env: Env;
  organizationId: string;
  paymentIntentId: string;
}): Promise<Stripe.PaymentIntent> {
  if (!PAYMENT_INTENT_ID.test(params.paymentIntentId)) throw notFound();

  const stripe = createStripe(params.env);
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.retrieve(params.paymentIntentId);
  } catch (error) {
    if (stripeErrorCode(error) === "resource_missing") throw notFound();
    throw error;
  }

  if (!isDirectQrIntent(intent)) throw notFound();
  if (metadataValue(intent.metadata, "organizationId") !== params.organizationId) throw notFound();
  return intent;
}

/**
 * Called when the dialog closes, switches wallet, or hands over to Checkout, so
 * an order never has two payable codes outstanding.
 */
export async function cancelDirectQrIntent(params: {
  env: Env;
  organizationId: string;
  paymentIntentId: string;
}): Promise<DirectQrStatus> {
  let intent = await loadOwnedDirectQrIntent(params);
  // Already settled or in flight: skip cancellation, but still fulfill success.
  if (isCancelableDirectQrStatus(intent.status)) {
    const stripe = createStripe(params.env);
    try {
      intent = await stripe.paymentIntents.cancel(intent.id);
    } catch (error) {
      // Lost a race with the customer paying: reconcile the latest state.
      let current: Stripe.PaymentIntent | null = null;
      try {
        current = await stripe.paymentIntents.retrieve(intent.id);
      } catch {
        // Keep the last known state when Stripe cannot be reached.
      }
      logEvent("warn", "billing.direct_qr_cancel_refused", {
        paymentIntentId: intent.id,
        status: current?.status ?? "unknown",
        message: errorMessage(error),
      });
      intent = current ?? intent;
    }
  }

  // The dialog stops polling on success, so grant before returning it. Keep
  // this outside the cancellation catch: database failures must remain retryable.
  if (intent.status === "succeeded") await fulfillDirectQrIntent(params.env, intent);
  return toDirectQrStatus(intent.status);
}

/**
 * A permanent reason the intent can never be fulfilled: its payload disagrees
 * with the stored order, or the order it names is gone. Asking Stripe to
 * redeliver the webhook cannot fix any of these, so callers may stop retrying —
 * a transient failure (a database error, say) is deliberately not wrapped in
 * this class and therefore still retries.
 */
export class DirectQrUnfulfillableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectQrUnfulfillableError";
  }
}

/**
 * Grant the plan's credits for a succeeded direct-QR intent.
 *
 * Called from the status poll, the webhook and any retry, so it has to be
 * idempotent: the `credit_ledger` unique key on (organization_id,
 * idempotency_key) is what makes the grant safe to race. Whichever caller
 * arrives second sees the insert ignored and reports `duplicate`.
 *
 * Passing `eventId` folds the webhook's completion marker into the same batch,
 * so a crash can never leave "event completed" without the credits.
 */
export async function fulfillDirectQrIntent(
  env: Env,
  intent: Stripe.PaymentIntent,
  eventId?: string,
): Promise<{ duplicate: boolean }> {
  if (intent.status !== "succeeded") {
    throw new DirectQrUnfulfillableError(`Direct QR intent is not succeeded: ${intent.status}`);
  }
  const orderId = metadataValue(intent.metadata, "orderId");
  if (!orderId) throw new DirectQrUnfulfillableError("Direct QR intent is missing orderId");

  const storedOrder = await env.DB.prepare(
    `SELECT id, organization_id, plan_id, kind, credits FROM "order" WHERE id = ?`,
  )
    .bind(orderId)
    .first<StoredOrder>();
  if (!storedOrder) throw new DirectQrUnfulfillableError("Direct QR order was not found");
  // The intent is the authority for who paid, but the stored order is the
  // authority for what was bought; a mismatch means one of them was tampered
  // with, so neither is trusted to grant credits.
  if (metadataValue(intent.metadata, "organizationId") !== storedOrder.organization_id) {
    throw new DirectQrUnfulfillableError("Direct QR organization does not match the stored order");
  }
  // Fulfillment may arrive after a catalog deploy, including one that removes
  // this plan. The order records what the customer bought at creation time.
  if (
    storedOrder.kind !== "credit_pack" ||
    storedOrder.plan_id === "free" ||
    !Number.isSafeInteger(storedOrder.credits) ||
    storedOrder.credits <= 0
  ) {
    throw new DirectQrUnfulfillableError("Direct QR order has an invalid credit pack");
  }

  const [ledgerResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description,
        reference_type, reference_id, created_at)
       VALUES (?, ?, ?, 'grant', ?, ?, 'stripe_direct_qr', ?, unixepoch())`,
    ).bind(
      crypto.randomUUID(),
      storedOrder.organization_id,
      storedOrder.credits,
      `stripe:direct_qr:${intent.id}`,
      `${getPlan(storedOrder.plan_id)?.name ?? storedOrder.plan_id} credit pack`,
      intent.id,
    ),
    env.DB.prepare(
      `UPDATE "order"
       SET status = 'paid', paid_at = unixepoch(), amount = ?, provider_session_id = ?,
           updatedAt = unixepoch()
       WHERE id = ? AND status <> 'paid'`,
    ).bind(intent.amount_received, intent.id, storedOrder.id),
    ...(eventId ? [completedEventStatement(env, eventId)] : []),
  ]);

  return { duplicate: (ledgerResult?.meta.changes ?? 0) === 0 };
}

/** Order status is only ever moved forward out of a pending state. */
async function markOrderFailed(env: Env, orderId: string) {
  await env.DB.prepare(
    `UPDATE "order" SET status = 'failed', updatedAt = unixepoch()
     WHERE id = ? AND status <> 'paid'`,
  )
    .bind(orderId)
    .run();
}

/**
 * A PaymentIntent never expires: if the customer closes the dialog without
 * paying, the intent stays payable in Stripe forever and its order stays
 * `processing`. Credit-pack orders older than this window are therefore
 * cancelled on a schedule.
 *
 * The same sweep also reconciles payments that were taken but never granted
 * (a webhook lost during a deploy, say): a cancel attempt on an intent that
 * already succeeded fails, and that is the signal to run the normal
 * idempotent grant instead of marking the order failed.
 */
const STALE_DIRECT_QR_ORDER_BATCH = 25;

/**
 * The slice of the Stripe client the sweep uses. Naming it keeps the client
 * factory out of the way of a test that has to drive the cancel/retrieve
 * branches: those two decide whether a customer's money becomes credits or the
 * order is written off, and they are the part worth covering.
 */
export type SweepStripe = {
  paymentIntents: {
    cancel(paymentIntentId: string): Promise<unknown>;
    retrieve(paymentIntentId: string): Promise<Stripe.PaymentIntent>;
  };
};

export async function expireStaleDirectQrOrders(params: {
  env: Env;
  staleAfterSeconds?: number;
  limit?: number;
  stripe?: SweepStripe;
}): Promise<{ canceled: number; recovered: number; failed: number }> {
  const summary = { canceled: 0, recovered: 0, failed: 0 };
  // Cancelling intents is Stripe traffic; without a key there is nothing to
  // reconcile and `createStripe` would throw on every scheduled run.
  if (!readRuntimeString(params.env, "STRIPE_SECRET_KEY")) return summary;

  const staleAfterSeconds = Math.max(
    5 * 60,
    Math.floor(params.staleAfterSeconds ?? getDirectQrStaleSeconds(params.env)),
  );
  const limit = Math.min(
    STALE_DIRECT_QR_ORDER_BATCH,
    Math.max(1, Math.floor(params.limit ?? STALE_DIRECT_QR_ORDER_BATCH)),
  );

  // Only `credit_pack` rows: subscription checkouts share the table and are
  // reconciled by Stripe itself.
  const candidates = await params.env.DB.prepare(
    `SELECT id, provider_session_id AS paymentIntentId
     FROM "order"
     WHERE provider = 'stripe' AND kind = 'credit_pack'
       AND status IN ('created', 'processing')
       AND createdAt <= unixepoch() - ?
     ORDER BY last_reconcile_attempt_at, createdAt, id
     LIMIT ?`,
  )
    .bind(staleAfterSeconds, limit)
    .all<{ id: string; paymentIntentId: string | null }>();

  if (candidates.results.length === 0) return summary;

  const stripe = params.stripe ?? createStripe(params.env);
  for (const candidate of candidates.results) {
    // Persist the attempt before contacting Stripe, including for errors and
    // unknown outcomes. Later runs prioritize orders not attempted as recently,
    // so a full batch of stuck intents cannot starve the rest after a restart.
    try {
      const claimed = await params.env.DB.prepare(
        `UPDATE "order" SET last_reconcile_attempt_at = unixepoch()
         WHERE id = ? AND status IN ('created', 'processing')`,
      )
        .bind(candidate.id)
        .run();
      if (claimed.meta.changes !== 1) continue;
      const outcome = await sweepDirectQrOrder(params.env, stripe, candidate);
      // `skipped` means the state was unknown, so the row stays pending for the
      // next run and nothing is counted.
      if (outcome !== "skipped") summary[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      logEvent("error", "billing.direct_qr_expire_failed", {
        orderId: candidate.id,
        paymentIntentId: candidate.paymentIntentId,
        message: errorMessage(error),
      });
    }
  }

  logEvent("info", "billing.direct_qr_reaper", { ...summary });
  return summary;
}

type SweepOutcome = "canceled" | "recovered" | "failed" | "skipped";

/**
 * Release one abandoned order: cancel the code, or grant the credits if it was
 * paid after all (a lost webhook is the case this recovers from).
 */
async function sweepDirectQrOrder(
  env: Env,
  stripe: SweepStripe,
  candidate: { id: string; paymentIntentId: string | null },
): Promise<SweepOutcome> {
  // No intent id means the request died before Stripe answered, so there is
  // nothing payable to release.
  if (!candidate.paymentIntentId) {
    await markOrderFailed(env, candidate.id);
    return "failed";
  }

  try {
    await stripe.paymentIntents.cancel(candidate.paymentIntentId);
    await markOrderFailed(env, candidate.id);
    return "canceled";
  } catch (error) {
    let current: Stripe.PaymentIntent | null = null;
    try {
      current = await stripe.paymentIntents.retrieve(candidate.paymentIntentId);
    } catch {
      current = null;
    }

    if (current?.status === "succeeded") {
      await fulfillDirectQrIntent(env, current);
      logEvent("warn", "billing.direct_qr_recovered", {
        orderId: candidate.id,
        paymentIntentId: candidate.paymentIntentId,
      });
      return "recovered";
    }

    // The state could not be confirmed, so the intent may still be payable.
    // Failing the order now would drop it out of the sweep forever and leave a
    // live code nobody tracks; the next run picks it up instead.
    if (!current) {
      logEvent("warn", "billing.direct_qr_expire_unconfirmed", {
        orderId: candidate.id,
        paymentIntentId: candidate.paymentIntentId,
        message: errorMessage(error),
      });
      return "skipped";
    }

    if (current.status === "canceled") {
      await markOrderFailed(env, candidate.id);
      return "failed";
    }

    // A failed cancellation is not proof of a failed payment. Keep payable and
    // in-flight intents eligible for cancellation or fulfillment on the next tick.
    return "skipped";
  }
}
