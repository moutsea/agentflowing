import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type OnChatMessageOptions,
} from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

import { createDatabase } from "../db";
import { agent as agentTable, chat } from "../db/schema";
import { AgentConfigurationError, requireAgentModelPolicy } from "../modules/agents/service";
import {
  cancelAndRefundAgentRun,
  completeAgentRun,
  DuplicateAgentRunError,
  failAndRefundAgentRun,
  InsufficientCreditsError,
  startAgentRun,
} from "../modules/billing/service";
import { AttachmentValidationError, loadAttachmentContext } from "../modules/files/service";
import { enforceRateLimit, RateLimitExceededError } from "../middleware/rate-limit";
import { and, eq } from "drizzle-orm";

export class MonetizedAgent extends AIChatAgent<Env> {
  override maxPersistedMessages = 100;
  override chatRecovery = true;

  override async onChatRecovery(context: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    const recoveryData = context.recoveryData;
    if (
      typeof recoveryData === "object" &&
      recoveryData !== null &&
      "billingRunId" in recoveryData &&
      typeof recoveryData.billingRunId === "string"
    ) {
      await cancelAndRefundAgentRun({
        env: this.env,
        runId: recoveryData.billingRunId,
        reason: "Canceled after Durable Object recovery",
      });
    }
    return {};
  }

  override async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    let runContext;
    try {
      runContext = await this.startBillableRun(options);
    } catch (error) {
      const response = billableAgentErrorResponse(error);
      if (response) return response;
      throw error;
    }
    const workersAI = createWorkersAI({ binding: this.env.AI });
    try {
      const attachmentContext = await loadAttachmentContext({
        env: this.env,
        organizationId: runContext.organizationId,
        assetIds: options?.body?.assetIds,
      });
      const result = streamText({
        model: workersAI(runContext.model),
        system: attachmentContext
          ? `${runContext.systemPrompt}\n\n${attachmentContext}`
          : runContext.systemPrompt,
        messages: await convertToModelMessages(this.messages),
        tools: {
          calculateRevenue: tool({
            description: "Estimate monthly recurring revenue for a SaaS plan.",
            inputSchema: z.object({
              subscribers: z.number().int().min(0),
              monthlyPrice: z.number().min(0),
              churnPercent: z.number().min(0).max(100).default(0),
            }),
            execute: async ({ subscribers, monthlyPrice, churnPercent }) => ({
              grossMrr: subscribers * monthlyPrice,
              retainedMrr: subscribers * monthlyPrice * (1 - churnPercent / 100),
            }),
          }),
        },
        maxOutputTokens: runContext.maxOutputTokens,
        stopWhen: stepCountIs(runContext.maxSteps),
        abortSignal: options?.abortSignal,
        onFinish: async ({ usage }) => {
          await completeAgentRun({
            env: this.env,
            runId: runContext.runId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
        },
        onError: async ({ error }) => {
          await failAndRefundAgentRun({
            env: this.env,
            runId: runContext.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
        onAbort: async () => {
          await cancelAndRefundAgentRun({
            env: this.env,
            runId: runContext.runId,
          });
        },
      });

      return result.toUIMessageStreamResponse();
    } catch (error) {
      await failAndRefundAgentRun({
        env: this.env,
        runId: runContext.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      const response = billableAgentErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }

  private async startBillableRun(options?: OnChatMessageOptions) {
    if (!options?.requestId) {
      throw new BillableAgentUnavailableError("Agent request ID is required");
    }
    const ownedChat = await loadBillableChat(this.env, this.name);
    await enforceRateLimit({
      limiter: this.env.AI_RATE_LIMITER,
      key: `${ownedChat.organizationId}:${ownedChat.userId}`,
      scope: "chat_agent_run",
    });

    const run = await startAgentRun({
      env: this.env,
      organizationId: ownedChat.organizationId,
      agentId: ownedChat.agentId,
      chatId: ownedChat.chatId,
      userId: ownedChat.userId,
      idempotencyKey: `chat:${ownedChat.chatId}:request:${options.requestId}`,
      credits: ownedChat.credits,
      duplicateBehavior: "reject",
    });
    this.stash({ billingRunId: run.id });

    return { ...ownedChat, runId: run.id, credits: run.credits };
  }
}

export function billableAgentErrorResponse(error: unknown) {
  if (error instanceof RateLimitExceededError) {
    return agentErrorStreamResponse({
      code: "rate_limited",
      message: error.message,
      status: 429,
      headers: { "retry-after": String(error.retryAfterSeconds) },
    });
  }
  if (error instanceof InsufficientCreditsError) {
    return agentErrorStreamResponse({
      code: "insufficient_credits",
      message: error.message,
      status: 402,
    });
  }
  if (error instanceof DuplicateAgentRunError) {
    return agentErrorStreamResponse({
      code: "idempotency_conflict",
      message: error.message,
      status: 409,
    });
  }
  if (error instanceof AttachmentValidationError) {
    return agentErrorStreamResponse({ code: error.code, message: error.message, status: 400 });
  }
  if (error instanceof BillableAgentUnavailableError || error instanceof AgentConfigurationError) {
    return agentErrorStreamResponse({
      code: "agent_unavailable",
      message: error.message,
      status: 409,
    });
  }
  return null;
}

function agentErrorStreamResponse(params: {
  code: string;
  message: string;
  status: number;
  headers?: HeadersInit;
}) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "error", errorText: params.message });
    },
  });
  const headers = new Headers(params.headers);
  headers.set("x-agent-error-code", params.code);
  return createUIMessageStreamResponse({ status: params.status, headers, stream });
}

export class BillableAgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillableAgentUnavailableError";
  }
}

export async function loadBillableChat(env: Env, chatId: string) {
  const database = createDatabase(env);
  const [ownedChat] = await database
    .select({
      chatId: chat.id,
      organizationId: chat.organizationId,
      userId: chat.userId,
      agentId: agentTable.id,
      model: agentTable.model,
      systemPrompt: agentTable.systemPrompt,
      credits: agentTable.creditCost,
      agentStatus: agentTable.status,
      agentVisibility: agentTable.visibility,
      agentCreatedBy: agentTable.createdBy,
    })
    .from(chat)
    .innerJoin(agentTable, eq(agentTable.id, chat.agentId))
    .where(and(eq(chat.id, chatId), eq(chat.status, "active")))
    .limit(1);
  if (!ownedChat) throw new BillableAgentUnavailableError("Chat not found or inactive");
  if (ownedChat.agentStatus !== "live") {
    throw new BillableAgentUnavailableError("Agent is not live");
  }
  if (ownedChat.agentVisibility === "private" && ownedChat.agentCreatedBy !== ownedChat.userId) {
    throw new BillableAgentUnavailableError("Agent is private");
  }
  const policy = requireAgentModelPolicy(ownedChat.model, ownedChat.credits);
  return { ...ownedChat, ...policy };
}
