import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit, RateLimitExceededError } from "../../middleware/rate-limit";
import { requirePlatformAdmin } from "../../middleware/platform-admin";
import { logEvent } from "../../observability";
import type { AppContext } from "../../types";
import type { Coupon } from "../../db/schema";
import {
  CouponServiceError,
  CouponValidationError,
  couponBpsToRate,
  generateCouponCode,
  getCouponView,
  isCouponCodeFormat,
  issueCoupons,
  normalizeCouponCode,
  revokeCoupon,
} from "../coupons/service";
import {
  getRedemptionCode,
  getRedemptionCodeIssuanceStatus,
  isRedemptionCodeFormat,
  issueRedemptionCodes,
  normalizeRedemptionCode,
  RedemptionCodeDailyCapError,
  RedemptionCodeError,
  RedemptionCodeIdempotencyConflictError,
  RedemptionCodeValidationError,
  revokeRedemptionCode,
} from "../redemption-codes/service";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_NOTE_LENGTH = 1000;
const MAX_SOURCE_LENGTH = 128;

const couponIssueSchema = z
  .object({
    rate: z.number().int().min(1).max(50),
    count: z.number().int().min(1).max(100),
    validDays: z.number().int().min(1).max(7).optional(),
    note: z.string().trim().max(MAX_NOTE_LENGTH).nullable().optional(),
    source: z.string().trim().max(MAX_SOURCE_LENGTH).optional(),
  })
  .strict();

const redemptionIssueSchema = z
  .object({
    credits: z.number().int().positive().safe().optional(),
    count: z.number().int().min(1).max(100),
    validDays: z.number().int().min(1).max(365).optional(),
    note: z.string().trim().max(MAX_NOTE_LENGTH).nullable().optional(),
    source: z.string().trim().max(MAX_SOURCE_LENGTH).optional(),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const invalidRequest = {
  error: "invalid_request",
  message: "Check the issuance fields and try again.",
  messages: {
    en: "Check the issuance fields and try again.",
    "zh-CN": "请检查发码参数后重试。",
  },
} as const;

const validateCouponIssue = zValidator("json", couponIssueSchema, (result, context) => {
  if (!result.success) return context.json(invalidRequest, 400, NO_STORE);
});

const validateRedemptionIssue = zValidator("json", redemptionIssueSchema, (result, context) => {
  if (!result.success) return context.json(invalidRequest, 400, NO_STORE);
});

/** Headers are set before auth so 401/403 responses are never cacheable. */
const setAdminHeaders = createMiddleware<AppContext>(async (context, next) => {
  context.header("cache-control", "no-store");
  await next();
});

const protectAdminRequest = createMiddleware<AppContext>(async (context, next) => {
  const origin = context.req.header("origin");
  if (origin && origin !== new URL(context.env.APP_URL).origin) {
    return context.json(
      {
        error: "forbidden",
        message: "Invalid request origin",
        messages: { en: "Invalid request origin", "zh-CN": "请求来源无效。" },
      },
      403,
      NO_STORE,
    );
  }
  await next();
});

const limitAdminRequest = createMiddleware<AppContext>(async (context, next) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `admin-codes:${context.var.user.id}`,
    scope: "admin_codes",
    requestId: context.var.requestId,
  });
  await next();
});

class AdminIdempotencyConflictError extends Error {
  readonly status = 409 as const;
  readonly reason = "idempotency_conflict" as const;
  readonly messages = {
    en: "The Idempotency-Key was already used with different parameters.",
    "zh-CN": "Idempotency-Key 已用于不同的参数。",
  } as const;

  constructor() {
    super("The Idempotency-Key was already used with different parameters.");
    this.name = "AdminIdempotencyConflictError";
  }
}

class AdminIdempotencyRecoveryConflictError extends Error {
  readonly status = 409 as const;
  readonly reason = "idempotency_recovery_conflict" as const;
  readonly messages = {
    en: "The Idempotency-Key matches coupon rows that require manual recovery.",
    "zh-CN": "Idempotency-Key 对应的优惠券批次无法唯一确认，请人工核对。",
  } as const;

  constructor() {
    super("The Idempotency-Key matches coupon rows that require manual recovery.");
    this.name = "AdminIdempotencyRecoveryConflictError";
  }
}

