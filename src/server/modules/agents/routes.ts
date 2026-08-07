import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit } from "../../middleware/rate-limit";
import { getAiModelPolicy, isSupportedAiModel } from "../../../shared/ai-models";
import type { AppContext } from "../../types";
import {
  AgentConfigurationError,
  AgentPermissionError,
  AgentSlugConflictError,
  archiveAgent,
  createAgent,
  getAccessibleAgent,
  listAgents,
  updateAgent,
} from "./service";

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens");

const agentFields = {
  slug: slugSchema,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500),
  systemPrompt: z.string().trim().min(10).max(20_000),
  model: z
    .string()
    .trim()
    .min(2)
    .max(160)
    .refine(isSupportedAiModel, "Choose a supported Workers AI model"),
  creditCost: z.number().int().min(1).max(10_000),
  status: z.enum(["draft", "live", "archived"]),
  visibility: z.enum(["private", "workspace", "public"]),
};

export const createAgentSchema = z
  .object(agentFields)
  .strict()
  .superRefine((input, context) => {
    const policy = getAiModelPolicy(input.model);
    if (policy && input.creditCost < policy.minimumCreditCost) {
      context.addIssue({
        code: "custom",
        path: ["creditCost"],
        message: `${policy.name} requires at least ${policy.minimumCreditCost} credits per run`,
      });
    }
  });
export const updateAgentSchema = z
  .object(agentFields)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, "At least one field is required");

export const agentRoutes = new Hono<AppContext>();

agentRoutes.use("*", requireAuth);
agentRoutes.use("*", async (context, next) => {
  if (["POST", "PATCH", "DELETE"].includes(context.req.method)) {
    await enforceRateLimit({
      limiter: context.env.API_RATE_LIMITER,
      key: `${context.var.organization.id}:${context.var.user.id}`,
      scope: "agent_write",
      requestId: context.var.requestId,
    });
  }
  await next();
});

agentRoutes.get("/", async (context) => {
  const items = await listAgents(context.env, context.var.organization.id, context.var.user.id);
  return context.json({ data: items });
});

agentRoutes.get("/:agentId", async (context) => {
  const item = await getAccessibleAgent(
    context.env,
    context.var.organization.id,
    context.req.param("agentId"),
    context.var.user.id,
  );
  if (!item) return context.json({ error: "not_found", message: "Agent not found" }, 404);
  return context.json({ data: item });
});

agentRoutes.post("/", zValidator("json", createAgentSchema), async (context) => {
  try {
    const created = await createAgent({
      env: context.env,
      organizationId: context.var.organization.id,
      userId: context.var.user.id,
      role: context.var.role,
      input: context.req.valid("json"),
    });
    return context.json({ data: created }, 201);
  } catch (error) {
    return handleAgentError(context, error);
  }
});

agentRoutes.patch("/:agentId", zValidator("json", updateAgentSchema), async (context) => {
  try {
    const updated = await updateAgent({
      env: context.env,
      organizationId: context.var.organization.id,
      agentId: context.req.param("agentId"),
      role: context.var.role,
      input: context.req.valid("json"),
    });
    if (!updated) return context.json({ error: "not_found", message: "Agent not found" }, 404);
    return context.json({ data: updated });
  } catch (error) {
    return handleAgentError(context, error);
  }
});

agentRoutes.delete("/:agentId", async (context) => {
  try {
    const archived = await archiveAgent({
      env: context.env,
      organizationId: context.var.organization.id,
      agentId: context.req.param("agentId"),
      role: context.var.role,
    });
    if (!archived) return context.json({ error: "not_found", message: "Agent not found" }, 404);
    return context.json({ data: archived });
  } catch (error) {
    return handleAgentError(context, error);
  }
});

function handleAgentError(context: Context<AppContext>, error: unknown) {
  if (error instanceof AgentConfigurationError) {
    return context.json({ error: error.code, message: error.message }, 400);
  }
  if (error instanceof AgentPermissionError) {
    return context.json({ error: "forbidden", message: error.message }, 403);
  }
  if (error instanceof AgentSlugConflictError) {
    return context.json({ error: "slug_conflict", message: error.message }, 409);
  }
  throw error;
}
