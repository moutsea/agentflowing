import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import {
  AgentConfigurationError,
  getAccessibleAgent,
  listAgents,
  requireAgentModelPolicy,
} from "../agents/service";
import { completeAgentRun, failAndRefundAgentRun, startAgentRun } from "../billing/service";
import { loadAttachmentContext } from "../files/service";

export class ExternalAgentNotFoundError extends Error {}
export class ExternalAgentUnavailableError extends Error {}
export class ExternalRunConflictError extends Error {
  constructor(readonly status: string) {
    super(`A run with this idempotency key is already ${status}`);
  }
}

export async function listExternalAgents(env: Env, organizationId: string, userId: string) {
  return (await listAgents(env, organizationId, userId))
    .filter((item) => item.status === "live" && item.visibility !== "private")
    .map(({ id, slug, name, description, model, creditCost, visibility, updatedAt }) => ({
      id,
      slug,
      name,
      description,
      model,
      creditCost,
      visibility,
      updatedAt,
    }));
}

export async function runExternalAgent(params: {
  env: Env;
  organizationId: string;
  userId: string;
  agentId: string;
  message: string;
  idempotencyKey: string;
  assetIds?: string[];
}) {
  const item = await getAccessibleAgent(
    params.env,
    params.organizationId,
    params.agentId,
    params.userId,
  );
  if (!item) throw new ExternalAgentNotFoundError("Agent not found");
  if (item.visibility === "private") {
    throw new ExternalAgentNotFoundError("Agent not found");
  }
  if (item.status !== "live") throw new ExternalAgentUnavailableError("Agent is not live");
  let modelPolicy;
  try {
    modelPolicy = requireAgentModelPolicy(item.model, item.creditCost);
  } catch (error) {
    if (error instanceof AgentConfigurationError) {
      throw new ExternalAgentUnavailableError(error.message);
    }
    throw error;
  }

  const attachmentContext = await loadAttachmentContext({
    env: params.env,
    organizationId: params.organizationId,
    assetIds: params.assetIds,
  });
  const run = await startAgentRun({
    env: params.env,
    organizationId: params.organizationId,
    agentId: item.id,
    userId: params.userId,
    idempotencyKey: `api:${params.idempotencyKey}`,
    credits: item.creditCost,
  });
  if (run.duplicate) {
    if (run.status === "completed" && run.output) {
      return {
        runId: run.id,
        output: run.output,
        credits: run.credits,
        usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens },
        replayed: true,
      };
    }
    throw new ExternalRunConflictError(run.status);
  }

  try {
    const workersAI = createWorkersAI({ binding: params.env.AI });
    const result = await generateText({
      model: workersAI(item.model),
      system: attachmentContext
        ? `${item.systemPrompt}\n\n${attachmentContext}`
        : item.systemPrompt,
      prompt: params.message,
      maxOutputTokens: modelPolicy.maxOutputTokens,
    });
    const output = result.text.slice(0, 100_000);
    await completeAgentRun({
      env: params.env,
      runId: run.id,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      output,
    });
    return {
      runId: run.id,
      output,
      credits: run.credits,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      replayed: false,
    };
  } catch (error) {
    await failAndRefundAgentRun({
      env: params.env,
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
