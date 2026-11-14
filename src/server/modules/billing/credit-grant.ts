import { and, eq } from "drizzle-orm";

import { createDatabase } from "../../db";
import { creditAccount, creditLedger } from "../../db/schema";

/**
 * Statements that must be committed with a grant. Statements in `before` are
 * useful for an atomic claim; statements in `after` are useful for marking the
 * payment or recovery record that caused the grant. Every `before` statement
 * must either affect a row or already have a ledger entry for this grant key
 * (the latter is the idempotent replay path).
 */
export type CreditGrantTransaction = {
  before?: readonly D1PreparedStatement[];
  after?: readonly D1PreparedStatement[];
};

export type CreditGrantParams = {
  env: Env;
  organizationId: string;
  credits: number;
  idempotencyKey: string;
  description: string;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: string | null;
  transaction?: CreditGrantTransaction;
};

export type CreditGrantResult = {
  duplicate: boolean;
  ledger: typeof creditLedger.$inferSelect;
  account: typeof creditAccount.$inferSelect;
  ledgerId: string;
  balance: number;
};

function validateGrant(params: CreditGrantParams) {
  if (!params.organizationId.trim()) throw new Error("A grant organization is required");
  if (!params.idempotencyKey.trim()) throw new Error("A grant idempotency key is required");
  if (!params.description.trim()) throw new Error("A grant description is required");
  if (!Number.isSafeInteger(params.credits) || params.credits <= 0) {
    throw new Error("Grant credits must be a positive safe integer");
  }
}

/**
 * Build the only write this module performs for credits. The account is
 * intentionally absent: the D1 `credit_ledger` trigger materializes balance
 * and lifetime totals from this immutable grant entry.
 */
export function createCreditGrantStatement(
  params: CreditGrantParams,
  ledgerId = crypto.randomUUID(),
) {
  validateGrant(params);
  return {
    ledgerId,
    statement: params.env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description,
        reference_type, reference_id, metadata, created_at)
       VALUES (?, ?, ?, 'grant', ?, ?, ?, ?, ?, unixepoch())`,
    ).bind(
      ledgerId,
      params.organizationId,
      params.credits,
      params.idempotencyKey,
      params.description,
      params.referenceType ?? null,
      params.referenceId ?? null,
      params.metadata ?? null,
    ),
  } as const;
}

/**
 * Keep a conditional claim and its grant inside the same D1 batch. SQLite's
 * `changes()` reports the preceding statement's affected-row count; the
 * NOT NULL branch deliberately aborts the batch when a claim lost its race
 * and this grant key has not already been committed. Setting the same account
 * timestamp keeps `changes()` positive so multiple before statements can each
 * be checked without changing application data.
 */
function createBeforeGuardStatement(params: CreditGrantParams): D1PreparedStatement {
  return params.env.DB.prepare(
    `UPDATE credit_account
     SET updated_at = CASE
       WHEN changes() > 0 OR EXISTS (
         SELECT 1 FROM credit_ledger
         WHERE organization_id = ? AND idempotency_key = ?
       ) THEN updated_at
       ELSE NULL
     END
     WHERE organization_id = ?`,
  ).bind(params.organizationId, params.idempotencyKey, params.organizationId);
}

/**
 * Insert one idempotent grant and return the committed ledger/account rows.
 * D1's unique index on `(organization_id, idempotency_key)` is the
 * concurrency boundary. A replay therefore returns the original ledger row
 * and the account state that exists after the committed batch.
 */
export async function grantCredits(params: CreditGrantParams): Promise<CreditGrantResult> {
  const grant = createCreditGrantStatement(params);
  const before = params.transaction?.before ?? [];
  const after = params.transaction?.after ?? [];
  const guardedBefore = before.flatMap((statement) => [
    statement,
    createBeforeGuardStatement(params),
  ]);
  const results = await params.env.DB.batch([...guardedBefore, grant.statement, ...after]);
  const grantResult = results[guardedBefore.length];

  const database = createDatabase(params.env);
  const [ledger] = await database
    .select()
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.organizationId, params.organizationId),
        eq(creditLedger.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);
  if (!ledger) throw new Error("Credit grant was not committed");

  const [account] = await database
    .select()
    .from(creditAccount)
    .where(eq(creditAccount.organizationId, params.organizationId))
    .limit(1);
  if (!account) throw new Error("Credit account was not found after grant");

  return {
    duplicate: (grantResult?.meta.changes ?? 0) === 0,
    ledger,
    account,
    ledgerId: ledger.id,
    balance: account.balance,
  };
}