type CouponBatch = Awaited<ReturnType<typeof issueCoupons>>;
type CouponReplay = {
  fingerprint: string;
  promise: Promise<CouponBatch>;
};

type CouponIdempotencyRecord = {
  id: string;
  requestFingerprint: string;
  status: "pending" | "completed";
  batch: string | null;
  createdAt: number;
  updatedAt: number;
};

const COUPON_IDEMPOTENCY_LEASE_SECONDS = 30;

// The D1 row is the source of truth. This map only joins requests that are
// already in flight in one isolate; completed batches are always read from D1.
const couponReplayByDatabase = new WeakMap<object, Map<string, CouponReplay>>();

function couponReplayMap(env: Env) {
  const database = env.DB as unknown as object;
  let map = couponReplayByDatabase.get(database);
  if (!map) {
    map = new Map();
    couponReplayByDatabase.set(database, map);
  }
  return map;
}

function issueFingerprint(input: Record<string, unknown>) {
  return JSON.stringify({
    rate: input.rate,
    count: input.count,
    validDays: input.validDays ?? null,
    note: typeof input.note === "string" ? input.note.trim() || null : (input.note ?? null),
    source: typeof input.source === "string" ? input.source.trim() || "admin" : "admin",
  });
}

const couponDateFields = [
  "expiresAt",
  "reservedAt",
  "reservationExpiresAt",
  "redeemedAt",
  "revokedAt",
  "createdAt",
  "updatedAt",
] as const;

function serializeCouponBatch(batch: CouponBatch) {
  return JSON.stringify({
    rows: batch.codes,
    rate: batch.rate,
    count: batch.count,
    validDays: batch.validDays,
  });
}

function deserializeCouponBatch(serialized: string): CouponBatch {
  const parsed = JSON.parse(serialized) as {
    rows: Array<Record<string, unknown>>;
    rate: number;
    count: number;
    validDays: number;
  };
  const rows = parsed.rows.map((row) => {
    const restored = { ...row } as Record<string, unknown>;
    for (const field of couponDateFields) {
      const value = restored[field];
      if (value !== null && value !== undefined) {
        const numeric = typeof value === "number" ? value : Number.NaN;
        restored[field] = Number.isFinite(numeric)
          ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
          : new Date(value as string);
      }
    }
    return restored;
  }) as CouponBatch;
  Object.defineProperties(rows, {
    codes: { value: rows, enumerable: false },
    rate: { value: parsed.rate, enumerable: false },
    count: { value: parsed.count, enumerable: false },
    validDays: { value: parsed.validDays, enumerable: false },
  });
  return rows;
}

async function readCouponIdempotency(env: Env, actorUserId: string, key: string) {
  return env.DB.prepare(
    `SELECT id, request_fingerprint AS requestFingerprint, status, batch,
            created_at AS createdAt, updated_at AS updatedAt
       FROM admin_coupon_issuance
      WHERE actor_user_id = ? AND idempotency_key = ?
      LIMIT 1`,
  )
    .bind(actorUserId, key)
    .first<CouponIdempotencyRecord>();
}

async function reserveCouponIdempotency(
  env: Env,
  actorUserId: string,
  key: string,
  fingerprint: string,
) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `INSERT INTO admin_coupon_issuance
       (id, actor_user_id, idempotency_key, request_fingerprint, status, batch, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)
     ON CONFLICT(actor_user_id, idempotency_key) DO NOTHING`,
  )
    .bind(id, actorUserId, key, fingerprint, now, now)
    .run();
  if (result.meta.changes === 1) return { created: true as const, id };
  const existing = await readCouponIdempotency(env, actorUserId, key);
  if (!existing) throw new Error("Coupon idempotency record disappeared");
  return { created: false as const, existing };
}

function recoveredCouponBatch(
  rows: Array<Record<string, unknown>>,
  input: Parameters<typeof issueCoupons>[0],
) {
  const batch = rows as CouponBatch;
  Object.defineProperties(batch, {
    codes: { value: batch, enumerable: false },
    rate: { value: input.rate, enumerable: false },
    count: { value: input.count ?? 1, enumerable: false },
    validDays: { value: input.validDays ?? 7, enumerable: false },
  });
  return batch;
}

