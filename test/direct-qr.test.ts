import { applyD1Migrations, env } from "cloudflare:test";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isQrPaymentMethod,
  getQrPaymentMethods,
  getSupportedOneTimePaymentMethods,
} from "../src/shared/direct-qr";
import {
  isCancelableDirectQrStatus,
  isDirectQrIntent,
  presentDirectQr,
  qrSvgDataUrl,
  toDirectQrStatus,
} from "../src/server/modules/billing/direct-qr";
import {
  cancelDirectQrIntent,
  DirectQrError,
  DirectQrUnfulfillableError,
  expireStaleDirectQrOrders,
  fulfillDirectQrIntent,
  getDirectQrAvailability,
} from "../src/server/modules/billing/direct-qr-service";
import {
  getBillingCurrency,
  getDirectQrStaleSeconds,
  getPublicCatalog,
} from "../src/server/modules/billing/catalog";
import { formatMoney } from "../src/shared/money";

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

async function seedWorkspace() {
  const suffix = crypto.randomUUID();
  const userId = `user_${suffix}`;
  const organizationId = `org_${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, 'Test Builder', ?, 1, unixepoch(), unixepoch())`,
    ).bind(userId, `builder-${suffix}@example.com`),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, 'Test Workspace', ?, unixepoch())`,
    ).bind(organizationId, `test-workspace-${suffix}`),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'owner', unixepoch())`,
    ).bind(`member_${suffix}`, organizationId, userId),
  ]);
  return { suffix, userId, organizationId };
}

/** Insert the `order` row a direct-QR checkout would have created. */
async function seedDirectQrOrder(organizationId: string) {
  const orderId = `order_${crypto.randomUUID()}`;
  // Stripe ids are alphanumeric, and the loader rejects anything else.
  const paymentIntentId = `pi_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO "order"
     (id, organization_id, provider, provider_session_id, kind, plan_id, amount,
      currency, credits, status, createdAt, updatedAt)
     VALUES (?, ?, 'stripe', ?, 'credit_pack', 'pro', 2900, 'usd', 5000,
             'processing', unixepoch(), unixepoch())`,
  )
    .bind(orderId, organizationId, paymentIntentId)
    .run();
  return { orderId, paymentIntentId };
}

/**
 * The real binding object plus the secrets a configured deployment would have.
 * `DIRECT_QR_PAYMENT_MODE` is the switch the availability tests exercise.
 */
function configuredEnv(overrides: Record<string, string> = {}) {
  return {
    ...env,
    STRIPE_SECRET_KEY: "sk_test_direct_qr",
    PLATFORM_ADMIN_USER_IDS: "",
    ...overrides,
  } as unknown as Env;
}

