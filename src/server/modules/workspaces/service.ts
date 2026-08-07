import { and, eq, sql } from "drizzle-orm";

import { createDatabase } from "../../db";
import { member, organization } from "../../db/schema";
import { readRuntimeNumber } from "../../env";
import { DEFAULT_AI_MODEL_ID, getAiModelPolicy } from "../../../shared/ai-models";

type WorkspaceMembership = {
  organization: typeof organization.$inferSelect;
  role: string;
};

export function listWorkspaces(env: Env, userId: string) {
  return createDatabase(env)
    .select({ organization, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(
      sql`CASE ${member.role} WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`,
      member.createdAt,
    );
}

export async function getWorkspaceMembership(env: Env, userId: string, organizationId: string) {
  const [workspace] = await createDatabase(env)
    .select({ organization, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1);
  return workspace ?? null;
}

export async function resolveWorkspace(params: {
  env: Env;
  userId: string;
  userName: string;
  activeOrganizationId?: string | null;
}): Promise<WorkspaceMembership> {
  const database = createDatabase(params.env);

  if (params.activeOrganizationId) {
    const active = await getWorkspaceMembership(
      params.env,
      params.userId,
      params.activeOrganizationId,
    );
    if (active) return active;
  }

  const [existing] = await database
    .select({ organization, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, params.userId))
    .orderBy(
      sql`CASE ${member.role} WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`,
      member.createdAt,
    )
    .limit(1);
  if (existing) return existing;

  return createPersonalWorkspace(params);
}

async function createPersonalWorkspace(params: {
  env: Env;
  userId: string;
  userName: string;
}): Promise<WorkspaceMembership> {
  const organizationId = `org_${params.userId}`;
  const memberId = `member_${params.userId}`;
  const agentId = `agent_${params.userId}_research`;
  const freeCredits = Math.max(0, readRuntimeNumber(params.env, "FREE_CREDITS", 100));
  const modelPolicy =
    getAiModelPolicy(params.env.DEFAULT_AI_MODEL) ?? getAiModelPolicy(DEFAULT_AI_MODEL_ID);
  if (!modelPolicy) throw new Error("The default AI model catalog is empty");
  const messageCreditCost = Math.max(
    modelPolicy.minimumCreditCost,
    Math.floor(readRuntimeNumber(params.env, "MESSAGE_CREDIT_COST", modelPolicy.minimumCreditCost)),
  );
  const workspaceName = `${params.userName || "My"}'s workspace`;
  const workspaceSlug = `personal-${params.userId.toLowerCase()}`;

  await params.env.DB.batch([
    params.env.DB.prepare(
      `INSERT OR IGNORE INTO organization (id, name, slug, createdAt, metadata)
       VALUES (?, ?, ?, unixepoch(), ?)`,
    ).bind(organizationId, workspaceName, workspaceSlug, JSON.stringify({ personal: true })),
    params.env.DB.prepare(
      `INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'owner', unixepoch())`,
    ).bind(memberId, organizationId, params.userId),
    params.env.DB.prepare(
      `INSERT OR IGNORE INTO agent
       (id, organization_id, slug, name, description, system_prompt, model,
        credit_cost, status, visibility, created_by, createdAt, updatedAt)
       VALUES (?, ?, 'research-copilot', 'Research Copilot',
        'Researches a market and turns evidence into a launch decision.',
        'You are a rigorous research copilot. Use tools when useful, cite assumptions, and finish with a concrete recommendation.',
        ?, ?, 'live', 'workspace', ?, unixepoch(), unixepoch())`,
    ).bind(agentId, organizationId, modelPolicy.id, messageCreditCost, params.userId),
    params.env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description,
        reference_type, reference_id, created_at)
       VALUES (?, ?, ?, 'grant', 'signup-grant', 'Starter credits',
        'workspace', ?, unixepoch())`,
    ).bind(`ledger_${params.userId}_signup`, organizationId, freeCredits, organizationId),
  ]);

  const database = createDatabase(params.env);
  const [created] = await database
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (!created) throw new Error("Failed to create personal workspace");
  return { organization: created, role: "owner" };
}
