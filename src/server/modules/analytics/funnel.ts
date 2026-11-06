/**
 * Sign-up funnel, read from the business tables themselves.
 *
 * Nothing is tracked for this: an account, an agent run, an agent, an API key
 * and a paid order are already rows, written by the code that commits them. The
 * funnel can therefore never disagree with billing, needs no beacon a blocker
 * can drop, and covers history from before the dashboard existed. What it cannot
 * do is attribute a sign-up to a traffic channel; that needs an event written at
 * sign-up time.
 *
 * The cohort is the accounts created inside the range, and each step asks "has
 * this account done it by now". An older cohort has had more time, so these
 * numbers are not comparable across periods and the dashboard shows no delta.
 */

import type { AnalyticsFunnel } from "../../../shared/analytics";

type FunnelRow = {
  signups: number | null;
  ranAgent: number | null;
  createdAgent: number | null;
  createdApiKey: number | null;
  paid: number | null;
};

/**
 * The first three steps ask the row's own author column, each backed by an
 * index added for this query (migration `0008`), so a step costs one index
 * probe per account in the range. Going through `member` instead would both
 * cost more (`agent_run` is only indexed per workspace, so a new member of a
 * busy team would read the team's whole run history) and lose history: leaving
 * or being removed from a workspace deletes the member row, but not what the
 * account did there.
 *
 * - Ran an agent: any run, whatever its outcome. A run that could not be paid
 *   for is never inserted, so a failed row is still a real attempt. Runs made
 *   through an API key belong to the key's creator.
 * - Built their own agent: `createPersonalWorkspace` seeds every new workspace
 *   with `agent_<userId>_research`, created by the user, so that one is excluded.
 * - Created an API key: revoked keys count; the step is about the action.
 * - Made a payment: `order` does not record who paid, so a paid order is
 *   credited to the owner of its workspace, and a team purchase is not counted
 *   once per member. That is the one step that still needs `member`. An order
 *   an admin paid for counts for the owner, wherever the owner's sign-up falls.
 *   `paid_at` is set exactly when an order becomes paid and is never cleared.
 *
 * Exported for the test that pins the query plan: at test scale a table scan
 * is as fast as an index probe, so only the plan shows a dropped index.
 */
export const SIGNUP_FUNNEL_SQL = `
  SELECT
    COUNT(*) AS signups,
    SUM(EXISTS (SELECT 1 FROM agent_run r WHERE r.user_id = u.id)) AS ranAgent,
    SUM(EXISTS (
      SELECT 1 FROM agent a
      WHERE a.created_by = u.id AND a.id <> 'agent_' || u.id || '_research'
    )) AS createdAgent,
    SUM(EXISTS (SELECT 1 FROM api_key k WHERE k.created_by = u.id)) AS createdApiKey,
    SUM(EXISTS (
      SELECT 1 FROM member m
      JOIN "order" o ON o.organization_id = m.organizationId
      WHERE m.userId = u.id AND m.role = 'owner' AND o.paid_at IS NOT NULL
    )) AS paid
  FROM user u
  WHERE u.createdAt >= ? AND u.createdAt < ?`;

/**
 * The funnel for accounts created in `[start, end)`, both unix seconds.
 *
 * `user.createdAt` is a drizzle `timestamp`, stored in seconds.
 */
export async function getSignupFunnel(
  env: Env,
  bounds: { start: number; end: number },
): Promise<AnalyticsFunnel> {
  const row = await env.DB.prepare(SIGNUP_FUNNEL_SQL)
    .bind(bounds.start, bounds.end)
    .first<FunnelRow>();
  // `SUM` over zero rows is NULL, not 0.
  return {
    signups: row?.signups ?? 0,
    ranAgent: row?.ranAgent ?? 0,
    createdAgent: row?.createdAgent ?? 0,
    createdApiKey: row?.createdApiKey ?? 0,
    paid: row?.paid ?? 0,
  };
}
