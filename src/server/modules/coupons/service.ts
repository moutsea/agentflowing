import { eq } from "drizzle-orm";

import { createDatabase } from "../../db";
import { coupon, type Coupon } from "../../db/schema";

export const COUPON_CODE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const COUPON_ALPHABET = COUPON_CODE_CHARACTERS;
export const COUPON_CODE_LENGTH = 10;
export const COUPON_CODE_PATTERN = /^CB[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;
export const COUPON_DEFAULT_VALID_DAYS = 7;
export const COUPON_MAX_VALID_DAYS = 7;
export const COUPON_MAX_COUNT = 100;
export const DEFAULT_COUPON_VALID_DAYS = COUPON_DEFAULT_VALID_DAYS;
export const MAX_COUPON_VALID_DAYS = COUPON_MAX_VALID_DAYS;
export const MAX_COUPON_BATCH_SIZE = COUPON_MAX_COUNT;
const SECONDS_PER_DAY = 24 * 60 * 60;

export type CouponExternalStatus = "active" | "used" | "expired" | "revoked";
export type CouponUsageState = "available" | "reserved" | "redeemed";

export type CouponState = {
  status: CouponExternalStatus;
  internalStatus: Coupon["status"];
  usageState: CouponUsageState;
  isAvailable: boolean;
  isReservationActive: boolean;
};

export type CouponServiceErrorCode =
  | "invalid_code"
  | "invalid_rate"
  | "invalid_valid_days"
  | "invalid_count"
  | "not_found"
  | "reserved"
  | "already_used"
  | "revoked"
  | "expired"
  | "conflict";

export type CouponReason =
  | "invalid_code"
  | "not_found"
  | "reserved"
  | "already_used"
  | "revoked"
  | "expired"
  | "conflict";

export type CouponMessages = { en: string; "zh-CN": string };

export const COUPON_REASON_MESSAGES: Record<CouponReason, CouponMessages> = {
  invalid_code: { en: "Enter a valid coupon code.", "zh-CN": "请输入有效的优惠券代码。" },
  not_found: { en: "Coupon not found.", "zh-CN": "优惠券不存在。" },
  reserved: { en: "Coupon is reserved for another payment.", "zh-CN": "优惠券已被其他支付预留。" },
  already_used: { en: "Coupon has already been used.", "zh-CN": "优惠券已使用。" },
  revoked: { en: "Coupon has been revoked.", "zh-CN": "优惠券已撤销。" },
  expired: { en: "Coupon has expired.", "zh-CN": "优惠券已过期。" },
  conflict: { en: "Coupon is temporarily unavailable.", "zh-CN": "优惠券暂时不可用。" },
};

export class CouponServiceError extends Error {
  constructor(
    readonly code: CouponServiceErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CouponServiceError";
  }

  get reason() {
    return this.code;
  }

  get messages() {
    return this.code in COUPON_REASON_MESSAGES
      ? COUPON_REASON_MESSAGES[this.code as CouponReason]
      : { en: this.message, "zh-CN": "优惠券请求无效。" };
  }
}

export class CouponValidationError extends CouponServiceError {
  constructor(
    code: "invalid_code" | "invalid_rate" | "invalid_valid_days" | "invalid_count",
    message: string,
  ) {
    super(code, message, 400);
    this.name = "CouponValidationError";
  }
}

export type CouponIssueInput = {
  env: Env;
  rate: number;
  validDays?: number;
  count?: number;
  code?: string;
  note?: string | null;
  source?: string;
  createdBy?: string | null;
  now?: Date | number;
};

export type IssuedCoupons = Coupon[] & {
  codes: Coupon[];
  rate: number;
  count: number;
  validDays: number;
};

type CouponIssueValues = Omit<CouponIssueInput, "count">;

export type CouponPreviewResult =
  | {
      valid: true;
      rate: number;
      expiresAt: string;
    }
  | {
      valid: false;
      reason: CouponInvalidReason;
      messages: CouponMessages;
    };

export type CouponInvalidReason = CouponReason;

function asEpochSeconds(
  value: Date | number | undefined,
  fallback = Math.floor(Date.now() / 1000),
) {
  if (value === undefined) return fallback;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (Number.isFinite(value)) {
    // Service callers generally pass milliseconds when they pass a number as a
    // Date substitute, while database timestamps are seconds. Accept both.
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  throw new CouponValidationError("invalid_valid_days", "Coupon time must be finite");
}

function epochFromDatabase(value: Date | number | null | undefined) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  return null;
}

export function normalizeCouponCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function isCouponCodeFormat(value: string) {
  return COUPON_CODE_PATTERN.test(value);
}

function assertCouponCode(value: unknown) {
  const normalized = normalizeCouponCode(value);
  if (!isCouponCodeFormat(normalized)) {
    throw new CouponValidationError("invalid_code", "Coupon code has an invalid format");
  }
  return normalized;
}

// Short aliases are useful to callers that handle coupon and redemption-code
// inputs through the same normalization interface.
export const normalizeCode = normalizeCouponCode;

export function validateCouponRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new CouponValidationError("invalid_rate", "Coupon rate must be an integer from 1 to 50");
  }
  return value;
}

