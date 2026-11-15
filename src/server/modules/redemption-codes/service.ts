import { and, asc, eq } from "drizzle-orm";

import { createDatabase } from "../../db";
import { creditLedger, redemptionCode } from "../../db/schema";
import { readRuntimeNumber } from "../../env";
import { grantCredits } from "../billing/service";

export const REDEMPTION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const REDEMPTION_CODE_LENGTH = 12;
export const DEFAULT_REDEMPTION_CREDITS = 5;
export const DEFAULT_REDEMPTION_VALID_DAYS = 30;
export const DEFAULT_REDEMPTION_DAILY_CREDITS_CAP = 5000;
export const MAX_REDEMPTION_BATCH_SIZE = 100;
export const MAX_REDEMPTION_VALID_DAYS = 365;

export type RedemptionCodeReason =
  | "invalid_code"
  | "not_found"
  | "expired"
  | "revoked"
  | "already_used";

export type RedemptionCodeMessages = {
  en: string;
  "zh-CN": string;
};

export const REDEMPTION_CODE_PATTERN = new RegExp(
  `^RC[${REDEMPTION_CODE_ALPHABET}]{${REDEMPTION_CODE_LENGTH}}$`,
);

const REASON_MESSAGES: Record<RedemptionCodeReason, RedemptionCodeMessages> = {
  invalid_code: {
    en: "Enter a valid redemption code.",
    "zh-CN": "请输入有效的兑换码。",
  },
  not_found: {
    en: "This redemption code does not exist.",
    "zh-CN": "兑换码不存在。",
  },
  expired: {
    en: "This redemption code has expired.",
    "zh-CN": "兑换码已过期。",
  },
  revoked: {
    en: "This redemption code has been revoked.",
    "zh-CN": "兑换码已撤销。",
  },
  already_used: {
    en: "This redemption code has already been used.",
    "zh-CN": "兑换码已使用。",
  },
};

export class RedemptionCodeError extends Error {
  constructor(
    readonly reason: RedemptionCodeReason,
    readonly status: 400 | 404 | 409,
    message = REASON_MESSAGES[reason].en,
  ) {
    super(message);
    this.name = "RedemptionCodeError";
  }

  get messages() {
    return REASON_MESSAGES[this.reason];
  }
}

export class RedemptionCodeDailyCapError extends Error {
  readonly status = 429 as const;
  readonly reason = "daily_cap_reached" as const;
  readonly messages = {
    en: "The daily redemption-code issuance limit has been reached.",
    "zh-CN": "兑换码每日发行额度已用尽。",
  } as const;

  constructor() {
    super("The daily redemption-code issuance limit has been reached.");
    this.name = "RedemptionCodeDailyCapError";
  }
}

export class RedemptionCodeValidationError extends Error {
  readonly status = 400 as const;
  readonly reason = "invalid_request" as const;
  readonly messages = {
    en: "The redemption-code request is invalid.",
    "zh-CN": "兑换码请求无效。",
  } as const;

  constructor(message: string) {
    super(message);
    this.name = "RedemptionCodeValidationError";
  }
}

export class RedemptionCodeIdempotencyConflictError extends Error {
  readonly status = 409 as const;
  readonly reason = "idempotency_conflict" as const;
  readonly messages = {
    en: "The Idempotency-Key was already used with different parameters.",
    "zh-CN": "Idempotency-Key 已用于不同的参数。",
  } as const;

  constructor() {
    super("The Idempotency-Key was already used with different parameters.");
    this.name = "RedemptionCodeIdempotencyConflictError";
  }
}

export type IssueRedemptionCodesParams = {
  env: Env;
  credits?: number;
  count?: number;
  validDays?: number;
  note?: string | null;
  source?: string;
  idempotencyKey?: string | null;
  createdBy?: string | null;
  now?: Date | number;
};

export type IssuedRedemptionCodes = Array<RedemptionCodeView> & {
  idempotencyKey: string;
  requestFingerprint: string;
  credits: number;
  count: number;
  validDays: number;
  codes: Array<RedemptionCodeView>;
};

export type RedemptionCodeView = typeof redemptionCode.$inferSelect & {
  status: "active" | "expired" | "revoked" | "used";
};

function validationMessage(field: string, value: string) {
  return `${field} must be a positive safe integer${value ? ` ${value}` : ""}`;
}

function validatePositiveSafeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RedemptionCodeValidationError(validationMessage(field, ""));
  }
  return value as number;
}

