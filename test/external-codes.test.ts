import { applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/server";
import { issueCoupon } from "../src/server/modules/coupons/service";

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

const redemptionToken = "redemption-token-for-tests";
const couponToken = "coupon-token-for-tests";

function configuredEnv(overrides: Record<string, unknown> = {}) {
  return new Proxy(env, {
    get(target, property) {
      if (property in overrides) return overrides[property as string];
      if (property === "EXTERNAL_REDEMPTION_CODE_API_TOKEN") return redemptionToken;
      if (property === "EXTERNAL_COUPON_API_TOKEN") return couponToken;
      return Reflect.get(target, property);
    },
  }) as typeof env;
}

async function request(path: string, init: RequestInit = {}, requestEnv = configuredEnv()) {
  return app.fetch(
    new Request(`${env.APP_URL}${path}`, init),
    requestEnv,
    createExecutionContext(),
  );
}

function tokenHeaders(token: string, mode: "bearer" | "header" = "bearer"): Record<string, string> {
  return mode === "bearer" ? { Authorization: `Bearer ${token}` } : { "x-api-token": token };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
});

describe("external code token isolation", () => {
  it("requires configured resource-specific tokens and supports both headers", async () => {
    const missing = await request(
      "/api/external/redemption-codes/issuance-status",
      {},
      configuredEnv({ EXTERNAL_REDEMPTION_CODE_API_TOKEN: "" }),
    );
    expect(missing.status).toBe(503);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    const noToken = await request("/api/external/redemption-codes/issuance-status");
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);

    const wrong = await request("/api/external/redemption-codes/issuance-status", {
      headers: tokenHeaders(couponToken),
    });
    expect(wrong.status).toBe(401);

    const bearer = await request("/api/external/redemption-codes/issuance-status", {
      headers: tokenHeaders(redemptionToken),
    });
    expect(bearer.status).toBe(200);

    const header = await request("/api/external/redemption-codes/issuance-status", {
      headers: tokenHeaders(redemptionToken, "header"),
    });
    expect(header.status).toBe(200);

    const precedence = await request("/api/external/redemption-codes/issuance-status", {
      headers: {
        Authorization: `Bearer ${couponToken}`,
        "x-api-token": redemptionToken,
      },
    });
    expect(precedence.status).toBe(401);
  });

  it("keeps coupon and redemption resources isolated", async () => {
    const couponWithRedemptionToken = await request("/api/external/coupons/CBZZZZZZZZZZ", {
      headers: tokenHeaders(redemptionToken),
    });
    expect(couponWithRedemptionToken.status).toBe(401);

    const redemptionWithCouponToken = await request(
      "/api/external/redemption-codes/issuance-status",
      { headers: tokenHeaders(couponToken, "header") },
    );
    expect(redemptionWithCouponToken.status).toBe(401);

    const createCoupon = await request("/api/external/coupons", {
      method: "POST",
      headers: { ...tokenHeaders(couponToken), "content-type": "application/json" },
      body: JSON.stringify({ rate: 10, count: 1 }),
    });
    expect(createCoupon.status).toBe(404);
  });
});

describe("external redemption-code API", () => {
  it("issues at most 100, replays idempotently, and exposes issuance status", async () => {
    const tooMany = await request("/api/external/redemption-codes", {
      method: "POST",
      headers: {
        ...tokenHeaders(redemptionToken),
        "content-type": "application/json",
        "Idempotency-Key": "too-many",
      },
      body: JSON.stringify({ count: 101 }),
    });
    expect(tooMany.status).toBe(400);

    const first = await request("/api/external/redemption-codes", {
      method: "POST",
      headers: {
        ...tokenHeaders(redemptionToken),
        "content-type": "application/json",
        "Idempotency-Key": "external-issue-1",
      },
      body: JSON.stringify({ count: 2 }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { codes: Array<{ code: string; credits: number }> };
    expect(firstBody.codes).toHaveLength(2);
    expect(firstBody.codes[0]?.credits).toBe(5);
    expect(first.headers.get("cache-control")).toBe("no-store");

    const replay = await request("/api/external/redemption-codes", {
      method: "POST",
      headers: {
        ...tokenHeaders(redemptionToken),
        "content-type": "application/json",
        "Idempotency-Key": "external-issue-1",
      },
      body: JSON.stringify({ count: 2 }),
    });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { codes: unknown[] }).codes).toEqual(firstBody.codes);

    const conflict = await request("/api/external/redemption-codes", {
      method: "POST",
      headers: {
        ...tokenHeaders(redemptionToken),
        "content-type": "application/json",
        "Idempotency-Key": "external-issue-1",
      },
      body: JSON.stringify({ count: 1 }),
    });
    expect(conflict.status).toBe(409);

    const status = await request("/api/external/redemption-codes/issuance-status", {
      headers: tokenHeaders(redemptionToken, "header"),
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ creditsIssued: 10, codeCount: 2 });
  });

  it("queries, revokes, and makes repeated revoke idempotent", async () => {
    const issued = await request("/api/external/redemption-codes", {
      method: "POST",
      headers: {
        ...tokenHeaders(redemptionToken),
        "content-type": "application/json",
        "Idempotency-Key": "external-query-1",
      },
      body: JSON.stringify({}),
    });
    const issuedBody = (await issued.json()) as { codes: Array<{ code: string }> };
    const firstCode = issuedBody.codes[0];
    if (!firstCode) throw new Error("external issuance returned no code");
    const { code } = firstCode;

    const get = await request(`/api/external/redemption-codes/${code.toLowerCase()}`, {
      headers: tokenHeaders(redemptionToken),
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ code, credits: 5, status: "active" });

    const revoke = await request(`/api/external/redemption-codes/${code}`, {
      method: "DELETE",
      headers: { ...tokenHeaders(redemptionToken, "header"), origin: env.APP_URL },
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ code, status: "revoked" });

    const repeat = await request(`/api/external/redemption-codes/${code}`, {
      method: "DELETE",
      headers: { ...tokenHeaders(redemptionToken), origin: env.APP_URL },
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ status: "revoked" });
  });
});

describe("external coupon API", () => {
  it("queries and revokes coupons without exposing a create endpoint", async () => {
    const coupon = await issueCoupon({ env, rate: 20, note: "external test", source: "test" });
    const get = await request(`/api/external/coupons/${coupon.code.toLowerCase()}`, {
      headers: tokenHeaders(couponToken),
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      code: coupon.code,
      rate: 20,
      status: "active",
      reservationStatus: "not_reserved",
      paymentStatus: "not_confirmed",
    });

    const revoke = await request(`/api/external/coupons/${coupon.code}`, {
      method: "DELETE",
      headers: { ...tokenHeaders(couponToken), origin: env.APP_URL },
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ code: coupon.code, status: "revoked" });

    const repeat = await request(`/api/external/coupons/${coupon.code}`, {
      method: "DELETE",
      headers: { ...tokenHeaders(couponToken), origin: env.APP_URL },
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ status: "revoked" });
  });
});