export function couponRateToBps(rate: unknown): number {
  return validateCouponRate(rate) * 100;
}

export function couponBpsToRate(discountRateBps: number): number {
  if (
    !Number.isInteger(discountRateBps) ||
    discountRateBps < 100 ||
    discountRateBps > 5000 ||
    discountRateBps % 100 !== 0
  ) {
    throw new CouponValidationError("invalid_rate", "Coupon rate basis points are invalid");
  }
  return discountRateBps / 100;
}

function validateValidDays(value: unknown): number {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > COUPON_MAX_VALID_DAYS)
  ) {
    throw new CouponValidationError(
      "invalid_valid_days",
      `Coupon validity must be a positive integer of at most ${COUPON_MAX_VALID_DAYS} days`,
    );
  }
  return value === undefined ? COUPON_DEFAULT_VALID_DAYS : value;
}

function validateCount(value: unknown): number {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > COUPON_MAX_COUNT)
  ) {
    throw new CouponValidationError(
      "invalid_count",
      `Coupon count must be an integer from 1 to ${COUPON_MAX_COUNT}`,
    );
  }
  return value === undefined ? 1 : value;
}

export function generateCouponCode(): string {
  const bytes = new Uint8Array(COUPON_CODE_LENGTH);
  const limit = 256 - (256 % COUPON_CODE_CHARACTERS.length);
  let offset = 0;
  while (offset < bytes.length) {
    const random = new Uint8Array(COUPON_CODE_LENGTH);
    crypto.getRandomValues(random);
    for (const byte of random) {
      if (byte >= limit) continue;
      bytes[offset++] = byte;
      if (offset === bytes.length) break;
    }
  }
  return `CB${Array.from(bytes, (byte) => COUPON_CODE_CHARACTERS[byte % COUPON_CODE_CHARACTERS.length]).join("")}`;
}

export const generateCode = generateCouponCode;

function issueValues(input: CouponIssueValues, count: number) {
  const rate = validateCouponRate(input.rate);
  const validDays = validateValidDays(input.validDays);
  const now = asEpochSeconds(input.now);
  const expiresAt = now + validDays * SECONDS_PER_DAY;
  const source = input.source?.trim() || "admin";
  const note = input.note?.trim() || null;
  const createdBy = input.createdBy?.trim() || null;
  if (input.code !== undefined && count !== 1) {
    throw new CouponValidationError(
      "invalid_count",
      "A supplied coupon code can only issue one coupon",
    );
  }
  const explicitCode = input.code === undefined ? undefined : assertCouponCode(input.code);
  return Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    code: index === 0 && explicitCode ? explicitCode : generateCouponCode(),
    rate,
    discountRateBps: rate * 100,
    expiresAt,
    note,
    source,
    createdBy,
    createdAt: now,
  }));
}

async function loadByCodes(env: Env, codes: readonly string[]) {
  const database = createDatabase(env);
  return Promise.all(
    codes.map(async (code) => {
      const [row] = await database.select().from(coupon).where(eq(coupon.code, code)).limit(1);
      return row ?? null;
    }),
  );
}