async function recoverCouponBatch(
  env: Env,
  actorUserId: string,
  key: string,
  fingerprint: string,
  record: CouponIdempotencyRecord,
  input: Parameters<typeof issueCoupons>[0],
) {
  const rows = await env.DB.prepare(
    `SELECT id, code, discount_rate_bps AS discountRateBps, status,
            expires_at AS expiresAt, reservation_id AS reservationId,
            reserved_by_user_id AS reservedByUserId,
            reserved_organization_id AS reservedOrganizationId,
            reserved_at AS reservedAt,
            reservation_expires_at AS reservationExpiresAt,
            redeemed_by_user_id AS redeemedByUserId,
            redeemed_organization_id AS redeemedOrganizationId,
            redeemed_at AS redeemedAt, revoked_at AS revokedAt,
            note, source, created_by AS createdBy,
            admin_issuance_id AS adminIssuanceId, createdAt, updatedAt
       FROM coupon
      WHERE admin_issuance_id = ?
      ORDER BY id ASC`,
  )
    .bind(record.id)
    .all<Record<string, unknown>>();

  const expectedCount = input.count ?? 1;
  if (rows.results.length > 0 && rows.results.length < expectedCount) {
    throw new AdminIdempotencyRecoveryConflictError();
  }

  if (rows.results.length === 0) {
    return recoverLegacyCouponBatch(env, actorUserId, key, fingerprint, record, input);
  }

  const batch = recoveredCouponBatch(rows.results.slice(0, expectedCount), input);
  const serialized = serializeCouponBatch(batch);
  const completed = await env.DB.prepare(
    `UPDATE admin_coupon_issuance
        SET status = 'completed', batch = ?, updated_at = ?
      WHERE id = ? AND request_fingerprint = ? AND status = 'pending'`,
  )
    .bind(serialized, Math.floor(Date.now() / 1000), record.id, fingerprint)
    .run();
  if (completed.meta.changes === 1) return deserializeCouponBatch(serialized);

  const latest = await readCouponIdempotency(env, actorUserId, key);
  if (latest?.status === "completed" && latest.batch) {
    return deserializeCouponBatch(latest.batch);
  }
  return null;
}

/**
 * Before 0011, a crash could leave coupon rows committed without the durable
 * issuance foreign key. Only a narrow timestamp match is considered here;
 * any non-empty result that is not exactly one complete batch is rejected so
 * an expired lease can never silently create a second batch.
 */