function succeededIntent(
  orderId: string,
  organizationId: string,
  overrides: Partial<Stripe.PaymentIntent> = {},
  paymentIntentId = "pi_test_direct_qr",
) {
  return {
    id: paymentIntentId,
    object: "payment_intent",
    status: "succeeded",
    amount: 2900,
    amount_received: 2900,
    metadata: {
      orderId,
      organizationId,
      planId: "pro",
      flow: "direct_qr",
    },
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

async function getBalance(organizationId: string) {
  const row = await env.DB.prepare(`SELECT balance FROM credit_account WHERE organization_id = ?`)
    .bind(organizationId)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}

async function getOrderStatus(orderId: string) {
  const row = await env.DB.prepare(`SELECT status, paid_at AS paidAt FROM "order" WHERE id = ?`)
    .bind(orderId)
    .first<{ status: string; paidAt: number | null }>();
  return row;
}

describe("presentDirectQr", () => {
  it("prefers the ready-made WeChat image over the raw payload", () => {
    const presentation = presentDirectQr("wechat_pay", {
      type: "wechat_pay_display_qr_code",
      wechat_pay_display_qr_code: {
        data: "weixin://wxpay/bizpayurl?pr=abc",
        image_data_url: "data:image/png;base64,AAAA",
      },
    } as Stripe.PaymentIntent.NextAction);

    expect(presentation).toEqual({ kind: "qr", qrImage: "data:image/png;base64,AAAA" });
  });

  it("draws the WeChat code itself when Stripe returns only the payload", () => {
    const presentation = presentDirectQr("wechat_pay", {
      type: "wechat_pay_display_qr_code",
      wechat_pay_display_qr_code: { data: "weixin://wxpay/bizpayurl?pr=abc" },
    } as Stripe.PaymentIntent.NextAction);

    expect(presentation?.kind).toBe("qr");
    expect(presentation).toMatchObject({
      qrImage: expect.stringContaining("data:image/svg+xml;charset=utf-8,") as unknown as string,
    });
  });

  it("falls back to the hosted instructions page for WeChat", () => {
    expect(
      presentDirectQr("wechat_pay", {
        type: "wechat_pay_display_qr_code",
        wechat_pay_display_qr_code: { hosted_instructions_url: "https://pay.stripe.com/wechat" },
      } as Stripe.PaymentIntent.NextAction),
    ).toEqual({ kind: "redirect", fallbackUrl: "https://pay.stripe.com/wechat" });
  });

  it("encodes the Alipay deep link so a desktop customer can scan it", () => {
    const presentation = presentDirectQr("alipay", {
      type: "alipay_handle_redirect",
      alipay_handle_redirect: {
        native_url: "alipays://platformapi/startapp?appId=20000067",
        url: "https://pay.stripe.com/alipay",
      },
    } as Stripe.PaymentIntent.NextAction);

    // The deep link wins over the Stripe-hosted page: that substitution is the
    // whole point of the flow.
    expect(presentation?.kind).toBe("qr");
  });

  it("falls back to the Stripe page when Alipay has no deep link", () => {
    expect(
      presentDirectQr("alipay", {
        type: "alipay_handle_redirect",
        alipay_handle_redirect: { url: "https://pay.stripe.com/alipay" },
      } as Stripe.PaymentIntent.NextAction),
    ).toEqual({ kind: "redirect", fallbackUrl: "https://pay.stripe.com/alipay" });
  });

  it("returns null when Stripe offers nothing to show", () => {
    expect(presentDirectQr("wechat_pay", null)).toBeNull();
    expect(presentDirectQr("alipay", undefined)).toBeNull();
    expect(presentDirectQr("alipay", { type: "redirect_to_url" } as never)).toBeNull();
  });
});

describe("qrSvgDataUrl", () => {
  it("produces a self-contained data URL that needs no network access", () => {
    const dataUrl = qrSvgDataUrl("https://example.com/pay?token=abc");

    expect(dataUrl.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    // A raw "#" would end the data URL early and break the <img> src.
    expect(dataUrl.slice(dataUrl.indexOf(",") + 1)).not.toContain("#");
  });

  it("renders an SVG square with a quiet zone and real modules", () => {
    const svg = decodeURIComponent(
      qrSvgDataUrl("https://example.com/pay?token=abc").split(",").at(-1) ?? "",
    );

    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain('shape-rendering="crispEdges"');
    // White background: the code needs a light quiet zone to scan reliably.
    expect(svg).toContain('fill="#ffffff"');

    const [, width, height] = /width="(\d+)" height="(\d+)"/.exec(svg) ?? [];
    expect(width).toBe(height);
    expect(Number(width)).toBeGreaterThan(21);

    // One merged path, one "M…h1v1h-1z" segment per dark module.
    const darkModules = svg.match(/M\d+ \d+h1v1h-1z/g) ?? [];
    expect(darkModules.length).toBeGreaterThan(100);
  });

  it("changes with the payload", () => {
    expect(qrSvgDataUrl("https://example.com/a")).not.toBe(qrSvgDataUrl("https://example.com/b"));
  });
});

describe("toDirectQrStatus", () => {
  it.each([
    ["succeeded", "succeeded"],
    ["canceled", "canceled"],
    ["requires_payment_method", "failed"],
    ["requires_action", "pending"],
    ["processing", "pending"],
    ["requires_capture", "pending"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(toDirectQrStatus(status)).toBe(expected);
  });
});

describe("isCancelableDirectQrStatus", () => {
  it("only lets an unsettled intent be canceled", () => {
    expect(isCancelableDirectQrStatus("requires_payment_method")).toBe(true);
    expect(isCancelableDirectQrStatus("requires_confirmation")).toBe(true);
    expect(isCancelableDirectQrStatus("requires_action")).toBe(true);

    // Canceling these would either fail or, worse, race a captured payment.
    expect(isCancelableDirectQrStatus("processing")).toBe(false);
    expect(isCancelableDirectQrStatus("succeeded")).toBe(false);
    expect(isCancelableDirectQrStatus("canceled")).toBe(false);
  });
});

describe("direct-QR payment methods", () => {
  it("offers both wallets for the currencies Stripe settles them in", () => {
    expect(getQrPaymentMethods("usd")).toEqual(["wechat_pay", "alipay"]);
    // Normalized, because the value comes from configuration in any casing.
    expect(getQrPaymentMethods("USD")).toEqual(["wechat_pay", "alipay"]);
    expect(getQrPaymentMethods("jpy")).toEqual(["wechat_pay", "alipay"]);
  });

  it("offers none for a currency no wallet settles in", () => {
    expect(getQrPaymentMethods("krw")).toEqual([]);
    // Card is always the fallback, so checkout never disappears.
    expect(getSupportedOneTimePaymentMethods("krw")).toEqual(["card"]);
  });

  it("keeps WeChat ahead of Alipay", () => {
    // WeChat arrives as a ready-made image, so it is the cheaper one to show.
    expect(getQrPaymentMethods("sgd")).toEqual(["wechat_pay", "alipay"]);
  });

  it("rejects anything that is not a QR method", () => {
    expect(isQrPaymentMethod("alipay")).toBe(true);
    expect(isQrPaymentMethod("card")).toBe(false);
    expect(isQrPaymentMethod(null)).toBe(false);
  });
});

describe("getDirectQrAvailability", () => {
  // Managers are the only callers that matter for the switches below; the
  // `canManage` flag is covered on its own.
  const availability = (source: Env, userId: string) =>
    getDirectQrAvailability(source, { userId, canManage: true });

  it("stays off when Stripe is not configured", () => {
    expect(availability(env, "user_x")).toMatchObject({ enabled: false });
  });

  it("is on for every workspace in `all` mode", () => {
    expect(availability(configuredEnv(), "user_x")).toMatchObject({
      enabled: true,
      currency: "usd",
      methods: ["wechat_pay", "alipay"],
    });
  });

  it("is on for platform admins only in `admins` mode", () => {
    const restricted = configuredEnv({ DIRECT_QR_PAYMENT_MODE: "admins" });
    expect(availability(restricted, "user_x").enabled).toBe(false);

    const admin = configuredEnv({
      DIRECT_QR_PAYMENT_MODE: "admins",
      PLATFORM_ADMIN_USER_IDS: "user_1,user_admin",
    });
    expect(availability(admin, "user_admin").enabled).toBe(true);
    expect(availability(admin, "user_other").enabled).toBe(false);
  });

  it("stays off in `off` mode and for an unreadable mode", () => {
    expect(availability(configuredEnv({ DIRECT_QR_PAYMENT_MODE: "off" }), "u").enabled).toBe(false);
    // A typo must never switch a payment path on that nobody meant to enable.
    expect(availability(configuredEnv({ DIRECT_QR_PAYMENT_MODE: "yes please" }), "u").enabled).toBe(
      false,
    );
  });

  it("hides the wallets for a currency they cannot settle", () => {
    expect(availability(configuredEnv({ DIRECT_QR_CURRENCY: "krw" }), "u")).toMatchObject({
      enabled: false,
      currency: "krw",
      methods: [],
    });
  });

  it("reports whether the caller may start a payment", () => {
    expect(
      getDirectQrAvailability(configuredEnv(), { userId: "u", canManage: false }).canManage,
    ).toBe(false);
    expect(
      getDirectQrAvailability(configuredEnv(), { userId: "u", canManage: true }).canManage,
    ).toBe(true);
  });
});

describe("fulfillDirectQrIntent", () => {
  it.each(["pro", "retired_launch"])(
    "fulfills the stored credit snapshot for %s after catalog changes",
    async (planId) => {
      const { organizationId } = await seedWorkspace();
      const { orderId, paymentIntentId } = await seedDirectQrOrder(organizationId);
      await env.DB.prepare(`UPDATE "order" SET credits = 9000, plan_id = ? WHERE id = ?`)
        .bind(planId, orderId)
        .run();
      const intent = succeededIntent(orderId, organizationId, {}, paymentIntentId);
      expect(await fulfillDirectQrIntent(env, intent)).toEqual({ duplicate: false });
      expect(await fulfillDirectQrIntent(env, intent)).toEqual({ duplicate: true });
      expect(await getBalance(organizationId)).toBe(9000);
      expect(await getOrderStatus(orderId)).toMatchObject({ status: "paid" });
    },
  );

  it("rejects an invalid credit snapshot instead of substituting today's plan", async () => {
    const { organizationId } = await seedWorkspace();
    const { orderId, paymentIntentId } = await seedDirectQrOrder(organizationId);
    await env.DB.prepare(`UPDATE "order" SET credits = 0 WHERE id = ?`).bind(orderId).run();
    await expect(
      fulfillDirectQrIntent(env, succeededIntent(orderId, organizationId, {}, paymentIntentId)),
    ).rejects.toBeInstanceOf(DirectQrUnfulfillableError);
    expect(await getBalance(organizationId)).toBe(0);
    expect(await getOrderStatus(orderId)).toMatchObject({ status: "processing" });
  });

  it("grants the plan credits and marks the order paid", async () => {
    const workspace = await seedWorkspace();
    const { orderId, paymentIntentId } = await seedDirectQrOrder(workspace.organizationId);

    const result = await fulfillDirectQrIntent(
      env,
      succeededIntent(orderId, workspace.organizationId, {}, paymentIntentId),
    );

    expect(result).toEqual({ duplicate: false });
    expect(await getBalance(workspace.organizationId)).toBe(5000);
    expect(await getOrderStatus(orderId)).toMatchObject({ status: "paid" });
  });

  it("is idempotent across the poll, the webhook and a retry", async () => {
    const workspace = await seedWorkspace();
    const { orderId, paymentIntentId } = await seedDirectQrOrder(workspace.organizationId);
    const intent = succeededIntent(orderId, workspace.organizationId, {}, paymentIntentId);

    expect(await fulfillDirectQrIntent(env, intent)).toEqual({ duplicate: false });
    // The status poll and the webhook both land here for one payment.
    expect(await fulfillDirectQrIntent(env, intent)).toEqual({ duplicate: true });
    expect(await fulfillDirectQrIntent(env, intent)).toEqual({ duplicate: true });

    // Credited once, not three times.
    expect(await getBalance(workspace.organizationId)).toBe(5000);
  });

  it("refuses an intent that has not been paid", async () => {
    const workspace = await seedWorkspace();
    const { orderId, paymentIntentId } = await seedDirectQrOrder(workspace.organizationId);

    await expect(
      fulfillDirectQrIntent(
        env,
        succeededIntent(
          orderId,
          workspace.organizationId,
          { status: "requires_action" },
          paymentIntentId,
        ),
      ),
    ).rejects.toThrow(/not succeeded/u);
    expect(await getBalance(workspace.organizationId)).toBe(0);
  });

  it("refuses an intent claiming another workspace's order", async () => {
    const workspace = await seedWorkspace();
    const stranger = await seedWorkspace();
    const { orderId, paymentIntentId } = await seedDirectQrOrder(workspace.organizationId);

    // Right order, wrong payer: neither side decides alone.
    await expect(
      fulfillDirectQrIntent(
        env,
        succeededIntent(orderId, stranger.organizationId, {}, paymentIntentId),
      ),
    ).rejects.toThrow(/does not match/u);
    expect(await getBalance(workspace.organizationId)).toBe(0);
  });

  it("refuses an unknown order", async () => {
    const workspace = await seedWorkspace();

    await expect(
      fulfillDirectQrIntent(env, succeededIntent("order_missing", workspace.organizationId)),
    ).rejects.toThrow(/not found/u);
  });

  it("marks disagreements as permanent, so the webhook stops retrying", async () => {
    const workspace = await seedWorkspace();
    const stranger = await seedWorkspace();
    const { orderId, paymentIntentId } = await seedDirectQrOrder(workspace.organizationId);

    // These can never become grantable: Stripe redelivering the same event
    // would fail identically, and a retry loop would block every later event.
    await expect(
      fulfillDirectQrIntent(env, succeededIntent("order_missing", workspace.organizationId)),
    ).rejects.toBeInstanceOf(DirectQrUnfulfillableError);
    await expect(
      fulfillDirectQrIntent(
        env,
        succeededIntent(orderId, stranger.organizationId, {}, paymentIntentId),
      ),
    ).rejects.toBeInstanceOf(DirectQrUnfulfillableError);
  });
});

describe("cancelDirectQrIntent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["initial_read", "cancel_race"] as const)(
    "fulfills success from %s before returning and never grants twice",
    async (outcome) => {
      const { organizationId } = await seedWorkspace();
      const { orderId, paymentIntentId } = await seedDirectQrOrder(organizationId);
      const paid = succeededIntent(orderId, organizationId, {}, paymentIntentId);
      let reads = 0;
      const fetchStripe = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") {
          return Response.json(
            { error: { type: "invalid_request_error", message: "Already succeeded" } },
            { status: 400 },
          );
        }
        reads += 1;
        return Response.json(
          outcome === "cancel_race" && reads === 1 ? { ...paid, status: "requires_action" } : paid,
        );
      });
      vi.stubGlobal("fetch", fetchStripe);
      const params = { env: configuredEnv(), organizationId, paymentIntentId };
      expect(await cancelDirectQrIntent(params)).toBe("succeeded");
      expect(await getBalance(organizationId)).toBe(5000);
      expect(await getOrderStatus(orderId)).toMatchObject({ status: "paid" });
      expect(fetchStripe).toHaveBeenCalledTimes(outcome === "cancel_race" ? 3 : 1);
      expect(await cancelDirectQrIntent(params)).toBe("succeeded");
      expect(await fulfillDirectQrIntent(env, paid)).toEqual({ duplicate: true });
      expect(await getBalance(organizationId)).toBe(5000);
    },
  );

  it("retries fulfillment after a transient database failure", async () => {
    const { organizationId } = await seedWorkspace();
    const { orderId, paymentIntentId } = await seedDirectQrOrder(organizationId);
    const paid = succeededIntent(orderId, organizationId, {}, paymentIntentId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(paid)),
    );
    const params = { env: configuredEnv(), organizationId, paymentIntentId };
    await env.DB.prepare(
      `CREATE TRIGGER reject_qr_grant BEFORE INSERT ON credit_ledger
       BEGIN SELECT RAISE(ABORT, 'temporary credit write failure'); END`,
    ).run();
    try {
      await expect(cancelDirectQrIntent(params)).rejects.toThrow("temporary credit write failure");
      expect(await getBalance(organizationId)).toBe(0);
      expect(await getOrderStatus(orderId)).toMatchObject({ status: "processing" });
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_qr_grant").run();
    }
    expect(await cancelDirectQrIntent(params)).toBe("succeeded");
    expect(await getBalance(organizationId)).toBe(5000);
  });

  it.each(["processing", "canceled"] as const)(
    "does not grant credits for an unpaid intent in %s",
    async (status) => {
      const { organizationId } = await seedWorkspace();
      const { orderId, paymentIntentId } = await seedDirectQrOrder(organizationId);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(succeededIntent(orderId, organizationId, { status }, paymentIntentId)),
        ),
      );
      expect(
        await cancelDirectQrIntent({ env: configuredEnv(), organizationId, paymentIntentId }),
      ).toBe(status === "processing" ? "pending" : "canceled");
      expect(await getBalance(organizationId)).toBe(0);
    },
  );
});

