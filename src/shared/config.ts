export const PRODUCT = {
  name: "AgentFlowing",
  tagline: "Ship agents that earn",
  description: "An open-source Cloudflare-native foundation for launching paid AI agent products.",
} as const;

export const DEFAULT_PLANS = [
  {
    id: "free",
    name: "Builder",
    monthlyPrice: 0,
    credits: 100,
    description: "For validating one useful agent.",
    features: ["100 starter credits", "1 workspace", "Community support"],
  },
  {
    id: "pro",
    name: "Launch",
    monthlyPrice: 29,
    credits: 5_000,
    description: "For a real agent business with paying users.",
    features: ["5,000 monthly credits", "Unlimited agents", "Usage analytics"],
  },
  {
    id: "scale",
    name: "Scale",
    monthlyPrice: 99,
    credits: 25_000,
    description: "For teams operating several agent products.",
    features: ["25,000 monthly credits", "Team seats", "Priority support"],
  },
] as const;
