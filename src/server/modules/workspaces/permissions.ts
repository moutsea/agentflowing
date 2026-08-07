import { createFactory } from "hono/factory";

import type { AppContext } from "../../types";

const factory = createFactory<AppContext>();

export function canManageWorkspace(role: string) {
  return role === "owner" || role === "admin";
}

export const requireWorkspaceManager = factory.createMiddleware(async (context, next) => {
  if (!canManageWorkspace(context.var.role)) {
    return context.json(
      { error: "forbidden", message: "Only workspace owners and admins can perform this action" },
      403,
    );
  }
  await next();
});