export function normalizeRedemptionCode(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

export function isRedemptionCodeFormat(value: string) {
  return REDEMPTION_CODE_PATTERN.test(value);
}

function assertCodeFormat(value: unknown) {
  const normalized = normalizeRedemptionCode(value);
  if (!isRedemptionCodeFormat(normalized)) {
    throw new RedemptionCodeError("invalid_code", 400);
  }
  return normalized;
}

export function generateRedemptionCode() {
  const bytes = new Uint8Array(REDEMPTION_CODE_LENGTH);
  const limit = 256 - (256 % REDEMPTION_CODE_ALPHABET.length);
  let offset = 0;
  while (offset < bytes.length) {
    const random = new Uint8Array(REDEMPTION_CODE_LENGTH);
    crypto.getRandomValues(random);
    for (const byte of random) {
      if (byte >= limit) continue;
      bytes[offset++] = byte;
      if (offset === bytes.length) break;
    }
  }
  return `RC${Array.from(bytes, (byte) => REDEMPTION_CODE_ALPHABET[byte % REDEMPTION_CODE_ALPHABET.length]).join("")}`;
}

function sqlString(value: string | null | undefined) {
  return value === null || value === undefined ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function asEpochSeconds(value: Date | number | undefined) {
  if (value === undefined) return Math.floor(Date.now() / 1000);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (Number.isFinite(value))
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  throw new RedemptionCodeValidationError("now must be a finite timestamp");
}

function utcDayBounds(now: Date | number) {
  const epoch = asEpochSeconds(now);
  now = new Date(epoch * 1000);
  const day = now.toISOString().slice(0, 10);
  const start = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000);
  return { start, end: start + 86_400 };
}

function requestFingerprint(params: {
  credits: number;
  count: number;
  validDays: number;
  note: string | null;
  source: string;
}) {
  return JSON.stringify({
    count: params.count,
    credits: params.credits,
    note: params.note,
    source: params.source,
    validDays: params.validDays,
  });
}

async function findIdempotentBatch(env: Env, idempotencyKey: string) {
  return createDatabase(env)
    .select()
    .from(redemptionCode)
    .where(eq(redemptionCode.idempotencyKey, idempotencyKey))
    .orderBy(asc(redemptionCode.batchIndex));
}

function formatIssuedBatch(
  rows: Array<typeof redemptionCode.$inferSelect>,
  params: {
    idempotencyKey: string;
    requestFingerprint: string;
    credits: number;
    count: number;
    validDays: number;
  },
): IssuedRedemptionCodes {
  const batch = rows.map((row) => ({
    ...row,
    status: statusForCode(row),
  })) as IssuedRedemptionCodes;
  Object.defineProperties(batch, {
    idempotencyKey: { value: params.idempotencyKey, enumerable: false },
    requestFingerprint: { value: params.requestFingerprint, enumerable: false },
    credits: { value: params.credits, enumerable: false },
    count: { value: params.count, enumerable: false },
    validDays: { value: params.validDays, enumerable: false },
    codes: { value: batch, enumerable: false },
  });
  return batch;
}

async function insertBatch(params: {
  env: Env;
  rows: Array<{
    id: string;
    code: string;
    credits: number;
    expiresAt: number;
    idempotencyKey: string;
    requestFingerprint: string;
    batchIndex: number;
    note: string | null;
    source: string;
    createdBy: string | null;
    createdAt: number;
  }>;
  totalCredits: number;
  dayStart: number;
  dayEnd: number;
  dailyCap: number;
}) {
  const { rows } = params;
  const values = rows
    .map(
      (row) =>
        `(${sqlString(row.id)}, ${sqlString(row.code)}, ${row.credits}, ${row.expiresAt}, NULL, NULL, NULL, NULL, ${sqlString(row.note)}, ${sqlString(row.source)}, ${sqlString(row.idempotencyKey)}, ${sqlString(row.requestFingerprint)}, ${row.batchIndex}, ${sqlString(row.createdBy)}, ${row.createdAt}, ${row.createdAt})`,
    )
    .join(",\n");
  const result = await params.env.DB.prepare(
    `INSERT INTO redemption_code
       (id, code, credits, expires_at, redeemed_by_user_id, redeemed_organization_id,
        redeemed_at, revoked_at, note, source, idempotency_key, request_fingerprint,
        batch_index, created_by, createdAt, updatedAt)
     SELECT column1, column2, column3, column4, column5, column6, column7, column8,
            column9, column10, column11, column12, column13, column14, column15, column16
     FROM (VALUES ${values})
     WHERE (
       SELECT COALESCE(SUM(credits), 0)
       FROM redemption_code
       WHERE createdAt >= ${params.dayStart} AND createdAt < ${params.dayEnd}
     ) + ${params.totalCredits} <= ${params.dailyCap}`,
  ).run();
  return result.meta.changes ?? 0;
}

export async function issueRedemptionCodes(
  params: IssueRedemptionCodesParams,
): Promise<IssuedRedemptionCodes> {
  const credits = params.credits === undefined ? DEFAULT_REDEMPTION_CREDITS : params.credits;
  const count = params.count === undefined ? 1 : params.count;
  const validDays =
    params.validDays === undefined ? DEFAULT_REDEMPTION_VALID_DAYS : params.validDays;
  validatePositiveSafeInteger(credits, "credits");
  validatePositiveSafeInteger(count, "count");
  if (count > MAX_REDEMPTION_BATCH_SIZE) {
    throw new RedemptionCodeValidationError(
      `count must be between 1 and ${MAX_REDEMPTION_BATCH_SIZE}`,
    );
  }
  validatePositiveSafeInteger(validDays, "validDays");
  if (validDays > MAX_REDEMPTION_VALID_DAYS) {
    throw new RedemptionCodeValidationError(
      `validDays must be between 1 and ${MAX_REDEMPTION_VALID_DAYS}`,
    );
  }
  const note =
    params.note === undefined || params.note === null ? null : String(params.note).trim();
  const source = params.source === undefined ? "admin" : String(params.source).trim() || "admin";
  const idempotencyKey =
    params.idempotencyKey === undefined || params.idempotencyKey === null
      ? `issuance:${crypto.randomUUID()}`
      : String(params.idempotencyKey).trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new RedemptionCodeValidationError("idempotencyKey must be between 1 and 128 characters");
  }
  const fingerprint = requestFingerprint({ credits, count, validDays, note, source });
  const existing = await findIdempotentBatch(params.env, idempotencyKey);
  if (existing.length > 0) {
    if (
      existing.length !== count ||
      existing.some((row) => row.requestFingerprint !== fingerprint)
    ) {
      throw new RedemptionCodeIdempotencyConflictError();
    }
    return formatIssuedBatch(existing, {
      idempotencyKey,
      requestFingerprint: fingerprint,
      credits,
      count,
      validDays,
    });
  }

  const now = params.now ?? new Date();
  const createdAt = asEpochSeconds(now);
  const expiresAt = createdAt + validDays * 86_400;
  const { start: dayStart, end: dayEnd } = utcDayBounds(now);
  const dailyCap = Math.floor(
    readRuntimeNumber(
      params.env,
      "REDEMPTION_CODE_DAILY_CREDITS_CAP",
      DEFAULT_REDEMPTION_DAILY_CREDITS_CAP,
    ),
  );
  if (!Number.isSafeInteger(dailyCap) || dailyCap <= 0 || credits * count > dailyCap) {
    throw new RedemptionCodeDailyCapError();
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = Array.from({ length: count }, (_, batchIndex) => ({
      id: crypto.randomUUID(),
      code: generateRedemptionCode(),
      credits,
      expiresAt,
      idempotencyKey,
      requestFingerprint: fingerprint,
      batchIndex,
      note,
      source,
      createdBy: params.createdBy?.trim() || null,
      createdAt,
    }));
    try {
      const changes = await insertBatch({
        env: params.env,
        rows,
        totalCredits: credits * count,
        dayStart,
        dayEnd,
        dailyCap,
      });
      if (changes === count) {
        const inserted = await findIdempotentBatch(params.env, idempotencyKey);
        if (inserted.length !== count) throw new Error("Redemption-code batch was not committed");
        return formatIssuedBatch(inserted, {
          idempotencyKey,
          requestFingerprint: fingerprint,
          credits,
          count,
          validDays,
        });
      }
      const replay = await findIdempotentBatch(params.env, idempotencyKey);
      if (replay.length > 0) {
        if (
          replay.length !== count ||
          replay.some((row) => row.requestFingerprint !== fingerprint)
        ) {
          throw new RedemptionCodeIdempotencyConflictError();
        }
        return formatIssuedBatch(replay, {
          idempotencyKey,
          requestFingerprint: fingerprint,
          credits,
          count,
          validDays,
        });
      }
      throw new RedemptionCodeDailyCapError();
    } catch (error) {
      const replay = await findIdempotentBatch(params.env, idempotencyKey);
      if (replay.length > 0) {
        if (
          replay.length !== count ||
          replay.some((row) => row.requestFingerprint !== fingerprint)
        ) {
          throw new RedemptionCodeIdempotencyConflictError();
        }
        return formatIssuedBatch(replay, {
          idempotencyKey,
          requestFingerprint: fingerprint,
          credits,
          count,
          validDays,
        });
      }
      if (error instanceof RedemptionCodeDailyCapError) throw error;
      if (attempt === 4) throw error;
    }
  }
  throw new Error("Redemption-code issuance failed");
}