async function recoverLegacyCouponBatch(
  env: Env,
  actorUserId: string,
  key: string,
  fingerprint: string,
  record: CouponIdempotencyRecord,
  input: Parameters<typeof issueCoupons>[0],
) {
  const note = typeof input.note === "string" ? input.note.trim() || null : (input.note ?? null);
  const source = typeof input.source === "string" ? input.source.trim() || "admin" : "admin";
  const expectedCount = input.count ?? 1;
  const validDays = input.validDays ?? 7;
  const notePredicate = note === null ? "note IS NULL" : "note = ?";
  const lowerCreatedAt = record.createdAt - 2;
  const upperCreatedAt = record.createdAt + 2;
  const bindings: unknown[] = [
    actorUserId,
    input.rate * 100,
    source,
    lowerCreatedAt,
    upperCreatedAt,
    validDays * 86_400,
  ];
  if (note !== null) bindings.splice(3, 0, note);
  const rows = await env.DB.prepare(
    `SELECT id, code, discount_rate_bps AS discountRateBps, status,
            expires_at AS expiresAt, reservation_id AS reservationId,
            reserved_by_user_id AS reservedByUserId,
            reserved_organization_id AS reservedOrganizationId,
            reserved_at AS reservedAt,
            reservation_expires_at AS reservationExpiresAt,
            redeemed_by_user_id AS redeemedByUserId,
            redeemed_organization_id AS redeemedOrganizationId,
            redeemed_at AS redeemedAt, revoked_at AS revokedAt,
            note, source, created_by AS createdBy,
            admin_issuance_id AS adminIssuanceId, createdAt, updatedAt
       FROM coupon
      WHERE admin_issuance_id IS NULL
        AND created_by = ?
        AND discount_rate_bps = ?
        AND source = ?
        AND ${notePredicate}
        AND createdAt BETWEEN ? AND ?
        AND expires_at = createdAt + ?
      ORDER BY createdAt ASC, id ASC`,
  )
    .bind(...bindings)
    .all<Record<string, unknown>>();

  // A pending issuance with no durable association and no matching legacy
  // coupon rows cannot be proven to be a replay. Never claim its lease and
  // issue a second batch; leave it pending for manual recovery instead.
  if (rows.results.length === 0) {
    throw new AdminIdempotencyRecoveryConflictError();
  }
  const matchingCouponCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM coupon
      WHERE created_by = ?
        AND discount_rate_bps = ?
        AND source = ?
        AND ${notePredicate}
        AND createdAt BETWEEN ? AND ?
        AND expires_at = createdAt + ?`,
  )
    .bind(...bindings)
    .first<{ count: number }>();
  if (matchingCouponCount?.count !== expectedCount) {
    throw new AdminIdempotencyRecoveryConflictError();
  }

  const issuanceNotePredicate =
    note === null
      ? "json_extract(request_fingerprint, '$.note') IS NULL"
      : "json_extract(request_fingerprint, '$.note') = ?";
  const issuanceBindings: unknown[] = [
    actorUserId,
    lowerCreatedAt,
    upperCreatedAt,
    input.rate,
    expectedCount,
    validDays,
    source,
  ];
  if (note !== null) issuanceBindings.push(note);
  const pendingIssuances = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM admin_coupon_issuance
      WHERE status = 'pending'
        AND json_valid(request_fingerprint)
        AND actor_user_id = ?
        AND created_at BETWEEN ? AND ?
        AND COALESCE(json_extract(request_fingerprint, '$.rate'), 0) = ?
        AND COALESCE(json_extract(request_fingerprint, '$.count'), 1) = ?
        AND COALESCE(json_extract(request_fingerprint, '$.validDays'), 7) = ?
        AND COALESCE(json_extract(request_fingerprint, '$.source'), 'admin') = ?
        AND ${issuanceNotePredicate}`,
  )
    .bind(...issuanceBindings)
    .first<{ count: number }>();
  if (pendingIssuances?.count !== 1) {
    throw new AdminIdempotencyRecoveryConflictError();
  }

  const createdAt = Number(rows.results[0]?.createdAt);
  const isOneTimestampBatch = rows.results.every((row) => Number(row.createdAt) === createdAt);
  if (!isOneTimestampBatch || rows.results.length !== expectedCount) {
    throw new AdminIdempotencyRecoveryConflictError();
  }

  const batch = recoveredCouponBatch(rows.results, input);
  const serialized = serializeCouponBatch(batch);
  const now = Math.floor(Date.now() / 1000);
  const ids = rows.results.map((row) => String(row.id));
  const placeholders = ids.map(() => "?").join(", ");
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE coupon
          SET admin_issuance_id = ?
        WHERE admin_issuance_id IS NULL
          AND id IN (${placeholders})`,
    ).bind(record.id, ...ids),
    env.DB.prepare(
      `UPDATE admin_coupon_issuance
          SET status = 'completed', batch = ?, updated_at = ?
        WHERE id = ? AND request_fingerprint = ? AND status = 'pending'
          AND (SELECT COUNT(*) FROM coupon WHERE admin_issuance_id = ?) = ?`,
    ).bind(serialized, now, record.id, fingerprint, record.id, expectedCount),
  ]);
  const linked = results[0]?.meta.changes ?? 0;
  const completed = results[1]?.meta.changes ?? 0;
  if (linked === expectedCount && completed === 1) {
    return deserializeCouponBatch(serialized);
  }

  const latest = await readCouponIdempotency(env, actorUserId, key);
  if (latest?.status === "completed" && latest.batch) {
    return deserializeCouponBatch(latest.batch);
  }
  return null;
}

async function claimExpiredCouponIdempotency(
  env: Env,
  record: CouponIdempotencyRecord,
  fingerprint: string,
) {
  if (record.updatedAt > Math.floor(Date.now() / 1000) - COUPON_IDEMPOTENCY_LEASE_SECONDS) {
    return false;
  }
  const claimed = await env.DB.prepare(
    `UPDATE admin_coupon_issuance
        SET updated_at = ?
      WHERE id = ? AND request_fingerprint = ? AND status = 'pending' AND updated_at = ?`,
  )
    .bind(Math.floor(Date.now() / 1000), record.id, fingerprint, record.updatedAt)
    .run();
  return claimed.meta.changes === 1;
}

async function waitForCouponReplay(
  env: Env,
  actorUserId: string,
  key: string,
  fingerprint: string,
  input: Parameters<typeof issueCoupons>[0],
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const existing = await readCouponIdempotency(env, actorUserId, key);
    if (!existing) throw new Error("Coupon idempotency record disappeared");
    if (existing.requestFingerprint !== fingerprint) throw new AdminIdempotencyConflictError();
    if (existing.status === "completed" && existing.batch) {
      return deserializeCouponBatch(existing.batch);
    }
    const recovered = await recoverCouponBatch(env, actorUserId, key, fingerprint, existing, input);
    if (recovered) return recovered;
    if (await claimExpiredCouponIdempotency(env, existing, fingerprint)) return "claimed" as const;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new AdminIdempotencyInProgressError();
}

class AdminIdempotencyInProgressError extends Error {
  readonly status = 409 as const;
  readonly reason = "idempotency_in_progress" as const;
  readonly messages = {
    en: "The Idempotency-Key is still being processed. Retry shortly.",
    "zh-CN": "Idempotency-Key 仍在处理中，请稍后重试。",
  } as const;

  constructor() {
    super("The Idempotency-Key is still being processed. Retry shortly.");
    this.name = "AdminIdempotencyInProgressError";
  }
}

async function issueCouponsWithIssuance(
  env: Env,
  issuanceId: string,
  input: Parameters<typeof issueCoupons>[0],
) {
  const count = input.count ?? 1;
  const validDays = input.validDays ?? 7;
  const source = input.source?.trim() || "admin";
  const note = input.note?.trim() || null;
  const createdBy = input.createdBy?.trim() || null;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + validDays * 86_400;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rows = Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      code: generateCouponCode(),
      discountRateBps: input.rate * 100,
      status: "active" as const,
      expiresAt: new Date(expiresAt * 1000),
      reservationId: null,
      reservedByUserId: null,
      reservedOrganizationId: null,
      reservedAt: null,
      reservationExpiresAt: null,
      redeemedByUserId: null,
      redeemedOrganizationId: null,
      redeemedAt: null,
      revokedAt: null,
      note,
      source,
      createdBy,
      adminIssuanceId: issuanceId,
      createdAt: new Date(now * 1000),
      updatedAt: new Date(now * 1000),
    }));
    const batch = recoveredCouponBatch(rows, input);
    batch.codes.sort((left, right) => left.id.localeCompare(right.id));
    const serialized = serializeCouponBatch(batch);
    const statements = rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO coupon
         (id, code, discount_rate_bps, status, expires_at, note, source, created_by,
          admin_issuance_id, createdAt, updatedAt)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM admin_coupon_issuance
             WHERE id = ? AND status = 'pending'
          )`,
      ).bind(
        row.id,
        row.code,
        row.discountRateBps,
        row.status,
        expiresAt,
        row.note,
        row.source,
        row.createdBy,
        issuanceId,
        now,
        now,
        issuanceId,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE admin_coupon_issuance
            SET status = 'completed', batch = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      ).bind(serialized, now, issuanceId),
    );
    try {
      const results = await env.DB.batch(statements);
      const completion = results.at(-1);
      if (completion?.meta.changes !== 1) {
        const latest = await env.DB.prepare(
          `SELECT status, batch FROM admin_coupon_issuance WHERE id = ? LIMIT 1`,
        )
          .bind(issuanceId)
          .first<{ status: string; batch: string | null }>();
        if (latest?.status === "completed" && latest.batch) {
          return deserializeCouponBatch(latest.batch);
        }
        throw new Error("Coupon idempotency record was not completed");
      }
      return batch;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  throw new Error("Coupon issuance failed");
}

