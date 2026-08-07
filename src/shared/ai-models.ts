export type AiModelPolicy = {
  id: string;
  name: string;
  description: string;
  minimumCreditCost: number;
  maxOutputTokens: number;
  maxSteps: number;
};

export const AI_MODEL_CATALOG = [
  {
    id: "@cf/zai-org/glm-4.7-flash",
    name: "GLM 4.7 Flash",
    description: "Fast multilingual model for chat and tool-calling agents.",
    minimumCreditCost: 1,
    maxOutputTokens: 2_048,
    maxSteps: 4,
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B Fast",
    description: "Stronger general-purpose model with a higher minimum charge.",
    minimumCreditCost: 2,
    maxOutputTokens: 2_048,
    maxSteps: 4,
  },
  {
    id: "@cf/moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    description: "Frontier agentic model for complex, higher-value workflows.",
    minimumCreditCost: 8,
    maxOutputTokens: 4_096,
    maxSteps: 4,
  },
] as const satisfies readonly AiModelPolicy[];

export const DEFAULT_AI_MODEL_ID = AI_MODEL_CATALOG[0].id;

export function getAiModelPolicy(modelId: string): AiModelPolicy | null {
  return AI_MODEL_CATALOG.find((model) => model.id === modelId) ?? null;
}

export function isSupportedAiModel(modelId: string): boolean {
  return getAiModelPolicy(modelId) !== null;
}
