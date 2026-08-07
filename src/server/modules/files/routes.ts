import { Hono } from "hono";

import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit } from "../../middleware/rate-limit";
import type { AppContext } from "../../types";
import { deleteAsset, FileValidationError, getAsset, listAssets, uploadAsset } from "./service";

export const fileRoutes = new Hono<AppContext>();

fileRoutes.use("*", requireAuth);

fileRoutes.get("/", async (context) => {
  const items = await listAssets(context.env, context.var.organization.id);
  return context.json({ data: items });
});

fileRoutes.post("/", async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${context.var.organization.id}:${context.var.user.id}`,
    scope: "file_upload",
    requestId: context.var.requestId,
  });
  const body = await context.req.raw.formData();
  const file = body.get("file");
  if (!(file instanceof File)) {
    return context.json({ error: "invalid_file", message: "A file field is required" }, 400);
  }
  try {
    const created = await uploadAsset({
      env: context.env,
      organizationId: context.var.organization.id,
      userId: context.var.user.id,
      file,
    });
    return context.json({ data: created }, 201);
  } catch (error) {
    if (error instanceof FileValidationError) {
      return context.json({ error: error.code, message: error.message }, 400);
    }
    throw error;
  }
});

fileRoutes.get("/:assetId", async (context) => {
  const result = await getAsset(
    context.env,
    context.var.organization.id,
    context.req.param("assetId"),
  );
  if (!result) {
    return context.json({ error: "not_found", message: "File not found" }, 404);
  }
  const headers = new Headers();
  result.object.writeHttpMetadata(headers);
  headers.set("etag", result.object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  headers.set(
    "content-disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(result.asset.name)}`,
  );
  return new Response(result.object.body, { headers });
});

fileRoutes.delete("/:assetId", async (context) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: `${context.var.organization.id}:${context.var.user.id}`,
    scope: "file_delete",
    requestId: context.var.requestId,
  });
  const deleted = await deleteAsset(
    context.env,
    context.var.organization.id,
    context.req.param("assetId"),
  );
  if (!deleted) {
    return context.json({ error: "not_found", message: "File not found" }, 404);
  }
  return context.body(null, 204);
});
