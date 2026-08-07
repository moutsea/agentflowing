import { createFactory } from "hono/factory";

import { createAuth } from "../auth";
import { resolveWorkspace } from "../modules/workspaces/service";
import type { AppContext } from "../types";

const factory = createFactory<AppContext>();

export const requireAuth = factory.createMiddleware(async (context, next) => {
  const auth = createAuth(context.env);
  const result = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!result) {
    return context.json({ error: "unauthorized", message: "Sign in is required" }, 401);
  }

  const workspace = await resolveWorkspace({
    env: context.env,
    userId: result.user.id,
    userName: result.user.name,
    activeOrganizationId: result.session.activeOrganizationId,
  });

  context.set("user", result.user);
  context.set("session", result.session);
  context.set("organization", workspace.organization);
  context.set("role", workspace.role);
  await next();
});
