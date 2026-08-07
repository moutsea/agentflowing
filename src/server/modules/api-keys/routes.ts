import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit } from "../../middleware/rate-limit";
import type { AppContext } from "../../types";
import { requireWorkspaceManager } from "../workspaces/permissions";
import { createApiKey, listApiKeys, revokeApiKey } from "./service";

const allowedScopes = ["agents:read", "agents:run", "files:read"] as const;
const createKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(allowedScopes)).min(1).default(["agents:run"]),
});

export const apiKeyRoutes = new Hono<AppContext>();

apiKeyRoutes.use("*", requireAuth);
apiKeyRoutes.use("*", requireWorkspaceManager);

apiKeyRoutes.get("/", async (context) => {
  const items = await listApiKeys(context.env, context.var.organization.id);
  return context.json({ data: items });
});

apiKeyRoutes.post("/", zValidator("json", createKeySchema), async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${context.var.organization.id}:${context.var.user.id}`,
    scope: "api_key_create",
    requestId: context.var.requestId,
  });
  const input = context.req.valid("json");
  const created = await createApiKey({
    env: context.env,
    organizationId: context.var.organization.id,
    userId: context.var.user.id,
    name: input.name,
    scopes: input.scopes,
  });
  return context.json({ data: created }, 201);
});

apiKeyRoutes.delete("/:keyId", async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${context.var.organization.id}:${context.var.user.id}`,
    scope: "api_key_revoke",
    requestId: context.var.requestId,
  });
  const revoked = await revokeApiKey(
    context.env,
    context.var.organization.id,
    context.req.param("keyId"),
  );
  if (!revoked) {
    return context.json({ error: "not_found", message: "API key not found" }, 404);
  }
  return context.body(null, 204);
});
