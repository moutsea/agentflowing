import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { routeAgentRequest } from "agents";
import { and, eq } from "drizzle-orm";

import { MonetizedAgent } from "./agents/monetized-agent";
import { createAuth, getAuthCapabilities } from "./auth";
import { createDatabase } from "./db";
import { agent, chat } from "./db/schema";
import { observeRequest } from "./middleware/observability";
import {
  anonymousRateLimitKey,
  enforceRateLimit,
  RateLimitExceededError,
} from "./middleware/rate-limit";
import { agentRoutes } from "./modules/agents/routes";
import { apiKeyRoutes } from "./modules/api-keys/routes";
import { billingRoutes } from "./modules/billing/routes";
import { reapStaleAgentRuns } from "./modules/billing/service";
import { chatRoutes } from "./modules/chats/routes";
import { fileRoutes } from "./modules/files/routes";
import { externalApiRoutes } from "./modules/external-api/routes";
import { resolveWorkspace } from "./modules/workspaces/service";
import { workspaceRoutes } from "./modules/workspaces/routes";
import type { AppContext } from "./types";
import { logEvent } from "./observability";

export { MonetizedAgent };

const app = new Hono<AppContext>();

app.use("*", observeRequest);
app.use("*", secureHeaders());

app.use("/api/auth/*", async (context, next) => {
  if (context.req.method === "POST") {
    await enforceRateLimit({
      limiter: context.env.AUTH_RATE_LIMITER,
      key: anonymousRateLimitKey(context.req.raw),
      scope: "auth_write",
      requestId: context.var.requestId,
    });
  }
  await next();
});

app.get("/api/health", (context) =>
  context.json({
    ok: true,
    service: context.env.APP_NAME,
    timestamp: new Date().toISOString(),
  }),
);

app.get("/api/auth/capabilities", (context) => {
  context.header("cache-control", "public, max-age=60");
  return context.json(getAuthCapabilities(context.env));
});

app.on(["GET", "POST"], "/api/auth/*", (context) => {
  return createAuth(context.env).handler(context.req.raw);
});

app.route("/api/chats", chatRoutes);
app.route("/api/agents", agentRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api/files", fileRoutes);
app.route("/api/api-keys", apiKeyRoutes);
app.route("/api/v1", externalApiRoutes);
app.route("/api", workspaceRoutes);

app.all("/agents/*", async (context) => {
  const pathSegments = context.req.path.split("/").filter(Boolean);
  if (pathSegments[0] !== "agents" || pathSegments[1] !== "monetized-agent") {
    return context.json({ error: "not_found", message: "Agent not found" }, 404);
  }
  let instanceName = "";
  try {
    instanceName = decodeURIComponent(pathSegments[2] ?? "");
  } catch {
    return context.json({ error: "invalid_request", message: "Invalid Agent name" }, 400);
  }
  if (!instanceName) {
    return context.json({ error: "invalid_request", message: "Agent name is required" }, 400);
  }

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
  const [ownedChat] = await createDatabase(context.env)
    .select({ id: chat.id, chatStatus: chat.status, agentStatus: agent.status })
    .from(chat)
    .innerJoin(agent, eq(agent.id, chat.agentId))
    .where(
      and(
        eq(chat.id, instanceName),
        eq(chat.organizationId, workspace.organization.id),
        eq(chat.userId, result.user.id),
      ),
    )
    .limit(1);
  if (!ownedChat) {
    return context.json({ error: "not_found", message: "Chat not found" }, 404);
  }
  if (ownedChat.chatStatus !== "active" || ownedChat.agentStatus !== "live") {
    return context.json({ error: "agent_unavailable", message: "Agent is not live" }, 409);
  }

  const response = await routeAgentRequest(context.req.raw, context.env);
  return response ?? context.json({ error: "Agent not found" }, 404);
});

app.notFound((context) => context.json({ error: "Not found" }, 404));

app.onError((error, context) => {
  if (error instanceof RateLimitExceededError) {
    context.header("retry-after", String(error.retryAfterSeconds));
    return context.json({ error: "rate_limited", message: error.message, scope: error.scope }, 429);
  }
  logEvent("error", "request.failed", {
    requestId: context.var.requestId,
    method: context.req.method,
    path: context.req.path,
    message: error.message,
  });
  return context.json({ error: "Internal server error" }, 500);
});

export default {
  fetch(request, env, executionContext) {
    return app.fetch(request, env, executionContext);
  },
  async scheduled(_controller, env) {
    await reapStaleAgentRuns({ env });
  },
} satisfies ExportedHandler<Env>;