describe("isDirectQrIntent", () => {
  it("only claims intents this flow stamped", () => {
    expect(isDirectQrIntent({ metadata: { flow: "direct_qr" } })).toBe(true);
    // Checkout-created intents are credited through checkout.session.*, so the
    // payment_intent.* handlers must not touch them.
    expect(isDirectQrIntent({ metadata: { flow: "checkout" } })).toBe(false);
    expect(isDirectQrIntent({ metadata: null })).toBe(false);
    expect(isDirectQrIntent({})).toBe(false);
  });
});

describe("DirectQrError", () => {
  it("carries the status the route answers with", () => {
    const error = new DirectQrError("no_presentation", "nothing to show", 502);
    expect(error.code).toBe("no_presentation");
    expect(error.status).toBe(502);
    expect(error.name).toBe("DirectQrError");
  });
});

/**
 * Seed an order the sweep can pick up. A row without an intent id is released
 * without touching Stripe; a row with one drives the cancel/retrieve branches.
 */
async function seedSweepOrder(options: {
  kind?: "credit_pack" | "subscription";
  status?: "created" | "processing" | "paid";
  ageSeconds?: number;
  paymentIntentId?: string;
}) {
  const { organizationId } = await seedWorkspace();
  const orderId = `order_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO "order"
     (id, organization_id, provider, provider_session_id, kind, plan_id, amount,
      currency, credits, status, createdAt, updatedAt)
     VALUES (?, ?, 'stripe', ?, ?, 'pro', 2900, 'usd', 5000, ?,
             unixepoch() - ?, unixepoch())`,
  )
    .bind(
      orderId,
      organizationId,
      options.paymentIntentId ?? null,
      options.kind ?? "credit_pack",
      options.status ?? "processing",
      options.ageSeconds ?? 0,
    )
    .run();
  return { orderId, organizationId };
}

