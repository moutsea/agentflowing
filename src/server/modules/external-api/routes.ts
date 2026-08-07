import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { validateApiKey } from "../api-keys/service";
import { InsufficientCreditsError } from "../billing/service";
import { AttachmentValidationError } from "../files/service";
import { enforceRateLimit } from "../../middleware/rate-limit";
import type { AppContext } from "../../types";
import {
  ExternalAgentNotFoundError,
  ExternalAgentUnavailableError,
  ExternalRunConflictError,
  listExternalAgents,
  runExternalAgent,
} from "./service";

const runSchema = z
  .object({
    message: z.string().trim().min(1).max(50_000),
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    assetIds: z.array(z.string().min(1)).max(6).optional(),
  })
  .strict();

type ApiIdentity = Awaited<ReturnType<typeof validateApiKey>>;

export const externalApiRoutes = new Hono<AppContext>();

async function authorize(context: Context<AppContext>): Promise<ApiIdentity> {
  const authorization = context.req.header("authorization");
  const secret = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const identity = secret ? await validateApiKey(context.env, secret) : null;
  return identity;
}

externalApiRoutes.get("/agents", async (context) => {
  const identity = await authorize(context);
  if (!identity) {
    return context.json({ error: "unauthorized", message: "A valid API key is required" }, 401);
  }
  if (!identity.scopes.includes("agents:read")) {
    return context.json({ error: "forbidden", message: "The agents:read scope is required" }, 403);
  }
  return context.json({
    data: await listExternalAgents(context.env, identity.organizationId, identity.userId),
  });
});

externalApiRoutes.post("/agents/:agentId/run", zValidator("json", runSchema), async (context) => {
  const identity = await authorize(context);
  if (!identity) {
    return context.json({ error: "unauthorized", message: "A valid API key is required" }, 401);
  }
  if (!identity.scopes.includes("agents:run")) {
    return context.json({ error: "forbidden", message: "The agents:run scope is required" }, 403);
  }
  await enforceRateLimit({
    limiter: context.env.AI_RATE_LIMITER,
    key: `api-key:${identity.id}`,
    scope: "external_agent_run",
    requestId: context.var.requestId,
  });
  try {
    const input = context.req.valid("json");
    const result = await runExternalAgent({
      env: context.env,
      organizationId: identity.organizationId,
      userId: identity.userId,
      agentId: context.req.param("agentId"),
      ...input,
    });
    return context.json({ data: result });
  } catch (error) {
    if (error instanceof ExternalAgentNotFoundError) {
      return context.json({ error: "not_found", message: error.message }, 404);
    }
    if (error instanceof ExternalAgentUnavailableError) {
      return context.json({ error: "agent_unavailable", message: error.message }, 409);
    }
    if (error instanceof ExternalRunConflictError) {
      return context.json(
        { error: "idempotency_conflict", message: error.message, status: error.status },
        409,
      );
    }
    if (error instanceof InsufficientCreditsError) {
      return context.json({ error: "insufficient_credits", message: error.message }, 402);
    }
    if (error instanceof AttachmentValidationError) {
      return context.json({ error: error.code, message: error.message }, 400);
    }
    throw error;
  }
});
