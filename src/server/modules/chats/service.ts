import { and, desc, eq } from "drizzle-orm";

import { createDatabase } from "../../db";
import { agent, chat } from "../../db/schema";
import { getAccessibleAgent } from "../agents/service";

export class ChatAgentNotFoundError extends Error {
  constructor() {
    super("Agent not found");
    this.name = "ChatAgentNotFoundError";
  }
}

export class ChatAgentUnavailableError extends Error {
  constructor() {
    super("Publish this agent before starting a conversation");
    this.name = "ChatAgentUnavailableError";
  }
}

export function listChats(env: Env, organizationId: string, userId: string) {
  return createDatabase(env)
    .select({
      id: chat.id,
      title: chat.title,
      status: chat.status,
      updatedAt: chat.updatedAt,
      agentId: agent.id,
      agentName: agent.name,
    })
    .from(chat)
    .innerJoin(agent, eq(agent.id, chat.agentId))
    .where(and(eq(chat.organizationId, organizationId), eq(chat.userId, userId)))
    .orderBy(desc(chat.updatedAt))
    .limit(50);
}

export async function getChat(env: Env, organizationId: string, userId: string, chatId: string) {
  const [item] = await createDatabase(env)
    .select({
      id: chat.id,
      title: chat.title,
      status: chat.status,
      updatedAt: chat.updatedAt,
      agentId: agent.id,
      agentName: agent.name,
      agentDescription: agent.description,
      model: agent.model,
      creditCost: agent.creditCost,
    })
    .from(chat)
    .innerJoin(agent, eq(agent.id, chat.agentId))
    .where(
      and(eq(chat.id, chatId), eq(chat.organizationId, organizationId), eq(chat.userId, userId)),
    )
    .limit(1);
  return item ?? null;
}

export async function createChat(params: {
  env: Env;
  organizationId: string;
  userId: string;
  agentId: string;
}) {
  const database = createDatabase(params.env);
  const ownedAgent = await getAccessibleAgent(
    params.env,
    params.organizationId,
    params.agentId,
    params.userId,
  );
  if (!ownedAgent) throw new ChatAgentNotFoundError();
  if (ownedAgent.status !== "live") throw new ChatAgentUnavailableError();

  const [created] = await database
    .insert(chat)
    .values({
      id: crypto.randomUUID(),
      organizationId: params.organizationId,
      agentId: ownedAgent.id,
      userId: params.userId,
      title: "New conversation",
    })
    .returning();
  if (!created) throw new Error("Failed to create chat");
  return created;
}