async function orderStatus(orderId: string) {
  const row = await env.DB.prepare(`SELECT status FROM "order" WHERE id = ?`)
    .bind(orderId)
    .first<{ status: string }>();
  return row?.status;
}

describe("expireStaleDirectQrOrders", () => {
  // The sweep is global, so rows seeded by an earlier case would otherwise be
  // picked up (and counted) by the next one.
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM "order" WHERE kind = 'credit_pack'
       AND status IN ('created', 'processing')`).run();
  });

  it.each(["processing", "unreadable", "fulfillment_error"] as const)(
    "rotates a full batch of %s orders so newer orders can cancel or recover",
    async (outcome) => {
      const stuck = new Map<string, { orderId: string; organizationId: string }>();
      for (let index = 0; index < 25; index += 1) {
        const id = `pi_${crypto.randomUUID().replaceAll("-", "")}`;
        stuck.set(id, await seedSweepOrder({ ageSeconds: 7200, paymentIntentId: id }));
      }
      const cancelId = `pi_${crypto.randomUUID().replaceAll("-", "")}`;
      const cancelOrder = await seedSweepOrder({ ageSeconds: 3600, paymentIntentId: cancelId });
      const paidId = `pi_${crypto.randomUUID().replaceAll("-", "")}`;
      const paidOrder = await seedSweepOrder({ ageSeconds: 3600, paymentIntentId: paidId });
      let recoverStuck = false;
      const cancel = vi.fn(async (id: string) => {
        if (id === cancelId) return { status: "canceled" };
        throw new Error("Cannot cancel this payment");
      });
      const stripe = {
        paymentIntents: {
          cancel,
          retrieve: async (id: string) => {
            if (id === paidId) {
              return succeededIntent(paidOrder.orderId, paidOrder.organizationId, {}, id);
            }
            const order = stuck.get(id)!;
            if (recoverStuck) {
              return succeededIntent(order.orderId, order.organizationId, {}, id);
            }
            if (outcome === "unreadable") throw new Error("Stripe is unreachable");
            if (outcome === "fulfillment_error") {
              return succeededIntent("missing_order", order.organizationId, {}, id);
            }
            return succeededIntent(
              order.orderId,
              order.organizationId,
              { status: "processing" },
              id,
            );
          },
        },
      };

      await expireStaleDirectQrOrders({ env: configuredEnv(), stripe });
      expect(cancel).toHaveBeenCalledTimes(25);
      expect(cancel).not.toHaveBeenCalledWith(cancelId);
      expect(cancel).not.toHaveBeenCalledWith(paidId);
      const attempted = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM "order"
         WHERE kind = 'credit_pack' AND status = 'processing' AND last_reconcile_attempt_at > 0`,
      ).first<{ count: number }>();
      expect(attempted?.count).toBe(25);

      // The next invocation uses the persisted attempt order, with the same
      // batch limit. Uncertain payments stay eligible instead of being failed.
      const next = await expireStaleDirectQrOrders({ env: configuredEnv(), stripe });
      expect(next).toMatchObject({ canceled: 1, recovered: 1 });
      expect(cancel).toHaveBeenCalledTimes(50);
      expect(await orderStatus(cancelOrder.orderId)).toBe("failed");
      expect(await orderStatus(paidOrder.orderId)).toBe("paid");
      expect(await getBalance(paidOrder.organizationId)).toBe(5000);

      recoverStuck = true;
      expect(await expireStaleDirectQrOrders({ env: configuredEnv(), stripe })).toEqual({
        canceled: 0,
        recovered: 25,
        failed: 0,
      });
      for (const order of stuck.values()) {
        expect(await orderStatus(order.orderId)).toBe("paid");
        expect(await getBalance(order.organizationId)).toBe(5000);
      }
    },
  );

  it.each([
    "requires_action",
    "processing",
    "requires_confirmation",
    "requires_capture",
    "requires_payment_method",
  ] as const)(
    "keeps %s after a failed cancel and reconciles it on a later sweep",
    async (status) => {
      const paymentIntentId = `pi_${crypto.randomUUID().replaceAll("-", "")}`;
      const { orderId, organizationId } = await seedSweepOrder({
        ageSeconds: 7200,
        paymentIntentId,
      });
      let currentStatus: Stripe.PaymentIntent.Status = status;
      let cancellations = 0;
      const stripe = {
        paymentIntents: {
          cancel: async () => {
            cancellations += 1;
            throw new Error("cancel unavailable");
          },
          retrieve: async () =>
            succeededIntent(orderId, organizationId, { status: currentStatus }, paymentIntentId),
        },
      };
      expect(await expireStaleDirectQrOrders({ env: configuredEnv(), stripe })).toEqual({
        canceled: 0,
        recovered: 0,
        failed: 0,
      });
      expect(await orderStatus(orderId)).toBe("processing");

      currentStatus = "succeeded";
      expect(await expireStaleDirectQrOrders({ env: configuredEnv(), stripe })).toEqual({
        canceled: 0,
        recovered: 1,
        failed: 0,
      });
      expect(cancellations).toBe(2);
      expect(await getBalance(organizationId)).toBe(5000);
      expect(await orderStatus(orderId)).toBe("paid");
    },
  );

  it("closes an order whose cancellation is confirmed by the follow-up read", async () => {
    const paymentIntentId = "pi_sweep_already_canceled";
    const { orderId, organizationId } = await seedSweepOrder({ ageSeconds: 7200, paymentIntentId });
    expect(
      await expireStaleDirectQrOrders({
        env: configuredEnv(),
        stripe: {
          paymentIntents: {
            cancel: async () => {
              throw new Error("already canceled");
            },
            retrieve: async () =>
              succeededIntent(orderId, organizationId, { status: "canceled" }, paymentIntentId),
          },
        },
      }),
    ).toEqual({ canceled: 0, recovered: 0, failed: 1 });
    expect(await orderStatus(orderId)).toBe("failed");
    expect(await getBalance(organizationId)).toBe(0);
  });

  it("does nothing when Stripe is not configured", async () => {
    const { orderId } = await seedSweepOrder({ ageSeconds: 7_200 });
    // Cancelling needs the API; without a key the sweep must stay inert rather
    // than throw on every scheduled run.
    await expect(expireStaleDirectQrOrders({ env })).resolves.toEqual({
      canceled: 0,
      recovered: 0,
      failed: 0,
    });
    await expect(orderStatus(orderId)).resolves.toBe("processing");
  });

  it("fails an abandoned order that never received an intent", async () => {
    const { orderId } = await seedSweepOrder({ ageSeconds: 7_200 });
    await expect(
      expireStaleDirectQrOrders({ env: configuredEnv(), staleAfterSeconds: 3_600 }),
    ).resolves.toEqual({ canceled: 0, recovered: 0, failed: 1 });
    await expect(orderStatus(orderId)).resolves.toBe("failed");
  });

  it("leaves recent, paid and subscription orders alone", async () => {
    const { orderId: fresh } = await seedSweepOrder({ ageSeconds: 0 });
    const { orderId: paid } = await seedSweepOrder({ ageSeconds: 7_200, status: "paid" });
    // Subscription checkouts share the table and are reconciled by Stripe.
    const { orderId: subscription } = await seedSweepOrder({
      ageSeconds: 7_200,
      kind: "subscription",
    });

    await expect(
      expireStaleDirectQrOrders({ env: configuredEnv(), staleAfterSeconds: 3_600 }),
    ).resolves.toEqual({ canceled: 0, recovered: 0, failed: 0 });

    await expect(orderStatus(fresh)).resolves.toBe("processing");
    await expect(orderStatus(paid)).resolves.toBe("paid");
    await expect(orderStatus(subscription)).resolves.toBe("processing");
  });

  it("floors the stale window so a mistyped config cannot cancel live codes", async () => {
    const { orderId } = await seedSweepOrder({ ageSeconds: 120 });
    // 60s is below the five-minute floor, so a two-minute-old order survives.
    await expect(
      expireStaleDirectQrOrders({ env: configuredEnv(), staleAfterSeconds: 60 }),
    ).resolves.toEqual({ canceled: 0, recovered: 0, failed: 0 });
    await expect(orderStatus(orderId)).resolves.toBe("processing");
  });

  it("takes the window from configuration when the caller passes none", async () => {
    // Older than the default thirty minutes, but inside the configured hour.
    const { orderId } = await seedSweepOrder({ ageSeconds: 45 * 60 });
    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv({ DIRECT_QR_ORDER_STALE_SECONDS: "3600" }),
      }),
    ).resolves.toEqual({ canceled: 0, recovered: 0, failed: 0 });
    await expect(orderStatus(orderId)).resolves.toBe("processing");
  });

  it("cancels the code and fails the order it released", async () => {
    const { orderId } = await seedSweepOrder({
      ageSeconds: 7_200,
      paymentIntentId: "pi_sweep_cancel",
    });
    const canceled: string[] = [];

    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv(),
        staleAfterSeconds: 3_600,
        stripe: {
          paymentIntents: {
            cancel: (paymentIntentId) => {
              canceled.push(paymentIntentId);
              return Promise.resolve({});
            },
            retrieve: () => Promise.reject(new Error("a cancelled intent needs no re-read")),
          },
        },
      }),
    ).resolves.toEqual({ canceled: 1, recovered: 0, failed: 0 });

    expect(canceled).toEqual(["pi_sweep_cancel"]);
    await expect(orderStatus(orderId)).resolves.toBe("failed");
  });

  it("grants the credits when the sweep finds the code was paid after all", async () => {
    const { orderId, organizationId } = await seedSweepOrder({
      ageSeconds: 7_200,
      paymentIntentId: "pi_sweep_paid",
    });

    // This is the lost-webhook path: the cancel is refused because the money
    // already arrived, and the sweep turns that signal into credits.
    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv(),
        staleAfterSeconds: 3_600,
        stripe: {
          paymentIntents: {
            cancel: () => Promise.reject(new Error("this PaymentIntent has succeeded")),
            retrieve: () =>
              Promise.resolve(succeededIntent(orderId, organizationId, {}, "pi_sweep_paid")),
          },
        },
      }),
    ).resolves.toEqual({ canceled: 0, recovered: 1, failed: 0 });

    expect(await getBalance(organizationId)).toBe(5000);
    await expect(orderStatus(orderId)).resolves.toBe("paid");
  });

  it("keeps an unconfirmable code in the sweep instead of writing it off", async () => {
    const { orderId } = await seedSweepOrder({
      ageSeconds: 7_200,
      paymentIntentId: "pi_sweep_unknown",
    });

    // Both calls fail, so whether the intent is payable is unknown: failing the
    // row here would drop a still-payable code out of every later sweep.
    await expect(
      expireStaleDirectQrOrders({
        env: configuredEnv(),
        staleAfterSeconds: 3_600,
        stripe: {
          paymentIntents: {
            cancel: () => Promise.reject(new Error("network down")),
            retrieve: () => Promise.reject(new Error("network down")),
          },
        },
      }),
    ).resolves.toEqual({ canceled: 0, recovered: 0, failed: 0 });

    await expect(orderStatus(orderId)).resolves.toBe("processing");
  });
});

