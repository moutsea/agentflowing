import { createMiddleware } from "hono/factory";

import type { AppContext } from "../../types";

export type ExternalCodeResource = "redemption" | "coupon";

type ExternalTokenName = "EXTERNAL_REDEMPTION_CODE_API_TOKEN" | "EXTERNAL_COUPON_API_TOKEN";

type ExternalTokenEnv = Env & Partial<Record<ExternalTokenName, string>>;

const TOKEN_NAMES: Record<ExternalCodeResource, ExternalTokenName> = {
  redemption: "EXTERNAL_REDEMPTION_CODE_API_TOKEN",
  coupon: "EXTERNAL_COUPON_API_TOKEN",
};

const UNAUTHORIZED = {
  error: "unauthorized",
  message: "A valid external API token is required.",
  messages: {
    en: "A valid external API token is required.",
    "zh-CN": "需要有效的外部 API token。",
  },
} as const;

const NOT_CONFIGURED = {
  error: "service_unavailable",
  message: "The external API token is not configured.",
  messages: {
    en: "The external API token is not configured.",
    "zh-CN": "服务端未配置外部 API token。",
  },
} as const;

function readPresentedToken(authorization: string | undefined, apiToken: string | undefined) {
  // Authorization has precedence whenever the header exists, including when
  // it is malformed. This prevents a valid x-api-token from bypassing it.
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/.exec(authorization);
    return match?.[1]?.trim() ?? "";
  }
  return apiToken?.trim() ?? "";
}

function tokensEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function externalTokenName(resource: ExternalCodeResource) {
  return TOKEN_NAMES[resource];
}

export function requireExternalToken(resource: ExternalCodeResource) {
  return createMiddleware<AppContext>(async (context, next) => {
    context.header("Cache-Control", "no-store");

    const tokenName = TOKEN_NAMES[resource];
    const configuredToken = (context.env as ExternalTokenEnv)[tokenName]?.trim() ?? "";
    if (!configuredToken) {
      return context.json(NOT_CONFIGURED, 503);
    }

    const presentedToken = readPresentedToken(
      context.req.header("authorization"),
      context.req.header("x-api-token"),
    );
    if (!presentedToken || !tokensEqual(presentedToken, configuredToken)) {
      return context.json(UNAUTHORIZED, 401);
    }

    await next();
  });
}
