import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit } from "../../middleware/rate-limit";
import type { AppContext } from "../../types";
import {
  ChatAgentNotFoundError,
  ChatAgentUnavailableError,
  createChat,
  getChat,
  listChats,
} from "./service";

const createChatSchema = z.object({
  agentId: z.string().min(1),
});

export const chatRoutes = new Hono<AppContext>();

chatRoutes.use("*", requireAuth);

chatRoutes.get("/", async (context) => {
  const identity = context.var;
  const items = await listChats(context.env, identity.organization.id, identity.user.id);
  return context.json({ data: items });
});

chatRoutes.get("/:chatId", async (context) => {
  const identity = context.var;
  const item = await getChat(
    context.env,
    identity.organization.id,
    identity.user.id,
    context.req.param("chatId"),
  );
  if (!item) {
    return context.json({ error: "not_found", message: "Chat not found" }, 404);
  }
  return context.json({ data: item });
});

chatRoutes.post("/", zValidator("json", createChatSchema), async (context) => {
  const identity = context.var;
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${identity.organization.id}:${identity.user.id}`,
    scope: "chat_create",
    requestId: identity.requestId,
  });
  const input = context.req.valid("json");
  try {
    const created = await createChat({
      env: context.env,
      organizationId: identity.organization.id,
      userId: identity.user.id,
      agentId: input.agentId,
    });
    return context.json({ data: created }, 201);
  } catch (error) {
    if (error instanceof ChatAgentNotFoundError) {
      return context.json({ error: "not_found", message: error.message }, 404);
    }
    if (error instanceof ChatAgentUnavailableError) {
      return context.json({ error: "agent_unavailable", message: error.message }, 409);
    }
    throw error;
  }
});