function withBatchMetadata(rows: Coupon[], input: CouponIssueInput, count: number): IssuedCoupons {
  Object.defineProperties(rows, {
    codes: { value: rows, enumerable: false },
    rate: { value: validateCouponRate(input.rate), enumerable: false },
    count: { value: count, enumerable: false },
    validDays: { value: validateValidDays(input.validDays), enumerable: false },
  });
  return rows as IssuedCoupons;
}

/** Issue one or more coupons in one atomic D1 batch. */
export async function issueCoupons(input: CouponIssueInput): Promise<IssuedCoupons> {
  const count = validateCount(input.count);
  // A collision is extraordinarily unlikely, but a bounded retry keeps the
  // unique code constraint from turning a legitimate batch into a transient
  // failure. Every attempt remains all-or-nothing.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const values = issueValues(input, count);
    try {
      await input.env.DB.batch(
        values.map((value) =>
          input.env.DB.prepare(
            `INSERT INTO coupon
             (id, code, discount_rate_bps, status, expires_at, note, source, created_by, createdAt, updatedAt)
             VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
          ).bind(
            value.id,
            value.code,
            value.discountRateBps,
            value.expiresAt,
            value.note,
            value.source,
            value.createdBy,
            value.createdAt,
            value.createdAt,
          ),
        ),
      );
      const rows = await loadByCodes(
        input.env,
        values.map((value) => value.code),
      );
      if (rows.some((row) => row === null))
        throw new Error("Coupon issuance did not commit all rows");
      return withBatchMetadata(rows as Coupon[], input, count);
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  throw new Error("Coupon issuance failed");
}

export async function issueCoupon(input: CouponIssueInput): Promise<Coupon> {
  const [created] = await issueCoupons({ ...input, count: 1 });
  if (!created) throw new Error("Coupon issuance did not return a coupon");
  return created;
}

export async function createCoupon(input: CouponIssueInput): Promise<Coupon> {
  return issueCoupon(input);
}

export const createCoupons = issueCoupons;
export const createCouponBatch = issueCoupons;

export function getCouponState(row: Coupon, now: Date | number = Date.now()): CouponState {
  const nowSeconds = asEpochSeconds(now);
  const expiresAt = epochFromDatabase(row.expiresAt) ?? 0;
  const reservationExpiresAt = epochFromDatabase(row.reservationExpiresAt);
  const isReservationActive =
    row.redeemedAt === null &&
    row.reservationId !== null &&
    reservationExpiresAt !== null &&
    reservationExpiresAt > nowSeconds;
  const isReserved = isReservationActive || row.status === "reserved" || row.reservationId !== null;
  const isRedeemed = row.redeemedAt !== null || row.status === "used";
  const isRevoked = row.revokedAt !== null || row.status === "revoked";
  const isExpired = row.status === "expired" || expiresAt <= nowSeconds;

  if (isRevoked) {
    return {
      status: "revoked",
      internalStatus: row.status,
      usageState: "available",
      isAvailable: false,
      isReservationActive: false,
    };
  }
  if (isRedeemed) {
    return {
      status: "used",
      internalStatus: row.status,
      usageState: "redeemed",
      isAvailable: false,
      isReservationActive: false,
    };
  }
  if (isExpired) {
    return {
      status: "expired",
      internalStatus: row.status,
      usageState: isReserved ? "reserved" : "available",
      isAvailable: false,
      isReservationActive,
    };
  }
  if (isReserved) {
    return {
      status: "used",
      internalStatus: row.status,
      usageState: "reserved",
      isAvailable: false,
      isReservationActive,
    };
  }
  return {
    status: "active",
    internalStatus: row.status,
    usageState: "available",
    isAvailable: true,
    isReservationActive: false,
  };
}

export const determineCouponStatus = getCouponState;

export type CouponView = Omit<Coupon, "status"> & {
  status: CouponExternalStatus;
  internalStatus: Coupon["status"];
  usageState: CouponUsageState;
  isReservationActive: boolean;
};

export async function getCouponByCode(env: Env, value: unknown): Promise<Coupon | null> {
  const code = normalizeCouponCode(value);
  if (!isCouponCodeFormat(code)) return null;
  const [row] = await createDatabase(env)
    .select()
    .from(coupon)
    .where(eq(coupon.code, code))
    .limit(1);
  return row ?? null;
}

export async function getCouponView(
  env: Env,
  value: unknown,
  now: Date | number = Date.now(),
): Promise<CouponView | null> {
  const row = await getCouponByCode(env, value);
  if (!row) return null;
  const state = getCouponState(row, now);
  return { ...row, ...state };
}

export const getCoupon = getCouponView;
export const getCouponDetails = getCouponView;

export async function getCouponStatus(env: Env, value: unknown, now: Date | number = Date.now()) {
  return getCouponView(env, value, now);
}

function invalidPreview(reason: CouponInvalidReason): CouponPreviewResult {
  return { valid: false, reason, messages: COUPON_REASON_MESSAGES[reason] };
}

/** Read-only validation used by the logged-in billing preview route. */
export type CouponPreviewParams = {
  env: Env;
  code: unknown;
  userId: string;
  now?: Date | number;
};

export async function previewCoupon(params: CouponPreviewParams): Promise<CouponPreviewResult> {
  let code: string;
  try {
    code = normalizeCouponCode(params.code);
    if (!isCouponCodeFormat(code)) return invalidPreview("invalid_code");
  } catch {
    return invalidPreview("invalid_code");
  }
  const row = await getCouponByCode(params.env, code);
  if (!row) return invalidPreview("not_found");
  const state = getCouponState(row, params.now ?? Date.now());
  const reservationBelongsToUser =
    state.status === "used" &&
    state.usageState === "reserved" &&
    state.isReservationActive &&
    row.reservedByUserId === params.userId;
  if (!state.isAvailable && !reservationBelongsToUser) {
    const reason: CouponInvalidReason =
      state.status === "used"
        ? state.usageState === "reserved"
          ? "reserved"
          : "already_used"
        : state.status === "active"
          ? "conflict"
          : state.status;
    return invalidPreview(reason);
  }
  return {
    valid: true,
    rate: couponBpsToRate(row.discountRateBps),
    expiresAt: new Date(epochFromDatabase(row.expiresAt)! * 1000).toISOString(),
  };
}

export function validateCoupon(params: CouponPreviewParams): Promise<CouponPreviewResult>;
export function validateCoupon(
  env: Env,
  code: unknown,
  userId?: string,
): Promise<CouponPreviewResult>;
export function validateCoupon(
  envOrParams: Env | CouponPreviewParams,
  code?: unknown,
  userId = "",
): Promise<CouponPreviewResult> {
  if ("env" in envOrParams && "code" in envOrParams) return previewCoupon(envOrParams);
  return previewCoupon({ env: envOrParams, code, userId });
}

export function couponReasonMessages(reason: CouponReason) {
  return COUPON_REASON_MESSAGES[reason];
}

/**
 * Revoke only an active or already expired, unredeemed coupon. The UPDATE is
 * deliberately conditional so a payment confirmation wins or loses the race
 * in D1 rather than relying on a prior read.
 */
export async function revokeCoupon(env: Env, value: unknown, now: Date | number = Date.now()) {
  const code = assertCouponCode(value);
  const nowSeconds = asEpochSeconds(now);
  const updated = await env.DB.prepare(
    `UPDATE coupon
     SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updatedAt = ?
     WHERE code = ?
       AND revoked_at IS NULL
       AND redeemed_at IS NULL
       AND reservation_id IS NULL
       AND status IN ('active', 'expired')`,
  )
    .bind(nowSeconds, nowSeconds, code)
    .run();

  if (updated.meta.changes === 1) {
    const revoked = await getCouponByCode(env, code);
    if (!revoked) throw new Error("Coupon disappeared after revocation");
    return revoked;
  }
  const row = await getCouponByCode(env, code);
  if (!row) throw new CouponServiceError("not_found", "Coupon was not found", 404);
  if (row.revokedAt !== null || row.status === "revoked") return row;
  if (row.redeemedAt !== null || row.status === "used") {
    throw new CouponServiceError("already_used", "Coupon has already been used", 409);
  }
  if (row.status === "reserved" || row.reservationId !== null) {
    throw new CouponServiceError("reserved", "Coupon is reserved for a payment", 409);
  }
  throw new CouponServiceError("conflict", "Coupon state changed during revocation", 409);
}

export const revokeCouponByCode = revokeCoupon;
export { CouponServiceError as CouponError };
