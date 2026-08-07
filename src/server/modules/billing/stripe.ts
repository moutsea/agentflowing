import Stripe from "stripe";

import { readRuntimeString } from "../../env";
import { getPaidPlan, getPlan } from "./catalog";

type StoredOrder = {
  id: string;
  organization_id: string;
  plan_id: string;
  status: string;
};

type StoredSubscription = {
  organization_id: string;
  plan_id: string;
};

export class StripeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConfigurationError";
  }
}

export class StripeWebhookInProgressError extends Error {
  constructor() {
    super("Stripe webhook is already being processed");
    this.name = "StripeWebhookInProgressError";
  }
}

export const STRIPE_WEBHOOK_LEASE_SECONDS = 5 * 60;

function createStripe(env: Env) {
  const secretKey = readRuntimeString(env, "STRIPE_SECRET_KEY");
  if (!secretKey) throw new StripeConfigurationError("Stripe is not configured");
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
}

function objectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createStripeCheckout(params: {
  env: Env;
  organizationId: string;
  userId: string;
  userEmail: string;
  planId: string;
}) {
  const plan = getPaidPlan(params.env, params.planId);
  if (!plan) {
    throw new StripeConfigurationError("This paid plan is not configured");
  }

  const orderId = crypto.randomUUID();
  await params.env.DB.prepare(
    `INSERT INTO "order"
     (id, organization_id, provider, kind, plan_id, amount, currency, credits,
      status, createdAt, updatedAt)
     VALUES (?, ?, 'stripe', 'subscription', ?, ?, 'usd', ?, 'created',
             unixepoch(), unixepoch())`,
  )
    .bind(orderId, params.organizationId, plan.id, plan.monthlyPrice * 100, plan.credits)
    .run();

  const metadata = {
    orderId,
    organizationId: params.organizationId,
    userId: params.userId,
    planId: plan.id,
  };
  const stripe = createStripe(params.env);
  const appUrl = readRuntimeString(params.env, "APP_URL", { required: true });
  try {
    const checkout = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer_email: params.userEmail,
        client_reference_id: params.organizationId,
        line_items: [{ price: plan.priceId, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: `${appUrl}/app?checkout=success`,
        cancel_url: `${appUrl}/pricing?checkout=canceled`,
        metadata,
        subscription_data: { metadata },
      },
      { idempotencyKey: `agentflowing-checkout:${orderId}` },
    );
    await params.env.DB.prepare(
      `UPDATE "order" SET provider_session_id = ?, updatedAt = unixepoch()
       WHERE id = ?`,
    )
      .bind(checkout.id, orderId)
      .run();
    if (!checkout.url) throw new Error("Stripe did not return a checkout URL");
    return { orderId, checkoutUrl: checkout.url };
  } catch (error) {
    await params.env.DB.prepare(
      `UPDATE "order" SET status = 'failed', updatedAt = unixepoch() WHERE id = ?`,
    )
      .bind(orderId)
      .run();
    throw error;
  }
}

export async function createStripePortal(params: { env: Env; organizationId: string }) {
  const subscription = await params.env.DB.prepare(
    `SELECT provider_customer_id AS customerId
     FROM subscription
     WHERE organization_id = ? AND provider = 'stripe'
       AND provider_customer_id IS NOT NULL
     ORDER BY updatedAt DESC LIMIT 1`,
  )
    .bind(params.organizationId)
    .first<{ customerId: string }>();
  if (!subscription?.customerId) {
    throw new Error("No Stripe customer exists for this workspace");
  }
  const appUrl = readRuntimeString(params.env, "APP_URL", { required: true });
  const portal = await createStripe(params.env).billingPortal.sessions.create({
    customer: subscription.customerId,
    return_url: `${appUrl}/app`,
  });
  return { portalUrl: portal.url };
}

