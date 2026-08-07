import { and, desc, eq } from "drizzle-orm";

import { createDatabase } from "../../db";
import { agentRun, creditAccount, creditLedger } from "../../db/schema";
import { readRuntimeNumber } from "../../env";
import { logEvent } from "../../observability";

export const DEFAULT_STALE_AGENT_RUN_SECONDS = 30 * 60;
export const STALE_AGENT_RUN_BATCH_SIZE = 100;

export class InsufficientCreditsError extends Error {
  constructor() {
    super("Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

export class DuplicateAgentRunError extends Error {
  constructor(readonly status: string) {
    super(`This Agent request was already ${status}`);
    this.name = "DuplicateAgentRunError";
  }
}

type StartRunParams = {
  env: Env;
  organizationId: string;
  agentId: string;
  chatId?: string;
  userId: string;
  idempotencyKey: string;
  credits: number;
  duplicateBehavior?: "return" | "reject";
};

function returnOrRejectDuplicate(
  run: typeof agentRun.$inferSelect,
  behavior: StartRunParams["duplicateBehavior"],
) {
  if (behavior === "reject") throw new DuplicateAgentRunError(run.status);
  return { ...run, duplicate: true as const };
}

export async function startAgentRun(params: StartRunParams) {
  const database = createDatabase(params.env);
  const [existing] = await database
    .select()
    .from(agentRun)
    .where(
      and(
        eq(agentRun.organizationId, params.organizationId),
        eq(agentRun.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) return returnOrRejectDuplicate(existing, params.duplicateBehavior);

  const runId = crypto.randomUUID();
  const ledgerId = crypto.randomUUID();
  const credits = Math.max(1, Math.floor(params.credits));

  try {
    await params.env.DB.batch([
      params.env.DB.prepare(
        `INSERT INTO credit_ledger
         (id, organization_id, delta, type, idempotency_key, description,
          reference_type, reference_id, created_at)
         VALUES (?, ?, ?, 'spend', ?, 'Agent message', 'agent_run', ?, unixepoch())`,
      ).bind(
        ledgerId,
        params.organizationId,
        -credits,
        `run-spend:${params.idempotencyKey}`,
        runId,
      ),
      params.env.DB.prepare(
        `INSERT INTO agent_run
         (id, organization_id, agent_id, chat_id, user_id, idempotency_key,
          status, credits, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, unixepoch())`,
      ).bind(
        runId,
        params.organizationId,
        params.agentId,
        params.chatId ?? null,
        params.userId,
        params.idempotencyKey,
        credits,
      ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("INSUFFICIENT_CREDITS")) {
      throw new InsufficientCreditsError();
    }
    const [duplicate] = await database
      .select()
      .from(agentRun)
      .where(
        and(
          eq(agentRun.organizationId, params.organizationId),
          eq(agentRun.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1);
    if (duplicate) return returnOrRejectDuplicate(duplicate, params.duplicateBehavior);
    throw error;
  }

  const [created] = await database.select().from(agentRun).where(eq(agentRun.id, runId)).limit(1);
  if (!created) throw new Error("Agent run was not created");
  logEvent("info", "agent_run.started", {
    runId,
    organizationId: params.organizationId,
    agentId: params.agentId,
    credits,
  });
  return { ...created, duplicate: false as const };
}

export async function completeAgentRun(params: {
  env: Env;
  runId: string;
  inputTokens?: number;
  outputTokens?: number;
  output?: string;
}) {
  const result = await createDatabase(params.env)
    .update(agentRun)
    .set({
      status: "completed",
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      output: params.output,
      finishedAt: new Date(),
    })
    .where(and(eq(agentRun.id, params.runId), eq(agentRun.status, "running")));
  if (result.meta.changes > 0) {
    logEvent("info", "agent_run.completed", {
      runId: params.runId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    });
  }
}

async function transitionAndRefundAgentRun(params: {
  env: Env;
  runId: string;
  status: "failed" | "canceled";
  error: string;
  description: string;
}) {
  const [, refundResult] = await params.env.DB.batch([
    params.env.DB.prepare(
      `UPDATE agent_run
       SET status = ?, error = ?, finished_at = unixepoch()
       WHERE id = ? AND status = 'running'`,
    ).bind(params.status, params.error.slice(0, 500), params.runId),
    params.env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description,
        reference_type, reference_id, created_at)
       SELECT ?, organization_id, credits, 'refund', ?, ?, 'agent_run', id, unixepoch()
       FROM agent_run
       WHERE id = ? AND status = ?`,
    ).bind(
      crypto.randomUUID(),
      `run-refund:${params.runId}`,
      params.description,
      params.runId,
      params.status,
    ),
  ]);
  if (refundResult && refundResult.meta.changes > 0) {
    logEvent("warn", `agent_run.${params.status}_and_refunded`, {
      runId: params.runId,
    });
  }
  return Boolean(refundResult && refundResult.meta.changes > 0);
}

export function failAndRefundAgentRun(params: { env: Env; runId: string; error: string }) {
  return transitionAndRefundAgentRun({
    ...params,
    status: "failed",
    description: "Agent run failed",
  });
}

export function cancelAndRefundAgentRun(params: { env: Env; runId: string; reason?: string }) {
  return transitionAndRefundAgentRun({
    env: params.env,
    runId: params.runId,
    status: "canceled",
    error: params.reason ?? "Canceled by user",
    description: params.reason ? "Stale Agent run canceled" : "Agent run canceled",
  });
}

export async function reapStaleAgentRuns(params: {
  env: Env;
  staleAfterSeconds?: number;
  limit?: number;
}) {
  const staleAfterSeconds = Math.max(
    5 * 60,
    Math.floor(
      params.staleAfterSeconds ??
        readRuntimeNumber(params.env, "AGENT_RUN_STALE_SECONDS", DEFAULT_STALE_AGENT_RUN_SECONDS),
    ),
  );
  const limit = Math.min(
    STALE_AGENT_RUN_BATCH_SIZE,
    Math.max(1, Math.floor(params.limit ?? STALE_AGENT_RUN_BATCH_SIZE)),
  );
  const candidates = await params.env.DB.prepare(
    `SELECT id FROM agent_run
     WHERE status = 'running' AND started_at <= unixepoch() - ?
     ORDER BY started_at
     LIMIT ?`,
  )
    .bind(staleAfterSeconds, limit)
    .all<{ id: string }>();

  let reaped = 0;
  for (const candidate of candidates.results) {
    if (
      await cancelAndRefundAgentRun({
        env: params.env,
        runId: candidate.id,
        reason: "Canceled after the Agent run recovery timeout",
      })
    ) {
      reaped += 1;
    }
  }
  if (reaped > 0) {
    logEvent("warn", "agent_run.stale_reaped", {
      reaped,
      staleAfterSeconds,
    });
  }
  return { scanned: candidates.results.length, reaped, staleAfterSeconds };
}

export async function getCreditSummary(env: Env, organizationId: string) {
  const database = createDatabase(env);
  const [account] = await database
    .select()
    .from(creditAccount)
    .where(eq(creditAccount.organizationId, organizationId))
    .limit(1);
  const history = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.organizationId, organizationId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(25);
  return { account, history };
}
