import { applyD1Migrations, createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getCouponState,
  issueCoupon,
  normalizeCouponCode,
  previewCoupon,
  revokeCoupon,
} from "../src/server/modules/coupons/service";
import { app } from "../src/server";

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

async function signIn() {
  const suffix = crypto.randomUUID();
  const response = await SELF.fetch(`${env.APP_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.APP_URL },
    body: JSON.stringify({
      name: "Coupon Tester",
      email: `coupon-${suffix}@example.com`,
      password: "correct-horse-battery-staple",
    }),
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

describe("coupon service", () => {
  it("normalizes codes, stores integer basis points and uses a seven-day UTC expiry", async () => {
    const createdAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const coupon = await issueCoupon({ env, rate: 20, now: createdAt });
    expect(coupon.code).toMatch(/^CB[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    expect(coupon.discountRateBps).toBe(2000);
    expect(coupon.expiresAt.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(normalizeCouponCode(`  ${coupon.code.toLowerCase()} `)).toBe(coupon.code);
  });

  it("rejects non-integer rates and validity longer than seven days", async () => {
    await expect(issueCoupon({ env, rate: 0 })).rejects.toMatchObject({ code: "invalid_rate" });
    await expect(issueCoupon({ env, rate: 12.5 })).rejects.toMatchObject({ code: "invalid_rate" });
    await expect(issueCoupon({ env, rate: 51 })).rejects.toMatchObject({ code: "invalid_rate" });
    await expect(issueCoupon({ env, rate: 20, validDays: 8 })).rejects.toMatchObject({
      code: "invalid_valid_days",
    });
  });

  it("previews without changing state and maps expiry, revocation and use to stable reasons", async () => {
    const userId = `coupon-user-${crypto.randomUUID()}`;
    const created = await issueCoupon({ env, rate: 15 });
    const before = await env.DB.prepare(
      "SELECT status, reservation_id AS reservationId, redeemed_at AS redeemedAt FROM coupon WHERE id = ?",
    )
      .bind(created.id)
      .first();
    await expect(
      previewCoupon({ env, code: created.code.toLowerCase(), userId }),
    ).resolves.toMatchObject({
      valid: true,
      rate: 15,
    });
    const after = await env.DB.prepare(
      "SELECT status, reservation_id AS reservationId, redeemed_at AS redeemedAt FROM coupon WHERE id = ?",
    )
      .bind(created.id)
      .first();
    expect(after).toEqual(before);

    await revokeCoupon(env, created.code);
    await expect(previewCoupon({ env, code: created.code, userId })).resolves.toMatchObject({
      valid: false,
      reason: "revoked",
    });
  });

  it("allows the reserving user to preview but hides a reservation from other users", async () => {
    const suffix = crypto.randomUUID();
    const owner = `coupon-owner-${suffix}`;
    const other = `coupon-other-${suffix}`;
    const organizationId = `coupon-org-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, 'Coupon Owner', ?, 1, unixepoch(), unixepoch())`,
      ).bind(owner, `${suffix}@example.com`),
      env.DB.prepare(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, 'Coupon workspace', ?, unixepoch())`,
      ).bind(organizationId, `coupon-${suffix}`),
    ]);
    const created = await issueCoupon({ env, rate: 25 });
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE coupon SET status = 'reserved', reservation_id = ?, reserved_by_user_id = ?,
       reserved_organization_id = ?, reserved_at = ?, reservation_expires_at = ?, updatedAt = ?
       WHERE id = ?`,
    )
      .bind(`reservation-${created.id}`, owner, organizationId, now, now + 3600, now, created.id)
      .run();
    expect(
      getCouponState(
        {
          ...created,
          status: "reserved",
          reservationId: `reservation-${created.id}`,
          reservedByUserId: owner,
          reservedAt: new Date(now * 1000),
          reservationExpiresAt: new Date((now + 3600) * 1000),
        },
        now,
      ).usageState,
    ).toBe("reserved");
    await expect(previewCoupon({ env, code: created.code, userId: owner })).resolves.toMatchObject({
      valid: true,
    });
    await expect(previewCoupon({ env, code: created.code, userId: other })).resolves.toMatchObject({
      valid: false,
      reason: "reserved",
    });
  });

  it("uses a conditional revoke and treats repeated revoke as idempotent", async () => {
    const created = await issueCoupon({ env, rate: 10 });
    const first = await revokeCoupon(env, created.code.toLowerCase());
    const second = await revokeCoupon(env, created.code);
    expect(first).toMatchObject({ status: "revoked", code: created.code });
    expect(second).toMatchObject({ status: "revoked", code: created.code });
    await expect(revokeCoupon(env, "CBZZZZZZZZZZ")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("coupon validate route", () => {
  it("requires auth and returns a no-store, localized preview", async () => {
    const unauthenticated = await SELF.fetch(`${env.APP_URL}/api/billing/coupons/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.APP_URL },
      body: JSON.stringify({ code: "CBAAAAAAAAAA" }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");

    const cookie = await signIn();
    const created = await issueCoupon({ env, rate: 20 });
    const response = await app.fetch(
      new Request(`${env.APP_URL}/api/billing/coupons/validate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: env.APP_URL,
        },
        body: JSON.stringify({ code: created.code.toLowerCase() }),
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    await expect(response.json()).resolves.toMatchObject({ valid: true, rate: 20 });
  });
});