function statusForCode(
  row: typeof redemptionCode.$inferSelect,
  now = new Date(),
): RedemptionCodeView["status"] {
  if (row.revokedAt) return "revoked";
  if (row.redeemedAt) return "used";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export async function getRedemptionCode(
  env: Env,
  code: string,
): Promise<RedemptionCodeView | null> {
  const normalized = normalizeRedemptionCode(code);
  if (!isRedemptionCodeFormat(normalized)) return null;
  const [row] = await createDatabase(env)
    .select()
    .from(redemptionCode)
    .where(eq(redemptionCode.code, normalized))
    .limit(1);
  return row ? { ...row, status: statusForCode(row) } : null;
}

export async function validateRedemptionCode(env: Env, code: unknown) {
  const normalized = normalizeRedemptionCode(code);
  if (!isRedemptionCodeFormat(normalized)) {
    return {
      valid: false as const,
      reason: "invalid_code" as const,
      messages: REASON_MESSAGES.invalid_code,
    };
  }
  const row = await getRedemptionCode(env, normalized);
  if (!row) {
    return {
      valid: false as const,
      reason: "not_found" as const,
      messages: REASON_MESSAGES.not_found,
    };
  }
  if (row.status !== "active") {
    const reason = row.status === "used" ? "already_used" : row.status;
    return { valid: false as const, reason, messages: REASON_MESSAGES[reason] };
  }
  return {
    valid: true as const,
    credits: row.credits,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function revokeRedemptionCode(env: Env, code: string) {
  const normalized = assertCodeFormat(code);
  const database = createDatabase(env);
  const [found] = await database
    .select()
    .from(redemptionCode)
    .where(eq(redemptionCode.code, normalized))
    .limit(1);
  if (!found) throw new RedemptionCodeError("not_found", 404);
  if (found.redeemedAt) throw new RedemptionCodeError("already_used", 409);
  if (found.revokedAt) return { ...found, status: "revoked" as const };
  const result = await paramsForRevoke(env, normalized);
  if (result.meta.changes === 0) {
    const latest = await getRedemptionCode(env, normalized);
    if (!latest) throw new RedemptionCodeError("not_found", 404);
    if (latest.redeemedAt) throw new RedemptionCodeError("already_used", 409);
    if (latest.revokedAt) return { ...latest, status: "revoked" as const };
    throw new Error("Redemption-code revoke did not commit");
  }
  const latest = await getRedemptionCode(env, normalized);
  if (!latest) throw new Error("Redemption code disappeared after revoke");
  return latest;
}

function paramsForRevoke(env: Env, normalized: string) {
  return env.DB.prepare(
    `UPDATE redemption_code
     SET revoked_at = unixepoch(), updatedAt = unixepoch()
     WHERE code = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
  )
    .bind(normalized)
    .run();
}

export async function getRedemptionCodeIssuanceStatus(env: Env, now: Date | number = new Date()) {
  const { start, end } = utcDayBounds(now);
  const cap = Math.floor(
    readRuntimeNumber(
      env,
      "REDEMPTION_CODE_DAILY_CREDITS_CAP",
      DEFAULT_REDEMPTION_DAILY_CREDITS_CAP,
    ),
  );
  const result = await env.DB.prepare(
    `SELECT COALESCE(SUM(credits), 0) AS creditsIssued,
            COUNT(*) AS codeCount
     FROM redemption_code
     WHERE createdAt >= ? AND createdAt < ?`,
  )
    .bind(start, end)
    .first<{ creditsIssued: number; codeCount: number }>();
  const creditsIssued = Number(result?.creditsIssued ?? 0);
  const codeCount = Number(result?.codeCount ?? 0);
  return {
    creditsIssued,
    creditsRemaining: Math.max(0, cap - creditsIssued),
    dailyCreditsCap: cap,
    codeCount,
    capReached: creditsIssued >= cap,
  };
}

export async function redeemRedemptionCode(params: {
  env: Env;
  code: unknown;
  userId: string;
  organizationId: string;
}) {
  const normalized = assertCodeFormat(params.code);
  const current = await getRedemptionCode(params.env, normalized);
  if (!current) throw new RedemptionCodeError("not_found", 404);
  if (current.status !== "active") {
    if (
      current.status === "used" &&
      current.redeemedByUserId === params.userId &&
      current.redeemedOrganizationId === params.organizationId
    ) {
      const [existingGrant] = await createDatabase(params.env)
        .select()
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.organizationId, params.organizationId),
            eq(creditLedger.idempotencyKey, `redemption-code:${current.id}`),
            eq(creditLedger.type, "grant"),
          ),
        )
        .limit(1);
      if (existingGrant) {
        const replay = await grantCredits({
          env: params.env,
          organizationId: params.organizationId,
          credits: current.credits,
          idempotencyKey: `redemption-code:${current.id}`,
          description: "Redemption code grant",
          referenceType: "redemption_code",
          referenceId: current.id,
          metadata: JSON.stringify({ codeId: current.id }),
        });
        return {
          credits: current.credits,
          balance: replay.balance,
          ledgerId: replay.ledgerId,
        };
      }
    }
    const reason = current.status === "used" ? "already_used" : current.status;
    throw new RedemptionCodeError(reason, 409);
  }

  const claim = params.env.DB.prepare(
    `UPDATE redemption_code
     SET redeemed_by_user_id = ?, redeemed_organization_id = ?, redeemed_at = unixepoch(), updatedAt = unixepoch()
     WHERE code = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()`,
  ).bind(params.userId, params.organizationId, normalized);

  try {
    const result = await grantCredits({
      env: params.env,
      organizationId: params.organizationId,
      credits: current.credits,
      idempotencyKey: `redemption-code:${current.id}`,
      description: "Redemption code grant",
      referenceType: "redemption_code",
      referenceId: current.id,
      metadata: JSON.stringify({ codeId: current.id }),
      transaction: { before: [claim], allowIdempotentReplay: false },
    });
    return {
      credits: current.credits,
      balance: result.balance,
      ledgerId: result.ledgerId,
    };
  } catch (error) {
    const latest = await getRedemptionCode(params.env, normalized);
    if (latest?.status === "used") throw new RedemptionCodeError("already_used", 409);
    if (latest?.status === "revoked") throw new RedemptionCodeError("revoked", 409);
    if (latest?.status === "expired") throw new RedemptionCodeError("expired", 409);
    throw error;
  }
}

export function redemptionCodeReasonMessages(reason: RedemptionCodeReason) {
  return REASON_MESSAGES[reason];
}

// Stable aliases for callers that use the singular/domain-oriented names.
export const normalizeCode = normalizeRedemptionCode;
export const generateCode = generateRedemptionCode;
export const issueRedemptionCode = async (
  params: IssueRedemptionCodesParams,
): Promise<typeof redemptionCode.$inferSelect> => {
  const [code] = (await issueRedemptionCodes({ ...params, count: 1 })).codes;
  if (!code) throw new Error("Redemption-code issuance did not return a code");
  return code;
};
export const createRedemptionCode = issueRedemptionCode;
export const getRedemptionCodeByCode = getRedemptionCode;
export async function getRedemptionCodeStatus(
  env: Env,
  code: string,
  now: Date | number = new Date(),
) {
  const normalized = normalizeRedemptionCode(code);
  if (!isRedemptionCodeFormat(normalized)) return null;
  const [row] = await createDatabase(env)
    .select()
    .from(redemptionCode)
    .where(eq(redemptionCode.code, normalized))
    .limit(1);
  return row ? { ...row, status: statusForCode(row, new Date(asEpochSeconds(now) * 1000)) } : null;
}
export const previewRedemptionCode = validateRedemptionCode;
export const revokeRedemptionCodeByCode = revokeRedemptionCode;
export const issueCodes = issueRedemptionCodes;
export const getIssuanceStatus = getRedemptionCodeIssuanceStatus;
export { RedemptionCodeError as RedemptionCodeServiceError };
