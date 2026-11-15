import { applyD1Migrations, createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function adminEnv(userId: string) {
  return new Proxy(env, {
    get(target, property) {
      if (property === "PLATFORM_ADMIN_USER_IDS") return userId;
      return Reflect.get(target, property);
    },
  }) as typeof env;
}

async function signIn(name = "Admin codes tester") {
  const suffix = crypto.randomUUID();
  const response = await SELF.fetch(`${env.APP_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.APP_URL },
    body: JSON.stringify({
      name,
      email: `admin-codes-${suffix}@example.com`,
      password: "correct-horse-battery-staple",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const session = await app.fetch(
    new Request(`${env.APP_URL}/api/session`, { headers: { cookie } }),
    env,
    createExecutionContext(),
  );
  const body = (await session.json()) as { data: { user: { id: string } } };
  return { cookie, userId: body.data.user.id };
}

async function request(path: string, init: RequestInit, requestEnv = env) {
  return app.fetch(
    new Request(`${env.APP_URL}${path}`, init),
    requestEnv,
    createExecutionContext(),
  );
}

function headers(cookie: string, extra: Record<string, string> = {}) {
  return {
    cookie,
    origin: env.APP_URL,
    ...extra,
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
});

describe("platform admin code management", () => {
  it("returns bilingual authentication errors for the management API", async () => {
    const unauthenticated = await request(
      "/api/admin/redemption-codes/issuance-status",
      { headers: { origin: env.APP_URL } },
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: "unauthorized",
      messages: { en: "Sign in is required", "zh-CN": "请先登录。" },
    });

    const user = await signIn("Non-platform admin");
    const forbidden = await request(
      "/api/admin/redemption-codes/issuance-status",
      { headers: headers(user.cookie) },
      env,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: "forbidden",
      messages: {
        en: "Platform administrator access is required",
        "zh-CN": "仅平台管理员可访问",
      },
    });
  });

  it("rejects a signed-in workspace user without platform-admin membership", async () => {
    const user = await signIn("Workspace owner");
    const response = await request(
      "/api/admin/redemption-codes/issuance-status",
      { headers: headers(user.cookie) },
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("issues, queries, revokes, and replays both code types", async () => {
    const user = await signIn();
    const requestEnv = adminEnv(user.userId);

    const couponFirst = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": "admin-coupon-replay",
        }),
        body: JSON.stringify({ rate: 20, count: 2, validDays: 7, source: "test" }),
      },
      requestEnv,
    );
    expect(couponFirst.status).toBe(201);
    const couponBody = (await couponFirst.json()) as {
      data: { codes: Array<{ code: string }> };
    };
    expect(couponBody.data.codes).toHaveLength(2);

    // Use a fresh environment wrapper to exercise the persisted replay path
    // after the request-local in-flight cache has been released.
    const couponReplay = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": "admin-coupon-replay",
        }),
        body: JSON.stringify({ rate: 20, count: 2, validDays: 7, source: "test" }),
      },
      adminEnv(user.userId),
    );
    expect(couponReplay.status).toBe(201);
    const couponReplayBody = (await couponReplay.json()) as {
      data: { codes: Array<{ code: string }> };
    };
    expect(couponReplayBody.data.codes).toEqual(couponBody.data.codes);

    const couponConflict = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": "admin-coupon-replay",
        }),
        body: JSON.stringify({ rate: 25, count: 2, validDays: 7, source: "test" }),
      },
      adminEnv(user.userId),
    );
    expect(couponConflict.status).toBe(409);
    expect(await couponConflict.json()).toMatchObject({ error: "idempotency_conflict" });
    const couponCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM coupon WHERE created_by = ?",
    )
      .bind(user.userId)
      .first<{ count: number }>();
    expect(couponCount?.count).toBe(2);

    const couponCode = couponBody.data.codes[0]!.code;
    const couponDetails = await request(
      `/api/admin/coupons/${couponCode.toLowerCase()}`,
      { headers: headers(user.cookie) },
      requestEnv,
    );
    expect(couponDetails.status).toBe(200);
    expect(await couponDetails.json()).toMatchObject({
      data: { code: couponCode, status: "active" },
    });
    const couponRevoke = await request(
      `/api/admin/coupons/${couponCode}`,
      { method: "DELETE", headers: headers(user.cookie) },
      requestEnv,
    );
    expect(couponRevoke.status).toBe(200);
    expect(await couponRevoke.json()).toMatchObject({ data: { status: "revoked" } });

    const redemptionFirst = await request(
      "/api/admin/redemption-codes",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": "admin-redemption-replay",
        }),
        body: JSON.stringify({ credits: 7, count: 2, validDays: 30, source: "test" }),
      },
      requestEnv,
    );
    expect(redemptionFirst.status).toBe(201);
    const redemptionBody = (await redemptionFirst.json()) as {
      data: { codes: Array<{ code: string; credits: number }> };
    };
    expect(redemptionBody.data.codes).toHaveLength(2);
    expect(redemptionBody.data.codes[0]?.credits).toBe(7);

    const redemptionReplay = await request(
      "/api/admin/redemption-codes",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": "admin-redemption-replay",
        }),
        body: JSON.stringify({ credits: 7, count: 2, validDays: 30, source: "test" }),
      },
      requestEnv,
    );
    expect(redemptionReplay.status).toBe(201);
    const redemptionReplayBody = (await redemptionReplay.json()) as {
      data: { codes: Array<{ code: string; credits: number }> };
    };
    expect(redemptionReplayBody.data.codes).toEqual(redemptionBody.data.codes);

    const redemptionCode = redemptionBody.data.codes[0]!.code;
    const issuanceStatus = await request(
      "/api/admin/redemption-codes/issuance-status",
      { headers: headers(user.cookie) },
      requestEnv,
    );
    expect(issuanceStatus.status).toBe(200);
    expect(await issuanceStatus.json()).toMatchObject({
      data: { creditsIssued: 14, codeCount: 2 },
    });
    const redemptionRevoke = await request(
      `/api/admin/redemption-codes/${redemptionCode}`,
      { method: "DELETE", headers: headers(user.cookie) },
      requestEnv,
    );
    expect(redemptionRevoke.status).toBe(200);
    expect(await redemptionRevoke.json()).toMatchObject({ data: { status: "revoked" } });
  });

  it("recovers a pending coupon issuance after the coupon rows already committed", async () => {
    const user = await signIn("Coupon crash recovery tester");
    const requestEnv = adminEnv(user.userId);
    const key = "coupon-crash-recovery";
    const original = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": key,
        }),
        body: JSON.stringify({ rate: 20, count: 2, validDays: 7 }),
      },
      requestEnv,
    );
    expect(original.status).toBe(201);
    const originalBody = (await original.json()) as {
      data: { codes: Array<{ code: string }> };
    };
    const firstCoupon = await env.DB.prepare("SELECT createdAt FROM coupon WHERE code = ? LIMIT 1")
      .bind(originalBody.data.codes[0]!.code)
      .first<{ createdAt: number }>();
    expect(firstCoupon?.createdAt).toEqual(expect.any(Number));

    await env.DB.prepare(
      `UPDATE admin_coupon_issuance
          SET status = 'pending', batch = NULL, created_at = ?, updated_at = ?
        WHERE actor_user_id = ? AND idempotency_key = ?`,
    )
      .bind(
        firstCoupon!.createdAt - 10 * 60,
        firstCoupon!.createdAt - 10 * 60,
        user.userId,
        key,
      )
      .run();

    const replay = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": key,
        }),
        body: JSON.stringify({ rate: 20, count: 2, validDays: 7 }),
      },
      adminEnv(user.userId),
    );
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as {
      data: { codes: Array<{ code: string }>; idempotentReplay: boolean };
    };
    expect(replayBody.data.codes).toEqual(originalBody.data.codes);
    expect(replayBody.data.idempotentReplay).toBe(true);

    const couponCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM coupon WHERE created_by = ?",
    )
      .bind(user.userId)
      .first<{ count: number }>();
    expect(couponCount?.count).toBe(2);
    const record = await env.DB.prepare(
      "SELECT status, batch FROM admin_coupon_issuance WHERE actor_user_id = ? AND idempotency_key = ?",
    )
      .bind(user.userId, key)
      .first<{ status: string; batch: string | null }>();
    expect(record).toMatchObject({ status: "completed" });
    expect(record?.batch).toContain(originalBody.data.codes[0]!.code);

    const conflict = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": key,
        }),
        body: JSON.stringify({ rate: 25, count: 2, validDays: 7 }),
      },
      adminEnv(user.userId),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "idempotency_conflict" });
  });

  it("does not recover another key's same-second coupon batch", async () => {
    const user = await signIn("Coupon batch boundary tester");
    const requestEnv = adminEnv(user.userId);
    const pendingKey = "coupon-pending-boundary";
    const otherKey = "coupon-other-boundary";
    const staleAt = Math.floor(Date.now() / 1000) - 120;
    const fingerprint = JSON.stringify({
      rate: 20,
      count: 2,
      validDays: 7,
      note: null,
      source: "admin",
    });
    const pendingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO admin_coupon_issuance
         (id, actor_user_id, idempotency_key, request_fingerprint, status, batch, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    )
      .bind(pendingId, user.userId, pendingKey, fingerprint, staleAt, staleAt)
      .run();

    const other = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": otherKey,
        }),
        body: JSON.stringify({ rate: 20, count: 2, validDays: 7 }),
      },
      requestEnv,
    );
    expect(other.status).toBe(201);
    const otherBody = (await other.json()) as {
      data: { codes: Array<{ code: string }> };
    };
    const otherCodes = otherBody.data.codes.map((row) => row.code);
    const otherFirst = await env.DB.prepare(
      `SELECT createdAt FROM coupon WHERE admin_issuance_id = (
         SELECT id FROM admin_coupon_issuance WHERE actor_user_id = ? AND idempotency_key = ?
       ) ORDER BY id LIMIT 1`,
    )
      .bind(user.userId, otherKey)
      .first<{ createdAt: number }>();
    expect(otherFirst?.createdAt).toEqual(expect.any(Number));
    await env.DB.prepare(
      `UPDATE coupon
          SET createdAt = ?, expires_at = ?, updatedAt = ?
        WHERE admin_issuance_id = (
          SELECT id FROM admin_coupon_issuance WHERE actor_user_id = ? AND idempotency_key = ?
        )`,
    )
      .bind(staleAt, staleAt + 7 * 86_400, staleAt, user.userId, otherKey)
      .run();

    const replay = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": pendingKey,
        }),
        body: JSON.stringify({ rate: 20, count: 2, validDays: 7 }),
      },
      adminEnv(user.userId),
    );
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as {
      data: { codes: Array<{ code: string }>; idempotentReplay: boolean };
    };
    expect(replayBody.data.idempotentReplay).toBe(false);
    expect(replayBody.data.codes.map((row) => row.code)).not.toEqual(
      expect.arrayContaining(otherCodes),
    );
    const couponCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM coupon WHERE created_by = ?",
    )
      .bind(user.userId)
      .first<{ count: number }>();
    expect(couponCount?.count).toBe(4);
    const linked = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM coupon WHERE admin_issuance_id = ?",
    )
      .bind(pendingId)
      .first<{ count: number }>();
    expect(linked?.count).toBe(2);
  });

  it("reclaims an expired pending coupon issuance lease", async () => {
    const user = await signIn("Coupon lease recovery tester");
    const requestEnv = adminEnv(user.userId);
    const key = "coupon-expired-lease";
    const fingerprint = JSON.stringify({
      rate: 15,
      count: 1,
      validDays: 7,
      note: null,
      source: "admin",
    });
    const expiredAt = Math.floor(Date.now() / 1000) - 120;
    await env.DB.prepare(
      `INSERT INTO admin_coupon_issuance
         (id, actor_user_id, idempotency_key, request_fingerprint, status, batch, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    )
      .bind(crypto.randomUUID(), user.userId, key, fingerprint, expiredAt, expiredAt)
      .run();

    const response = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, {
          "content-type": "application/json",
          "Idempotency-Key": key,
        }),
        body: JSON.stringify({ rate: 15, count: 1, validDays: 7 }),
      },
      requestEnv,
    );
    expect(response.status).toBe(201);
    const responseBody = (await response.json()) as {
      data: { codes: Array<{ code: string }> };
    };
    expect(responseBody.data.codes).toHaveLength(1);
    const record = await env.DB.prepare(
      "SELECT status, batch FROM admin_coupon_issuance WHERE actor_user_id = ? AND idempotency_key = ?",
    )
      .bind(user.userId, key)
      .first<{ status: string; batch: string | null }>();
    expect(record?.status).toBe("completed");
    expect(record?.batch).not.toBeNull();
  });

  it("writes audit fields without logging the issued codes", async () => {
    const user = await signIn();
    const requestEnv = adminEnv(user.userId);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await request(
        "/api/admin/redemption-codes",
        {
          method: "POST",
          headers: headers(user.cookie, {
            "content-type": "application/json",
            "Idempotency-Key": "audit-redemption",
          }),
          body: JSON.stringify({ credits: 3, count: 1 }),
        },
        requestEnv,
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { codes: Array<{ code: string }> } };
      const auditLine = consoleSpy.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes('"event":"admin_codes.audit"'));
      expect(auditLine).toBeDefined();
      expect(auditLine).toContain(user.userId);
      expect(auditLine).toContain('"action":"redemption_code.issue"');
      expect(auditLine).toContain('"count":1');
      expect(auditLine).toContain('"requestId"');
      expect(auditLine).not.toContain(body.data.codes[0]!.code);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("returns bilingual API errors and lets admins revoke expired unused coupons", async () => {
    const user = await signIn();
    const requestEnv = adminEnv(user.userId);

    const invalidCode = await request(
      "/api/admin/coupons/bad",
      { headers: headers(user.cookie) },
      requestEnv,
    );
    expect(invalidCode.status).toBe(400);
    expect(await invalidCode.json()).toMatchObject({
      error: "invalid_code",
      messages: { "zh-CN": "优惠券代码格式无效。" },
    });

    const limitSpy = vi.spyOn(env.API_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    try {
      const limited = await request(
        "/api/admin/redemption-codes/issuance-status",
        { headers: headers(user.cookie) },
        requestEnv,
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        error: "rate_limited",
        messages: { "zh-CN": "请求过于频繁，请稍后重试。" },
      });
    } finally {
      limitSpy.mockRestore();
    }

    const issued = await request(
      "/api/admin/coupons",
      {
        method: "POST",
        headers: headers(user.cookie, { "content-type": "application/json" }),
        body: JSON.stringify({ rate: 10, count: 1, validDays: 1 }),
      },
      requestEnv,
    );
    expect(issued.status).toBe(201);
    const issuedBody = (await issued.json()) as { data: { codes: Array<{ code: string }> } };
    const expiredAt = Math.floor(Date.now() / 1000) - 1;
    await env.DB.prepare("UPDATE coupon SET createdAt = ?, expires_at = ? WHERE code = ?")
      .bind(expiredAt - 86_400, expiredAt, issuedBody.data.codes[0]!.code)
      .run();

    const expired = await request(
      `/api/admin/coupons/${issuedBody.data.codes[0]!.code}`,
      { headers: headers(user.cookie) },
      requestEnv,
    );
    expect(expired.status).toBe(200);
    expect(await expired.json()).toMatchObject({ data: { status: "expired" } });
    const revoked = await request(
      `/api/admin/coupons/${issuedBody.data.codes[0]!.code}`,
      { method: "DELETE", headers: headers(user.cookie) },
      requestEnv,
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ data: { status: "revoked" } });
  });
});
