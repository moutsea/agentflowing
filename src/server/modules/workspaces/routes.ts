import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { createAuth } from "../../auth";
import { requireAuth } from "../../middleware/auth";
import { getCreditSummary } from "../billing/service";
import type { AppContext } from "../../types";
import { getWorkspaceMembership, listWorkspaces } from "./service";

const activeOrganizationSchema = z.object({ organizationId: z.string().min(1).max(128) }).strict();

export const workspaceRoutes = new Hono<AppContext>();

workspaceRoutes.use("*", requireAuth);

workspaceRoutes.get("/session", async (context) => {
  const identity = context.var;
  const [credits, organizations] = await Promise.all([
    getCreditSummary(context.env, identity.organization.id),
    listWorkspaces(context.env, identity.user.id),
  ]);
  return context.json({
    data: {
      user: identity.user,
      organization: identity.organization,
      role: identity.role,
      credits: credits.account,
      organizations,
    },
  });
});

workspaceRoutes.post(
  "/organizations/active",
  zValidator("json", activeOrganizationSchema),
  async (context) => {
    const { organizationId } = context.req.valid("json");
    const workspace = await getWorkspaceMembership(
      context.env,
      context.var.user.id,
      organizationId,
    );
    if (!workspace) {
      return context.json(
        { error: "forbidden", message: "You are not a member of this workspace" },
        403,
      );
    }
    await createAuth(context.env).api.setActiveOrganization({
      body: { organizationId },
      headers: context.req.raw.headers,
    });
    return context.json({ data: workspace });
  },
);

workspaceRoutes.get("/credits", async (context) => {
  const data = await getCreditSummary(context.env, context.var.organization.id);
  return context.json({ data });
});