export async function verifyAndProcessStripeWebhook(params: {
  env: Env;
  payload: string;
  signature: string;
}) {
  const webhookSecret = readRuntimeString(params.env, "STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) throw new StripeConfigurationError("Stripe webhook is not configured");
  const event = await createStripe(params.env).webhooks.constructEventAsync(
    params.payload,
    params.signature,
    webhookSecret,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
  return processStripeEvent(params.env, event, await sha256(params.payload));
}

export async function processStripeEvent(env: Env, event: Stripe.Event, payloadHash: string) {
  const eventRowId = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_event
     (id, provider, provider_event_id, type, status, payload_hash, createdAt, updatedAt)
     VALUES (?, 'stripe', ?, ?, 'processing', ?, unixepoch(), unixepoch())`,
  )
    .bind(eventRowId, event.id, event.type, payloadHash)
    .run();

  if (inserted.meta.changes === 0) {
    const existing = await env.DB.prepare(
      `SELECT id, status, payload_hash AS payloadHash
       FROM payment_event WHERE provider = 'stripe' AND provider_event_id = ?`,
    )
      .bind(event.id)
      .first<{ id: string; status: string; payloadHash: string }>();
    if (!existing) throw new Error("Payment event disappeared during processing");
    if (existing.payloadHash !== payloadHash) {
      throw new Error("Stripe event payload changed between deliveries");
    }
    if (existing.status === "completed") return { duplicate: true };
    const claimed = await env.DB.prepare(
      `UPDATE payment_event SET status = 'processing', error = NULL, updatedAt = unixepoch()
       WHERE id = ? AND (
         status = 'failed' OR
         (status = 'processing' AND updatedAt <= unixepoch() - ?)
       )`,
    )
      .bind(existing.id, STRIPE_WEBHOOK_LEASE_SECONDS)
      .run();
    if (claimed.meta.changes !== 1) throw new StripeWebhookInProgressError();
  }

  try {
    await dispatchStripeEvent(env, event);
    return { duplicate: false };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE payment_event SET status = 'failed', error = ?, updatedAt = unixepoch()
       WHERE provider = 'stripe' AND provider_event_id = ? AND status = 'processing'`,
    )
      .bind(
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        event.id,
      )
      .run();
    throw error;
  }
}

async function dispatchStripeEvent(env: Env, event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await fulfillCheckout(env, event.id, event.data.object);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(env, event.id, event.data.object);
      return;
    case "invoice.paid":
      await fulfillRenewal(env, event.id, event.data.object);
      return;
    case "invoice.payment_failed":
      await markSubscriptionPastDue(env, event.id, event.data.object);
      return;
    default:
      await markEventCompleted(env, event.id);
  }
}

async function fulfillCheckout(env: Env, eventId: string, session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    throw new Error(`Checkout is not paid: ${session.payment_status}`);
  }
  const orderId = metadataValue(session.metadata, "orderId");
  if (!orderId) throw new Error("Stripe checkout metadata is missing orderId");
  const storedOrder = await env.DB.prepare(
    `SELECT id, organization_id, plan_id, status FROM "order" WHERE id = ?`,
  )
    .bind(orderId)
    .first<StoredOrder>();
  if (!storedOrder) throw new Error("Checkout order was not found");
  if (metadataValue(session.metadata, "organizationId") !== storedOrder.organization_id) {
    throw new Error("Checkout organization does not match the stored order");
  }
  const plan = getPlan(storedOrder.plan_id);
  if (!plan || plan.id === "free") throw new Error("Checkout order has an invalid plan");
  const subscriptionId = objectId(session.subscription);
  if (!subscriptionId) throw new Error("Checkout did not create a subscription");
  const customerId = objectId(session.customer);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscription
       (id, organization_id, provider, provider_customer_id, provider_subscription_id,
        plan_id, status, cancel_at_period_end, createdAt, updatedAt)
       VALUES (?, ?, 'stripe', ?, ?, ?, 'active', 0, unixepoch(), unixepoch())
       ON CONFLICT(provider, provider_subscription_id) DO UPDATE SET
         organization_id = excluded.organization_id,
         provider_customer_id = excluded.provider_customer_id,
         plan_id = excluded.plan_id,
         status = 'active',
         updatedAt = unixepoch()`,
    ).bind(crypto.randomUUID(), storedOrder.organization_id, customerId, subscriptionId, plan.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description,
        reference_type, reference_id, created_at)
       VALUES (?, ?, ?, 'grant', ?, ?, 'stripe_checkout', ?, unixepoch())`,
    ).bind(
      crypto.randomUUID(),
      storedOrder.organization_id,
      plan.credits,
      `stripe:checkout:${session.id}`,
      `${plan.name} subscription credits`,
      session.id,
    ),
    env.DB.prepare(
      `UPDATE "order"
       SET provider_session_id = ?, amount = ?, status = 'paid', paid_at = unixepoch(),
           updatedAt = unixepoch()
       WHERE id = ?`,
    ).bind(session.id, session.amount_total ?? plan.monthlyPrice * 100, storedOrder.id),
    completedEventStatement(env, eventId),
  ]);
}

