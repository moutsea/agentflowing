import { createMiddleware } from "hono/factory";

import { readRuntimeString } from "../env";
import type { AppContext } from "../types";

// Immutable user IDs, deliberately independent of workspace membership and email.
export function isPlatformAdmin(env: object, userId: string) {
  return (readRuntimeString(env, "PLATFORM_ADMIN_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}

export const requirePlatformAdmin = createMiddleware<AppContext>(async (context, next) => {
  if (!isPlatformAdmin(context.env, context.var.user.id)) {
    return context.json(
      { error: "forbidden", message: "Platform administrator access is required" },
      403,
    );
  }
  await next();
});