async function issueReservedCoupons(
  env: Env,
  replayKey: string,
  fingerprint: string,
  reservationId: string,
  input: Parameters<typeof issueCoupons>[0],
  replayed: boolean,
) {
  const map = couponReplayMap(env);
  const promise = (async () => {
    try {
      return await issueCouponsWithIssuance(env, reservationId, input);
    } catch (error) {
      await env.DB.prepare("DELETE FROM admin_coupon_issuance WHERE id = ? AND status = 'pending'")
        .bind(reservationId)
        .run();
      throw error;
    }
  })();
  map.set(replayKey, { fingerprint, promise });
  try {
    return { batch: await promise, replayed };
  } finally {
    const current = map.get(replayKey);
    if (current?.promise === promise) map.delete(replayKey);
  }
}

async function issueCouponsWithReplay(
  env: Env,
  key: string | undefined,
  actorUserId: string,
  input: Parameters<typeof issueCoupons>[0],
) {
  if (!key) return { batch: await issueCoupons(input), replayed: false };
  const replayKey = `${actorUserId}:${key}`;
  const fingerprint = issueFingerprint(input as unknown as Record<string, unknown>);
  const map = couponReplayMap(env);
  const existing = map.get(replayKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new AdminIdempotencyConflictError();
    return { batch: await existing.promise, replayed: true };
  }
  const reservation = await reserveCouponIdempotency(env, actorUserId, key, fingerprint);
  if (!reservation.created) {
    if (reservation.existing.requestFingerprint !== fingerprint) {
      throw new AdminIdempotencyConflictError();
    }
    if (reservation.existing.status === "completed" && reservation.existing.batch) {
      return { batch: deserializeCouponBatch(reservation.existing.batch), replayed: true };
    }
    const replay = await waitForCouponReplay(env, actorUserId, key, fingerprint, input);
    if (replay !== "claimed") return { batch: replay, replayed: true };
    return issueReservedCoupons(env, replayKey, fingerprint, reservation.existing.id, input, false);
  }
  return issueReservedCoupons(env, replayKey, fingerprint, reservation.id, input, false);
}