describe("billing currency", () => {
  it("defaults to USD and is echoed in every catalog row", () => {
    const catalog = getPublicCatalog(env);
    expect(catalog.map((plan) => plan.currency)).toEqual(["usd", "usd", "usd"]);
    // The client formats prices from the row itself, so a plan without a
    // currency would render a bare number.
    expect(getBillingCurrency(env)).toBe("usd");
  });

  it("normalizes the configured currency so prices and intents agree", () => {
    // Stripe and the wallet tables are lowercase; a stray upper-case setting
    // would otherwise silently fall back to "no QR methods".
    const configured = configuredEnv({ DIRECT_QR_CURRENCY: " EUR " });
    expect(getBillingCurrency(configured)).toBe("eur");
    expect(getPublicCatalog(configured).every((plan) => plan.currency === "eur")).toBe(true);
  });

  it("defaults the stale window to half an hour and reads an override", () => {
    expect(getDirectQrStaleSeconds(env)).toBe(30 * 60);
    expect(getDirectQrStaleSeconds(configuredEnv({ DIRECT_QR_ORDER_STALE_SECONDS: "900" }))).toBe(
      900,
    );
    // An unreadable value must not shorten the window to nothing.
    expect(getDirectQrStaleSeconds(configuredEnv({ DIRECT_QR_ORDER_STALE_SECONDS: "soon" }))).toBe(
      30 * 60,
    );
  });
});

describe("formatMoney", () => {
  it("prints the currency the server prices in, not a hard-coded dollar sign", () => {
    expect(formatMoney("en-US", 29, "usd", { trimZeroFraction: true })).toBe("$29");
    // The dialog and the receipt show the same currency this renders.
    expect(formatMoney("en-US", 29, "eur")).toBe("€29.00");
    expect(formatMoney("en-US", 29, "jpy")).toBe("¥29");
  });

  it("keeps the fraction when it carries meaning", () => {
    expect(formatMoney("en-US", 29.5, "usd")).toBe("$29.50");
    // Trimming is opt-out: a marketing page asks for it, a receipt does not.
    expect(formatMoney("en-US", 29.5, "usd", { trimZeroFraction: true })).toBe("$29.50");
  });

  it("falls back to a plain number for a currency Intl rejects", () => {
    // Mid-payment the dialog must not throw on a typo in configuration.
    expect(formatMoney("en-US", 29, "not-a-currency")).toBe("29 NOT-A-CURRENCY");
  });
});
