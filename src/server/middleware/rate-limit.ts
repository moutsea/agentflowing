import { logEvent } from "../observability";

export class RateLimitExceededError extends Error {
  readonly retryAfterSeconds = 60;

  constructor(readonly scope: string) {
    super("Too many requests. Try again shortly.");
    this.name = "RateLimitExceededError";
  }
}

export async function enforceRateLimit(params: {
  limiter: RateLimit;
  key: string;
  scope: string;
  requestId?: string;
}) {
  const outcome = await params.limiter.limit({ key: params.key });
  if (outcome.success) return;
  logEvent("warn", "rate_limit.exceeded", {
    scope: params.scope,
    requestId: params.requestId,
  });
  throw new RateLimitExceededError(params.scope);
}

export function anonymousRateLimitKey(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `${new URL(request.url).pathname}:${ip}`;
}
