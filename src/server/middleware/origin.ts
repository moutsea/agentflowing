import { createMiddleware } from "hono/factory";

import type { AppContext } from "../types";

export const requireSameOrigin = createMiddleware<AppContext>(async (context, next) => {
  context.header("cache-control", "no-store");
  const origin = context.req.header("origin");
  if (
    !["GET", "HEAD"].includes(context.req.method) &&
    origin &&
    origin !== new URL(context.env.APP_URL).origin
  ) {
    return context.json({ error: "forbidden", message: "Invalid request origin" }, 403);
  }
  await next();
});
