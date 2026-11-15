import { applyD1Migrations, env } from "cloudflare:test";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { issueCoupon } from "../src/server/modules/coupons/service";
import {
  calculateDiscountedMinorAmount,
  createDirectQrCheckout,
  expireStaleDirectQrOrders,
  failDirectQrOrder,
  fulfillDirectQrIntent,
  selectMaximumDiscountRateBps,
} from "../src/server/modules/billing/direct-qr-service";
import { processStripeEvent } from "../src/server/modules/billing/stripe";

const migrationFiles = import.meta.glob("../migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const migrations = Object.entries(migrationFiles)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, sql]) => ({
    name: path.split("/").at(-1) ?? path,
    queries: sql
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter(Boolean),
  }));

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => vi.unstubAllGlobals());

function configuredEnv(overrides: Record<string, string> = {}) {
  return {
    ...env,
    STRIPE_SECRET_KEY: "sk_test_direct_qr_coupon",
    STRIPE_PRO_PRICE_ID: "price_test_pro",
    DIRECT_QR_PAYMENT_MODE: "all",
    ...overrides,
  } as unknown as Env;
}

async function seedWorkspace() {
  const suffix = crypto.randomUUID();
  const userId = `coupon_user_${suffix}`;
  const organizationId = `coupon_org_${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, 'Coupon Payer', ?, 1, unixepoch(), unixepoch())`,
    ).bind(userId, `${userId}@example.com`),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, 'Coupon Workspace', ?, unixepoch())`,
    ).bind(organizationId, `coupon-${suffix}`),
  ]);
  return { userId, organizationId };
}

type CreatedIntent = {
  intent: Stripe.PaymentIntent;
  body: URLSearchParams;
};

let paymentIntentSequence = 0;

function stripeFetchMock() {
  const created: CreatedIntent[] = [];
  const intents = new Map<string, Stripe.PaymentIntent>();

  const fetchStripe = vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    const path = new URL(url).pathname;
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : request
            ? await request.clone().text()
            : "";
    const body = new URLSearchParams(bodyText);

    if (method === "POST" && path === "/v1/payment_intents") {
      paymentIntentSequence += 1;
      const paymentIntentId = `pi_coupon${paymentIntentSequence}`;
      const paymentMethod = body.get("payment_method_types[0]") ?? "wechat_pay";
      const metadata = {
        orderId: body.get("metadata[orderId]") ?? "",
        organizationId: body.get("metadata[organizationId]") ?? "",
        userId: body.get("metadata[userId]") ?? "",
        planId: body.get("metadata[planId]") ?? "",
        flow: body.get("metadata[flow]") ?? "direct_qr",
        ...(body.get("metadata[couponId]")
          ? {
              couponId: body.get("metadata[couponId]") ?? "",
              couponCode: body.get("metadata[couponCode]") ?? "",
              couponReservationId: body.get("metadata[couponReservationId]") ?? "",
              baseAmount: body.get("metadata[baseAmount]") ?? "",
              discountAmount: body.get("metadata[discountAmount]") ?? "",
              discountRateBps: body.get("metadata[discountRateBps]") ?? "",
            }
          : {}),
      };
      const intent = {
        id: paymentIntentId,
        object: "payment_intent",
        status: "requires_action",
        amount: Number(body.get("amount")),
        amount_received: 0,
        currency: body.get("currency") ?? "usd",
        metadata,
        next_action:
          paymentMethod === "alipay"
            ? {
                type: "alipay_handle_redirect",
                alipay_handle_redirect: {
                  native_url: "alipays://platformapi/startapp?appId=20000067",
                  url: "https://pay.stripe.com/alipay",
                },
              }
            : {
                type: "wechat_pay_display_qr_code",
                wechat_pay_display_qr_code: {
                  data: "weixin://wxpay/bizpayurl?pr=coupon-test",
                },
              },
      } as unknown as Stripe.PaymentIntent;
      created.push({ intent, body });
      intents.set(paymentIntentId, intent);
      return Response.json(intent, { status: 200 });
    }

    const paymentIntentMatch = /^\/v1\/payment_intents\/([^/]+)(?:\/cancel)?$/.exec(path);
    if (paymentIntentMatch) {
      const paymentIntentId = paymentIntentMatch[1]!;
      const current = intents.get(paymentIntentId);
      if (!current) return Response.json({ error: { code: "resource_missing" } }, { status: 404 });
      if (method === "POST" && path.endsWith("/cancel")) {
        const canceled = { ...current, status: "canceled", next_action: null };
        intents.set(paymentIntentId, canceled as Stripe.PaymentIntent);
        return Response.json(canceled, { status: 200 });
      }
      return Response.json(current, { status: 200 });
    }

    return Response.json(
      { error: { message: `Unexpected Stripe request: ${method} ${path}` } },
      { status: 500 },
    );
  });

  vi.stubGlobal("fetch", fetchStripe);
  return { created, intents, fetchStripe };
}

function succeededIntent(
  created: CreatedIntent,
  amountReceived = Number(created.body.get("amount")),
) {
  return {
    ...created.intent,
    status: "succeeded",
    amount_received: amountReceived,
    next_action: null,
  } as Stripe.PaymentIntent;
}

function stripeEvent(
  id: string,
  type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled",
  intent: Stripe.PaymentIntent,
) {
  return {
    id,
    object: "event",
    api_version: "2026-01-28.clover",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object: intent },
  } as unknown as Stripe.Event;
}

async function couponRow(couponId: string) {
  return env.DB.prepare(
    `SELECT status, reservation_id AS reservationId,
            reserved_by_user_id AS reservedByUserId,
            reserved_organization_id AS reservedOrganizationId,
            reserved_at AS reservedAt,
            reservation_expires_at AS reservationExpiresAt,
            redeemed_by_user_id AS redeemedByUserId,
            redeemed_organization_id AS redeemedOrganizationId,
            redeemed_at AS redeemedAt
     FROM coupon WHERE id = ?`,
  )
    .bind(couponId)
    .first<{
      status: string;
      reservationId: string | null;
      reservedByUserId: string | null;
      reservedOrganizationId: string | null;
      reservedAt: number | null;
      reservationExpiresAt: number | null;
      redeemedByUserId: string | null;
      redeemedOrganizationId: string | null;
      redeemedAt: number | null;
    }>();
}

async function orderRow(orderId: string) {
  return env.DB.prepare(
    `SELECT status, provider_session_id AS paymentIntentId,
            amount, base_amount AS baseAmount, discount_amount AS discountAmount,
            discount_rate_bps AS discountRateBps, coupon_id AS couponId,
            coupon_reservation_id AS couponReservationId, createdAt
     FROM "order" WHERE id = ?`,
  )
    .bind(orderId)
    .first<{
      status: string;
      paymentIntentId: string | null;
      amount: number;
      baseAmount: number | null;
      discountAmount: number | null;
      discountRateBps: number | null;
      couponId: string | null;
      couponReservationId: string | null;
      createdAt: number;
    }>();
}

async function balance(organizationId: string) {
  const row = await env.DB.prepare(`SELECT balance FROM credit_account WHERE organization_id = ?`)
    .bind(organizationId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

describe("direct QR coupon checkout", () => {
  it("allows only one concurrent reservation and records its order and expiry owner", async () => {
    const stripe = stripeFetchMock();
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 20 });

    const results = await Promise.allSettled([
      createDirectQrCheckout({
        env: configuredEnv(),
        organizationId: first.organizationId,
        userId: first.userId,
        userEmail: `${first.userId}@example.com`,
        planId: "pro",
        method: "wechat_pay",
        appUrl: env.APP_URL,
        couponCode: coupon.code,
      }),
      createDirectQrCheckout({
        env: configuredEnv(),
        organizationId: second.organizationId,
        userId: second.userId,
        userEmail: `${second.userId}@example.com`,
        planId: "pro",
        method: "wechat_pay",
        appUrl: env.APP_URL,
        couponCode: coupon.code.toLowerCase(),
      }),
    ]);

    const winners = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createDirectQrCheckout>>> =>
        result.status === "fulfilled",
    );
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({
      status: "rejected",
      reason: { code: "coupon_reserved", status: 409 },
    });
    expect(stripe.created).toHaveLength(1);

    const winner = winners[0]!.value;
    const storedCoupon = await couponRow(coupon.id);
    const storedOrder = await orderRow(winner.orderId);
    expect(storedCoupon).toMatchObject({
      status: "reserved",
      reservationId: winner.orderId,
      reservedByUserId: expect.any(String),
      reservedOrganizationId: expect.any(String),
      reservedAt: expect.any(Number),
      reservationExpiresAt: expect.any(Number),
    });
    expect(storedCoupon!.reservationExpiresAt! - storedCoupon!.reservedAt!).toBe(60 * 60);
    expect([first.userId, second.userId]).toContain(storedCoupon!.reservedByUserId);
    expect([first.organizationId, second.organizationId]).toContain(
      storedCoupon!.reservedOrganizationId,
    );
    expect(storedOrder).toMatchObject({
      status: "processing",
      couponId: coupon.id,
      couponReservationId: winner.orderId,
    });
  });

  it("uses the maximum integer discount in minor units and never creates Stripe coupons", async () => {
    expect(selectMaximumDiscountRateBps([1_000, 2_500, 1_500])).toBe(2_500);
    expect(calculateDiscountedMinorAmount(2_900, 2_500)).toBe(2_175);
    expect(Number.isInteger(calculateDiscountedMinorAmount(2_900, 2_500))).toBe(true);

    const stripe = stripeFetchMock();
    const workspace = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 25 });
    const checkout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      userEmail: `${workspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: coupon.code,
    });

    const request = stripe.created[0]!;
    expect(Number(request.body.get("amount"))).toBe(2_175);
    expect(request.body.has("coupon")).toBe(false);
    expect(request.body.has("promotion_code")).toBe(false);
    expect(
      stripe.fetchStripe.mock.calls.every(([input]) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return !url.includes("/coupons") && !url.includes("/promotion_codes");
      }),
    ).toBe(true);

    expect(await orderRow(checkout.orderId)).toMatchObject({
      amount: 2_175,
      baseAmount: 2_900,
      discountAmount: 725,
      discountRateBps: 2_500,
    });
  });

  it("confirms the coupon and grants once when a succeeded webhook is retried", async () => {
    const stripe = stripeFetchMock();
    const workspace = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 20 });
    const checkout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      userEmail: `${workspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: coupon.code,
    });
    const paid = succeededIntent(stripe.created[0]!);
    const event = stripeEvent(
      `evt_coupon_success_${crypto.randomUUID()}`,
      "payment_intent.succeeded",
      paid,
    );

    await expect(processStripeEvent(env, event, "coupon-success-payload")).resolves.toEqual({
      duplicate: false,
    });
    await expect(processStripeEvent(env, event, "coupon-success-payload")).resolves.toEqual({
      duplicate: true,
    });

    expect(await couponRow(coupon.id)).toMatchObject({
      status: "used",
      reservationId: checkout.orderId,
      redeemedByUserId: workspace.userId,
      redeemedOrganizationId: workspace.organizationId,
      redeemedAt: expect.any(Number),
    });
    expect(await orderRow(checkout.orderId)).toMatchObject({ status: "paid" });
    expect(await balance(workspace.organizationId)).toBe(5_000);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM credit_ledger
         WHERE organization_id = ? AND idempotency_key = ?`,
      )
        .bind(workspace.organizationId, `stripe:direct_qr:${paid.id}`)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("settles a current success instead of releasing on a stale failed webhook", async () => {
    const stripe = stripeFetchMock();
    const workspace = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 20 });
    const checkout = await createDirectQrCheckout({
      env: configuredEnv(),
      ...workspace,
      userEmail: `${workspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: coupon.code,
    });
    const paid = succeededIntent(stripe.created[0]!);
    stripe.intents.set(paid.id, paid);
    await processStripeEvent(
      configuredEnv(),
      stripeEvent(`evt_stale_${crypto.randomUUID()}`, "payment_intent.payment_failed", {
        ...paid,
        status: "requires_payment_method",
        amount_received: 0,
      }),
      "stale-failure",
    );
    await processStripeEvent(
      configuredEnv(),
      stripeEvent(`evt_paid_${crypto.randomUUID()}`, "payment_intent.succeeded", paid),
      "current-success",
    );
    expect(await couponRow(coupon.id)).toMatchObject({ status: "used" });
    expect(await orderRow(checkout.orderId)).toMatchObject({ status: "paid" });
    expect(await balance(workspace.organizationId)).toBe(5_000);
  });

  it("releases reservations for failed and canceled payment intents", async () => {
    const stripe = stripeFetchMock();
    const failedWorkspace = await seedWorkspace();
    const canceledWorkspace = await seedWorkspace();
    const failedCoupon = await issueCoupon({ env, rate: 10 });
    const canceledCoupon = await issueCoupon({ env, rate: 15 });
    const failedCheckout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: failedWorkspace.organizationId,
      userId: failedWorkspace.userId,
      userEmail: `${failedWorkspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: failedCoupon.code,
    });
    const canceledCheckout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: canceledWorkspace.organizationId,
      userId: canceledWorkspace.userId,
      userEmail: `${canceledWorkspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: canceledCoupon.code,
    });

    await processStripeEvent(
      configuredEnv(),
      stripeEvent(`evt_coupon_failed_${crypto.randomUUID()}`, "payment_intent.payment_failed", {
        ...stripe.created[0]!.intent,
        status: "requires_payment_method",
      }),
      "coupon-failed-payload",
    );
    await processStripeEvent(
      env,
      stripeEvent(`evt_coupon_canceled_${crypto.randomUUID()}`, "payment_intent.canceled", {
        ...stripe.created[1]!.intent,
        status: "canceled",
      }),
      "coupon-canceled-payload",
    );

    expect(await couponRow(failedCoupon.id)).toMatchObject({
      status: "active",
      reservationId: null,
      reservedByUserId: null,
      reservationExpiresAt: null,
    });
    expect(await couponRow(canceledCoupon.id)).toMatchObject({
      status: "active",
      reservationId: null,
      reservedByUserId: null,
      reservationExpiresAt: null,
    });
    expect(await orderRow(failedCheckout.orderId)).toMatchObject({ status: "failed" });
    expect(await orderRow(canceledCheckout.orderId)).toMatchObject({ status: "failed" });
  });

  it("releases an abandoned reservation in the stale sweep, while payment success wins the race", async () => {
    const stripe = stripeFetchMock();
    const abandonedWorkspace = await seedWorkspace();
    const abandonedCoupon = await issueCoupon({ env, rate: 10 });
    const abandoned = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: abandonedWorkspace.organizationId,
      userId: abandonedWorkspace.userId,
      userEmail: `${abandonedWorkspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: abandonedCoupon.code,
    });
    await env.DB.prepare(`UPDATE "order" SET createdAt = unixepoch() - 3_601 WHERE id = ?`)
      .bind(abandoned.orderId)
      .run();

    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv(),
        staleAfterSeconds: 3_600,
        stripe: {
          paymentIntents: {
            cancel: async () => ({ status: "canceled" }),
            retrieve: async () => ({}) as Stripe.PaymentIntent,
          },
        },
      }),
    ).resolves.toEqual({ canceled: 1, recovered: 0, failed: 0 });
    expect(await couponRow(abandonedCoupon.id)).toMatchObject({
      status: "active",
      reservationId: null,
      reservationExpiresAt: null,
    });
    expect(await orderRow(abandoned.orderId)).toMatchObject({ status: "failed" });

    const paidWorkspace = await seedWorkspace();
    const paidCoupon = await issueCoupon({ env, rate: 30 });
    const paidCheckout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: paidWorkspace.organizationId,
      userId: paidWorkspace.userId,
      userEmail: `${paidWorkspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: paidCoupon.code,
    });
    const paidIntent = succeededIntent(stripe.created[1]!);
    await env.DB.prepare(`UPDATE "order" SET createdAt = unixepoch() - 3_601 WHERE id = ?`)
      .bind(paidCheckout.orderId)
      .run();

    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv(),
        staleAfterSeconds: 3_600,
        stripe: {
          paymentIntents: {
            cancel: async () => {
              throw new Error("payment already succeeded");
            },
            retrieve: async () => paidIntent,
          },
        },
      }),
    ).resolves.toEqual({ canceled: 0, recovered: 1, failed: 0 });
    expect(await couponRow(paidCoupon.id)).toMatchObject({
      status: "used",
      reservationId: paidCheckout.orderId,
      redeemedByUserId: paidWorkspace.userId,
    });
    expect(await orderRow(paidCheckout.orderId)).toMatchObject({ status: "paid" });
    expect(await balance(paidWorkspace.organizationId)).toBe(5_000);

    // A late failure/release signal must not reopen a coupon after payment won.
    await failDirectQrOrder(env, paidCheckout.orderId);
    expect(await couponRow(paidCoupon.id)).toMatchObject({ status: "used" });
    expect(await orderRow(paidCheckout.orderId)).toMatchObject({ status: "paid" });
  });

  it("lets a late payment success win after a generic failure signal", async () => {
    const stripe = stripeFetchMock();
    const workspace = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 20 });
    const checkout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      userEmail: `${workspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: coupon.code,
    });
    const paid = succeededIntent(stripe.created[0]!);

    await failDirectQrOrder(env, checkout.orderId);
    await fulfillDirectQrIntent(env, paid);

    expect(await couponRow(coupon.id)).toMatchObject({
      status: "used",
      reservationId: checkout.orderId,
      redeemedByUserId: workspace.userId,
    });
    expect(await orderRow(checkout.orderId)).toMatchObject({ status: "paid" });
    expect(await balance(workspace.organizationId)).toBe(5_000);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM credit_ledger
         WHERE organization_id = ? AND idempotency_key = ?`,
      )
        .bind(workspace.organizationId, `stripe:direct_qr:${paid.id}`)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("recovers a succeeded payment when provider-session persistence was lost", async () => {
    const stripe = stripeFetchMock();
    const workspace = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 20 });
    const checkout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      userEmail: `${workspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: coupon.code,
    });
    const paid = succeededIntent(stripe.created[0]!);

    // Model a provider-session write that failed after Stripe accepted the intent.
    await env.DB.prepare(
      `UPDATE "order" SET provider_session_id = NULL, createdAt = unixepoch() - 3_601
       WHERE id = ?`,
    )
      .bind(checkout.orderId)
      .run();

    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv(),
        stripe: {
          paymentIntents: {
            cancel: async () => { throw new Error("missing provider id"); },
            retrieve: async () => { throw new Error("missing provider id"); },
            search: async () => ({ data: [] }),
          },
        },
      }),
    ).resolves.toEqual({ canceled: 0, recovered: 0, failed: 0 });
    expect(await couponRow(coupon.id)).toMatchObject({ status: "reserved" });

    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv(),
        staleAfterSeconds: 3_600,
        stripe: {
          paymentIntents: {
            cancel: async () => {
              throw new Error("Stripe timeout");
            },
            retrieve: async () => {
              throw new Error("Stripe timeout");
            },
            search: async () => ({ data: [paid] }),
          },
        } as never,
      }),
    ).resolves.toEqual({ canceled: 0, recovered: 1, failed: 0 });

    expect(await couponRow(coupon.id)).toMatchObject({
      status: "used",
      reservationId: checkout.orderId,
      redeemedByUserId: workspace.userId,
    });
    expect(await orderRow(checkout.orderId)).toMatchObject({ status: "paid" });
    expect(await balance(workspace.organizationId)).toBe(5_000);
  });

  it("persists a recovered payable intent and retries cancellation on the next sweep", async () => {
    const stripe = stripeFetchMock();
    const workspace = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 20 });
    const checkout = await createDirectQrCheckout({
      env: configuredEnv(), ...workspace,
      userEmail: `${workspace.userId}@example.com`,
      planId: "pro", method: "wechat_pay", appUrl: env.APP_URL, couponCode: coupon.code,
    });
    const intent = stripe.created[0]!.intent;
    await env.DB.prepare(`UPDATE "order" SET provider_session_id = NULL,
      createdAt = unixepoch() - 7200 WHERE id = ?`).bind(checkout.orderId).run();
    const cancel = vi.fn().mockRejectedValueOnce(new Error("cancel timeout"))
      .mockResolvedValue({ status: "canceled" });
    const search = vi.fn(async () => ({ data: [intent] }));
    const recoveryStripe = { paymentIntents: { cancel, search, retrieve: async () => intent } };
    await expireStaleDirectQrOrders({ env: configuredEnv(), stripe: recoveryStripe });
    expect(await orderRow(checkout.orderId)).toMatchObject({ paymentIntentId: intent.id });
    expect(await couponRow(coupon.id)).toMatchObject({ status: "reserved" });
    await expireStaleDirectQrOrders({ env: configuredEnv(), stripe: recoveryStripe });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(await orderRow(checkout.orderId)).toMatchObject({ status: "failed" });
    expect(await couponRow(coupon.id)).toMatchObject({ status: "active", reservationId: null });
  });

  it("keeps a direct QR fulfillment idempotent even when called beside the webhook", async () => {
    const stripe = stripeFetchMock();
    const workspace = await seedWorkspace();
    const coupon = await issueCoupon({ env, rate: 20 });
    const checkout = await createDirectQrCheckout({
      env: configuredEnv(),
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      userEmail: `${workspace.userId}@example.com`,
      planId: "pro",
      method: "wechat_pay",
      appUrl: env.APP_URL,
      couponCode: coupon.code,
    });
    const paid = succeededIntent(stripe.created[0]!);
    const event = stripeEvent(
      `evt_coupon_poll_${crypto.randomUUID()}`,
      "payment_intent.succeeded",
      paid,
    );

    await Promise.all([
      fulfillDirectQrIntent(env, paid),
      processStripeEvent(env, event, "coupon-poll-payload"),
    ]);
    const ledgerRows = await env.DB.prepare(
      `SELECT delta FROM credit_ledger
       WHERE organization_id = ? AND idempotency_key = ?`,
    )
      .bind(workspace.organizationId, `stripe:direct_qr:${paid.id}`)
      .all<{ delta: number }>();
    expect(ledgerRows.results).toHaveLength(1);
    expect(ledgerRows.results[0]?.delta).toBe(5_000);
    expect(await couponRow(coupon.id)).toMatchObject({
      status: "used",
      reservationId: checkout.orderId,
    });
    expect(await balance(workspace.organizationId)).toBe(5_000);
  });
});
