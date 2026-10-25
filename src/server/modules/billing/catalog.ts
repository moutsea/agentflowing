import { DEFAULT_PLANS } from "../../../shared/config";
import { DEFAULT_BILLING_CURRENCY } from "../../../shared/direct-qr";
import { readRuntimeNumber, readRuntimeString } from "../../env";

const stripePriceEnvByPlan = {
  pro: "STRIPE_PRO_PRICE_ID",
  scale: "STRIPE_SCALE_PRICE_ID",
} as const;

export type PlanId = (typeof DEFAULT_PLANS)[number]["id"];
export type PaidPlanId = keyof typeof stripePriceEnvByPlan;

/**
 * The currency every price in the catalog is quoted in. Credit packs are
 * charged at the plan's list price in this currency with no conversion, so the
 * price the pricing page shows and the amount Stripe is asked for are the same
 * number. Reading it here (rather than inside the QR module) lets the catalog
 * ship prices and currency in one response, which keeps the page from
 * re-labelling its prices after a second request lands.
 */
export function getBillingCurrency(env: Env): string {
  return readRuntimeString(env, "DIRECT_QR_CURRENCY")?.toLowerCase() || DEFAULT_BILLING_CURRENCY;
}

/** How long a code may sit unpaid before the scheduled sweep cancels it. */
export function getDirectQrStaleSeconds(env: Env): number {
  return readRuntimeNumber(env, "DIRECT_QR_ORDER_STALE_SECONDS", 30 * 60);
}

export function getPublicCatalog(env: Env) {
  const currency = getBillingCurrency(env);
  return DEFAULT_PLANS.map((plan) => ({
    ...plan,
    currency,
    checkoutEnabled:
      plan.id === "free" || Boolean(readRuntimeString(env, stripePriceEnvByPlan[plan.id])),
  }));
}

export function getPaidPlan(env: Env, planId: string) {
  if (!(planId in stripePriceEnvByPlan)) return null;
  const typedPlanId = planId as PaidPlanId;
  const plan = DEFAULT_PLANS.find((item) => item.id === typedPlanId);
  if (!plan) return null;
  const priceId = readRuntimeString(env, stripePriceEnvByPlan[typedPlanId]);
  return priceId ? { ...plan, priceId } : null;
}

export function getPlan(planId: string) {
  return DEFAULT_PLANS.find((item) => item.id === planId) ?? null;
}
