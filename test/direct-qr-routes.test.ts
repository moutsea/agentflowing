import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { DirectQrAvailability } from "../src/shared/direct-qr";

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

/**
 * A real signed-in session, because these routes sit behind `requireAuth`.
 *
 * The workspace row is created lazily by the first authenticated request, so a
 * `member` has to make one call before the role can be downgraded; until then
 * there is no membership to rewrite.
 *
 * No Stripe key or price id is bound in the test environment, which is exactly
 * the unconfigured state these contracts have to describe.
 */
async function signIn(role: "owner" | "member" = "owner") {
  const suffix = crypto.randomUUID();
  const response = await SELF.fetch(`${env.APP_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.APP_URL },
    body: JSON.stringify({
      name: "QR Payer",
      email: `qr-${suffix}@example.com`,
      password: "correct-horse-battery-staple",
    }),
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { user: { id: string } };
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  expect(cookie).not.toBe("");

  if (role === "member") {
    // Materialise the workspace, then drop the role.
    const created = await SELF.fetch(`${env.APP_URL}/api/billing/qr`, {
      headers: { cookie, origin: env.APP_URL },
    });
    expect(created.status).toBe(200);
    const updated = await env.DB.prepare(`UPDATE member SET role = 'member' WHERE userId = ?`)
      .bind(payload.user.id)
      .run();
    expect(updated.meta.changes).toBe(1);
  }

  return { cookie, userId: payload.user.id };
}

function call(path: string, cookie: string, init: RequestInit = {}) {
  return SELF.fetch(`${env.APP_URL}${path}`, {
    ...init,
    headers: {
      cookie,
      origin: env.APP_URL,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

describe("direct QR routes", () => {
  it("requires a session on every route", async () => {
    const responses = await Promise.all([
      SELF.fetch(`${env.APP_URL}/api/billing/qr`),
      SELF.fetch(`${env.APP_URL}/api/billing/qr`, { method: "POST" }),
      SELF.fetch(`${env.APP_URL}/api/billing/qr/pi_abc`),
      SELF.fetch(`${env.APP_URL}/api/billing/qr/pi_abc`, { method: "DELETE" }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
    }
  });

  it("reports availability, and whether the caller may start a payment", async () => {
    const owner = await signIn();
    const response = await call("/api/billing/qr", owner.cookie);
    expect(response.status).toBe(200);
    // Read repeatedly by the pricing page; a cached answer could outlive the
    // wallet being switched off in the dashboard.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as { data: DirectQrAvailability };
    expect(payload.data).toMatchObject({
      canManage: true,
      currency: "usd",
      enabled: false,
      methods: ["wechat_pay", "alipay"],
    });

    const member = await signIn("member");
    const asMember = await call("/api/billing/qr", member.cookie);
    expect(asMember.status).toBe(200);
    await expect(asMember.json()).resolves.toMatchObject({ data: { canManage: false } });
  });

  it("prices the catalog in the currency it charges in", async () => {
    // The pricing page formats from the plan row itself, so the currency has to
    // ride along with the prices instead of arriving on its own request.
    const owner = await signIn();
    const response = await call("/api/billing/catalog", owner.cookie);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: { currency: string }[] };
    expect(payload.data.map((plan) => plan.currency)).toEqual(["usd", "usd", "usd"]);
  });

  it("refuses every payment action for a plain member", async () => {
    const member = await signIn("member");

    const created = await call("/api/billing/qr", member.cookie, {
      method: "POST",
      body: JSON.stringify({ planId: "pro", method: "wechat_pay" }),
    });
    expect(created.status).toBe(403);
    await expect(created.json()).resolves.toMatchObject({ error: "forbidden" });

    // A member must not be able to cancel, or to poll, someone else's payment.
    const canceled = await call("/api/billing/qr/pi_abc", member.cookie, { method: "DELETE" });
    expect(canceled.status).toBe(403);

    const polled = await call("/api/billing/qr/pi_abc", member.cookie);
    expect(polled.status).toBe(403);
  });

  it("validates the plan, the wallet and the price before touching Stripe", async () => {
    const owner = await signIn();

    const freePlan = await call("/api/billing/qr", owner.cookie, {
      method: "POST",
      body: JSON.stringify({ planId: "free", method: "wechat_pay" }),
    });
    expect(freePlan.status).toBe(400);

    // Card is a payment method, but not one that produces a code.
    const cardMethod = await call("/api/billing/qr", owner.cookie, {
      method: "POST",
      body: JSON.stringify({ planId: "pro", method: "card" }),
    });
    expect(cardMethod.status).toBe(400);

    // No price id is bound here, which is the state an operator sees before
    // finishing setup: a bad plan id is a client error, not a server fault.
    const noPrice = await call("/api/billing/qr", owner.cookie, {
      method: "POST",
      body: JSON.stringify({ planId: "pro", method: "wechat_pay" }),
    });
    expect(noPrice.status).toBe(400);
    await expect(noPrice.json()).resolves.toMatchObject({ error: "invalid_plan" });
  });

  it("reports a missing Stripe key as a configuration problem", async () => {
    const owner = await signIn();
    // The intent id is well formed, so this reaches Stripe client creation.
    const polled = await call("/api/billing/qr/pi_abc123", owner.cookie);
    expect(polled.status).toBe(503);
    await expect(polled.json()).resolves.toMatchObject({ error: "billing_not_configured" });

    const canceled = await call("/api/billing/qr/pi_abc123", owner.cookie, { method: "DELETE" });
    expect(canceled.status).toBe(503);
  });

  it("404s for anything that is not a payment intent id", async () => {
    const owner = await signIn();
    for (const id of ["nope", "pi_", "cs_test_abc"]) {
      const polled = await call(`/api/billing/qr/${id}`, owner.cookie);
      expect(polled.status).toBe(404);
      const canceled = await call(`/api/billing/qr/${id}`, owner.cookie, { method: "DELETE" });
      expect(canceled.status).toBe(404);
    }
  });
});
