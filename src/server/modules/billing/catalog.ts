import { DEFAULT_PLANS } from "../../../shared/config";
import { readRuntimeString } from "../../env";

const stripePriceEnvByPlan = {
  pro: "STRIPE_PRO_PRICE_ID",
  scale: "STRIPE_SCALE_PRICE_ID",
} as const;

export type PlanId = (typeof DEFAULT_PLANS)[number]["id"];
export type PaidPlanId = keyof typeof stripePriceEnvByPlan;

export function getPublicCatalog(env: Env) {
  return DEFAULT_PLANS.map((plan) => ({
    ...plan,
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