async function syncSubscription(
  env: Env,
  eventId: string,
  stripeSubscription: Stripe.Subscription,
) {
  const existing = await findStoredSubscription(env, stripeSubscription.id);
  const organizationId =
    metadataValue(stripeSubscription.metadata, "organizationId") ?? existing?.organization_id;
  const planId = metadataValue(stripeSubscription.metadata, "planId") ?? existing?.plan_id;
  if (!organizationId || !planId || !getPlan(planId)) {
    await markEventCompleted(env, eventId);
    return;
  }
  const periods = stripeSubscription.items.data.map((item) => ({
    start: item.current_period_start,
    end: item.current_period_end,
  }));
  const periodStart = periods.length ? Math.min(...periods.map((item) => item.start)) : null;
  const periodEnd = periods.length ? Math.max(...periods.map((item) => item.end)) : null;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscription
       (id, organization_id, provider, provider_customer_id, provider_subscription_id,
        provider_price_id, plan_id, status, current_period_start, current_period_end,
        cancel_at_period_end, canceled_at, createdAt, updatedAt)
       VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(provider, provider_subscription_id) DO UPDATE SET
         provider_customer_id = excluded.provider_customer_id,
         provider_price_id = excluded.provider_price_id,
         plan_id = excluded.plan_id,
         status = excluded.status,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         canceled_at = excluded.canceled_at,
         updatedAt = unixepoch()`,
    ).bind(
      crypto.randomUUID(),
      organizationId,
      objectId(stripeSubscription.customer),
      stripeSubscription.id,
      objectId(stripeSubscription.items.data[0]?.price),
      planId,
      stripeSubscription.status,
      periodStart,
      periodEnd,
      stripeSubscription.cancel_at_period_end ? 1 : 0,
      stripeSubscription.canceled_at,
    ),
    completedEventStatement(env, eventId),
  ]);
}

async function fulfillRenewal(env: Env, eventId: string, invoice: Stripe.Invoice) {
  if (invoice.billing_reason !== "subscription_cycle") {
    await markEventCompleted(env, eventId);
    return;
  }
  const details = invoice.parent?.subscription_details;
  const subscriptionId = objectId(details?.subscription);
  if (!subscriptionId) throw new Error("Renewal invoice has no subscription");
  const existing = await findStoredSubscription(env, subscriptionId);
  const organizationId =
    metadataValue(details?.metadata, "organizationId") ?? existing?.organization_id;
  const planId = metadataValue(details?.metadata, "planId") ?? existing?.plan_id;
  const plan = planId ? getPlan(planId) : null;
  if (!organizationId || !plan || plan.id === "free") {
    throw new Error("Renewal invoice cannot be mapped to a paid workspace plan");
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description,
        reference_type, reference_id, created_at)
       VALUES (?, ?, ?, 'grant', ?, ?, 'stripe_invoice', ?, unixepoch())`,
    ).bind(
      crypto.randomUUID(),
      organizationId,
      plan.credits,
      `stripe:invoice:${invoice.id}`,
      `${plan.name} renewal credits`,
      invoice.id,
    ),
    env.DB.prepare(
      `UPDATE subscription
       SET status = 'active', current_period_start = ?, current_period_end = ?,
           updatedAt = unixepoch()
       WHERE provider = 'stripe' AND provider_subscription_id = ?`,
    ).bind(invoice.period_start, invoice.period_end, subscriptionId),
    completedEventStatement(env, eventId),
  ]);
}

async function markSubscriptionPastDue(env: Env, eventId: string, invoice: Stripe.Invoice) {
  const subscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) {
    await markEventCompleted(env, eventId);
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE subscription SET status = 'past_due', updatedAt = unixepoch()
       WHERE provider = 'stripe' AND provider_subscription_id = ?`,
    ).bind(subscriptionId),
    completedEventStatement(env, eventId),
  ]);
}

async function findStoredSubscription(env: Env, subscriptionId: string) {
  return env.DB.prepare(
    `SELECT organization_id, plan_id FROM subscription
     WHERE provider = 'stripe' AND provider_subscription_id = ?`,
  )
    .bind(subscriptionId)
    .first<StoredSubscription>();
}

function completedEventStatement(env: Env, eventId: string) {
  return env.DB.prepare(
    `UPDATE payment_event SET status = 'completed', error = NULL, updatedAt = unixepoch()
     WHERE provider = 'stripe' AND provider_event_id = ?`,
  ).bind(eventId);
}

async function markEventCompleted(env: Env, eventId: string) {
  await completedEventStatement(env, eventId).run();
}