function iso(value: Date | number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
}

type CouponResponseInput = Coupon | NonNullable<Awaited<ReturnType<typeof getCouponView>>>;

function couponResponse(view: CouponResponseInput | null) {
  if (!view) return null;
  const internalStatus = "internalStatus" in view ? view.internalStatus : view.status;
  const status =
    "usageState" in view
      ? view.status
      : internalStatus === "revoked"
        ? "revoked"
        : internalStatus === "used"
          ? "used"
          : internalStatus === "expired" || view.expiresAt.getTime() <= Date.now()
            ? "expired"
            : "active";
  return {
    id: view.id,
    code: view.code,
    rate: couponBpsToRate(view.discountRateBps),
    discountRateBps: view.discountRateBps,
    status,
    internalStatus,
    usageState:
      "usageState" in view ? view.usageState : status === "used" ? "redeemed" : "available",
    isReservationActive: "isReservationActive" in view ? view.isReservationActive : false,
    expiresAt: iso(view.expiresAt),
    reservationId: view.reservationId,
    reservedByUserId: view.reservedByUserId,
    reservedOrganizationId: view.reservedOrganizationId,
    reservedAt: iso(view.reservedAt),
    reservationExpiresAt: iso(view.reservationExpiresAt),
    redeemedByUserId: view.redeemedByUserId,
    redeemedOrganizationId: view.redeemedOrganizationId,
    redeemedAt: iso(view.redeemedAt),
    revokedAt: iso(view.revokedAt),
    note: view.note,
    source: view.source,
    createdBy: view.createdBy,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

function redemptionResponse(view: Awaited<ReturnType<typeof getRedemptionCode>>) {
  if (!view) return null;
  return {
    id: view.id,
    code: view.code,
    credits: view.credits,
    status: view.status,
    expiresAt: iso(view.expiresAt),
    redeemedByUserId: view.redeemedByUserId,
    redeemedOrganizationId: view.redeemedOrganizationId,
    redeemedAt: iso(view.redeemedAt),
    revokedAt: iso(view.revokedAt),
    note: view.note,
    source: view.source,
    createdBy: view.createdBy,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

function responseWithData<T extends Record<string, unknown>>(data: T) {
  // `data` follows the existing admin API convention. The top-level fields make
  // the small management API convenient for scripts without exposing anything
  // beyond the same sanitized object.
  return { data, ...data };
}

function audit(
  context: Context<AppContext>,
  fields: {
    action: string;
    objectType: string;
    objectId?: string | null;
    count: number;
    parameters: Record<string, unknown>;
    result: string;
  },
) {
  try {
    logEvent("info", "admin_codes.audit", {
      actorUserId: context.var.user?.id ?? "unknown",
      action: fields.action,
      objectType: fields.objectType,
      objectId: fields.objectId ?? null,
      count: fields.count,
      parameters: JSON.stringify(fields.parameters),
      requestId: context.var.requestId,
      result: fields.result,
    });
  } catch {
    // Observability must never turn a committed issuance or revoke into a 500.
  }
}

function errorResponse(context: Context<AppContext>, error: unknown, objectType: string) {
  if (error instanceof RateLimitExceededError) {
    context.header("Retry-After", String(error.retryAfterSeconds));
    return context.json(
      {
        error: "rate_limited",
        message: error.message,
        messages: {
          en: "Too many requests. Try again shortly.",
          "zh-CN": "请求过于频繁，请稍后重试。",
        },
      },
      429,
      NO_STORE,
    );
  }
  if (
    error instanceof CouponServiceError ||
    error instanceof CouponValidationError ||
    error instanceof RedemptionCodeError ||
    error instanceof RedemptionCodeValidationError ||
    error instanceof RedemptionCodeDailyCapError ||
    error instanceof RedemptionCodeIdempotencyConflictError ||
    error instanceof AdminIdempotencyConflictError ||
    error instanceof AdminIdempotencyRecoveryConflictError ||
    error instanceof AdminIdempotencyInProgressError
  ) {
    return context.json(
      {
        error: "reason" in error ? error.reason : "invalid_request",
        reason: "reason" in error ? error.reason : "invalid_request",
        message: error.message,
        messages: "messages" in error ? error.messages : invalidRequest.messages,
      },
      error.status as 400 | 404 | 409 | 429,
      NO_STORE,
    );
  }
  audit(context, {
    action: `admin.${objectType}.request`,
    objectType,
    count: 0,
    parameters: { retryable: true },
    result: "error",
  });
  return context.json(
    {
      error: "internal_error",
      message: "The request could not be completed. Try again.",
      messages: {
        en: "The request could not be completed. Try again.",
        "zh-CN": "请求未完成，请重试。",
      },
    },
    500,
    NO_STORE,
  );
}

export const adminCodeRoutes = new Hono<AppContext>();

adminCodeRoutes.use("*", setAdminHeaders);
// Keep this order deliberate: workspace roles never substitute for the
// platform-admin allow-list, and origin/rate checks happen after authorization.
adminCodeRoutes.use("*", requireAuth, requirePlatformAdmin, protectAdminRequest, limitAdminRequest);

adminCodeRoutes.post("/coupons", validateCouponIssue, async (context) => {
  const input = context.req.valid("json");
  const idempotencyKey = context.req.header("idempotency-key")?.trim() || undefined;
  try {
    const issuance = await issueCouponsWithReplay(
      context.env,
      idempotencyKey,
      context.var.user.id,
      {
        env: context.env,
        ...input,
        createdBy: context.var.user.id,
      },
    );
    const issued = issuance.batch;
    const data = {
      codes: issued.codes.map((row) => couponResponse(row)),
      count: issued.count,
      rate: issued.rate,
      validDays: issued.validDays,
      idempotentReplay: issuance.replayed,
    };
    audit(context, {
      action: "coupon.issue",
      objectType: "coupon_batch",
      objectId: issued.codes[0]?.id,
      count: issued.count,
      parameters: {
        rate: input.rate,
        validDays: input.validDays ?? 7,
        count: input.count,
        source: input.source ?? "admin",
        noteLength: input.note?.length ?? 0,
        hasIdempotencyKey: Boolean(idempotencyKey),
      },
      result: issuance.replayed ? "idempotent_replay" : "success",
    });
    return context.json(responseWithData(data), 201, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "coupon");
  }
});

adminCodeRoutes.get("/coupons/:code", async (context) => {
  try {
    const code = normalizeCouponCode(context.req.param("code"));
    if (!isCouponCodeFormat(code)) {
      return context.json(
        {
          error: "invalid_code",
          message: "Coupon code has an invalid format.",
          messages: {
            en: "Coupon code has an invalid format.",
            "zh-CN": "优惠券代码格式无效。",
          },
        },
        400,
        NO_STORE,
      );
    }
    const data = couponResponse(await getCouponView(context.env, code));
    if (!data)
      return context.json(
        {
          error: "not_found",
          message: "Coupon not found.",
          messages: { en: "Coupon not found.", "zh-CN": "优惠券不存在。" },
        },
        404,
        NO_STORE,
      );
    return context.json(responseWithData(data), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "coupon");
  }
});

adminCodeRoutes.delete("/coupons/:code", async (context) => {
  try {
    const data = couponResponse(await revokeCoupon(context.env, context.req.param("code")));
    audit(context, {
      action: "coupon.revoke",
      objectType: "coupon",
      objectId: data?.id,
      count: 1,
      parameters: { codeProvided: true },
      result: data?.status === "revoked" ? "success" : "idempotent_replay",
    });
    return context.json(responseWithData(data!), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "coupon");
  }
});

adminCodeRoutes.post("/redemption-codes", validateRedemptionIssue, async (context) => {
  const input = context.req.valid("json");
  const idempotencyKey =
    context.req.header("idempotency-key")?.trim() || input.idempotencyKey || undefined;
  try {
    const issued = await issueRedemptionCodes({
      env: context.env,
      ...input,
      idempotencyKey,
      createdBy: context.var.user.id,
    });
    const data = {
      codes: issued.codes.map((row) => redemptionResponse({ ...row, status: "active" })),
      count: issued.count,
      credits: issued.credits,
      validDays: issued.validDays,
      idempotencyKey: issued.idempotencyKey,
    };
    audit(context, {
      action: "redemption_code.issue",
      objectType: "redemption_code_batch",
      objectId: issued.codes[0]?.id,
      count: issued.count,
      parameters: {
        credits: input.credits ?? 5,
        validDays: input.validDays ?? 30,
        count: input.count,
        source: input.source ?? "admin",
        noteLength: input.note?.length ?? 0,
        hasIdempotencyKey: Boolean(idempotencyKey),
      },
      result: "success",
    });
    return context.json(responseWithData(data), 201, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.get("/redemption-codes/issuance-status", async (context) => {
  try {
    const data = await getRedemptionCodeIssuanceStatus(context.env);
    return context.json(responseWithData(data), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.get("/redemption-codes/:code", async (context) => {
  try {
    const code = normalizeRedemptionCode(context.req.param("code"));
    if (!isRedemptionCodeFormat(code)) {
      return context.json(
        {
          error: "invalid_code",
          message: "Redemption code has an invalid format.",
          messages: {
            en: "Redemption code has an invalid format.",
            "zh-CN": "兑换码格式无效。",
          },
        },
        400,
        NO_STORE,
      );
    }
    const data = redemptionResponse(await getRedemptionCode(context.env, code));
    if (!data)
      return context.json(
        {
          error: "not_found",
          message: "Redemption code not found.",
          messages: { en: "Redemption code not found.", "zh-CN": "兑换码不存在。" },
        },
        404,
        NO_STORE,
      );
    return context.json(responseWithData(data), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.delete("/redemption-codes/:code", async (context) => {
  try {
    const data = redemptionResponse(
      await revokeRedemptionCode(context.env, context.req.param("code")),
    );
    audit(context, {
      action: "redemption_code.revoke",
      objectType: "redemption_code",
      objectId: data?.id,
      count: 1,
      parameters: { codeProvided: true },
      result: data?.status === "revoked" ? "success" : "idempotent_replay",
    });
    return context.json(responseWithData(data!), 200, NO_STORE);
  } catch (error) {
    return errorResponse(context, error, "redemption_code");
  }
});

adminCodeRoutes.onError((error, context) => errorResponse(context, error, "admin_codes"));

export const adminCodesRoutes = adminCodeRoutes;
