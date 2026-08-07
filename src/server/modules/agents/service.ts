import { and, desc, eq, ne, or } from "drizzle-orm";

import { createDatabase } from "../../db";
import { agent } from "../../db/schema";
import { getAiModelPolicy } from "../../../shared/ai-models";
import { canManageWorkspace } from "../workspaces/permissions";

export type AgentStatus = "draft" | "live" | "archived";
export type AgentVisibility = "private" | "workspace" | "public";

export type AgentCreateInput = {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  creditCost: number;
  status: AgentStatus;
  visibility: AgentVisibility;
};

export type AgentUpdateInput = Partial<AgentCreateInput>;

export class AgentPermissionError extends Error {
  constructor() {
    super("Only workspace owners and admins can manage agents");
    this.name = "AgentPermissionError";
  }
}

export class AgentSlugConflictError extends Error {
  constructor() {
    super("An agent with this slug already exists");
    this.name = "AgentSlugConflictError";
  }
}

export class AgentConfigurationError extends Error {
  constructor(
    readonly code: "unsupported_model" | "credit_cost_too_low",
    message: string,
  ) {
    super(message);
    this.name = "AgentConfigurationError";
  }
}

export function requireAgentModelPolicy(modelId: string, creditCost: number) {
  const policy = getAiModelPolicy(modelId);
  if (!policy) {
    throw new AgentConfigurationError(
      "unsupported_model",
      "Choose a model from the server-authoritative model catalog",
    );
  }
  if (creditCost < policy.minimumCreditCost) {
    throw new AgentConfigurationError(
      "credit_cost_too_low",
      `${policy.name} requires at least ${policy.minimumCreditCost} credits per run`,
    );
  }
  return policy;
}

export function canManageAgents(role: string) {
  return canManageWorkspace(role);
}

function requireAgentManager(role: string) {
  if (!canManageAgents(role)) throw new AgentPermissionError();
}

function agentAccessFilter(userId: string) {
  return or(ne(agent.visibility, "private"), eq(agent.createdBy, userId));
}

export async function listAgents(env: Env, organizationId: string, userId: string) {
  return createDatabase(env)
    .select()
    .from(agent)
    .where(and(eq(agent.organizationId, organizationId), agentAccessFilter(userId)))
    .orderBy(desc(agent.updatedAt));
}

export async function getManagedAgent(env: Env, organizationId: string, agentId: string) {
  const [item] = await createDatabase(env)
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.organizationId, organizationId)))
    .limit(1);
  return item ?? null;
}

export async function getAccessibleAgent(
  env: Env,
  organizationId: string,
  agentId: string,
  userId: string,
) {
  const [item] = await createDatabase(env)
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.id, agentId),
        eq(agent.organizationId, organizationId),
        agentAccessFilter(userId),
      ),
    )
    .limit(1);
  return item ?? null;
}

async function ensureSlugAvailable(params: {
  env: Env;
  organizationId: string;
  slug: string;
  excludeAgentId?: string;
}) {
  const [existing] = await createDatabase(params.env)
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.organizationId, params.organizationId), eq(agent.slug, params.slug)))
    .limit(1);
  if (existing && existing.id !== params.excludeAgentId) throw new AgentSlugConflictError();
}

export async function createAgent(params: {
  env: Env;
  organizationId: string;
  userId: string;
  role: string;
  input: AgentCreateInput;
}) {
  requireAgentManager(params.role);
  requireAgentModelPolicy(params.input.model, params.input.creditCost);
  await ensureSlugAvailable({
    env: params.env,
    organizationId: params.organizationId,
    slug: params.input.slug,
  });
  const [created] = await createDatabase(params.env)
    .insert(agent)
    .values({
      id: `agent_${crypto.randomUUID()}`,
      organizationId: params.organizationId,
      createdBy: params.userId,
      ...params.input,
    })
    .returning();
  if (!created) throw new Error("Failed to create agent");
  return created;
}

export async function updateAgent(params: {
  env: Env;
  organizationId: string;
  agentId: string;
  role: string;
  input: AgentUpdateInput;
}) {
  requireAgentManager(params.role);
  const existing = await getManagedAgent(params.env, params.organizationId, params.agentId);
  if (!existing) return null;
  requireAgentModelPolicy(
    params.input.model ?? existing.model,
    params.input.creditCost ?? existing.creditCost,
  );
  if (params.input.slug) {
    await ensureSlugAvailable({
      env: params.env,
      organizationId: params.organizationId,
      slug: params.input.slug,
      excludeAgentId: params.agentId,
    });
  }
  const [updated] = await createDatabase(params.env)
    .update(agent)
    .set({ ...params.input, updatedAt: new Date() })
    .where(and(eq(agent.id, params.agentId), eq(agent.organizationId, params.organizationId)))
    .returning();
  return updated ?? null;
}

export async function archiveAgent(params: {
  env: Env;
  organizationId: string;
  agentId: string;
  role: string;
}) {
  return updateAgent({ ...params, input: { status: "archived" } });
}
