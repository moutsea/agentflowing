import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { createAuth } from "../../auth";
import { requireAuth } from "../../middleware/auth";
import { enforceRateLimit } from "../../middleware/rate-limit";
import { requirePlatformAdmin } from "../../middleware/platform-admin";
import type { AppContext } from "../../types";
import {
  createNotice,
  deleteNotice,
  getNoticeSummary,
  listNotices,
  recordNoticeRead,
  setNoticePublication,
  updateNotice,
} from "./service";

const localizedText = (max: number) =>
  z
    .object({
      en: z.string().trim().max(max).default(""),
      zh: z.string().trim().max(max).default(""),
    })
    .strict();

export const noticeSchema = z
  .object({
    title: localizedText(160),
    content: localizedText(8000),
    priority: z.enum(["normal", "important"]),
    isActive: z.boolean(),
  })
  .strict()
  .refine((value) => {
    const complete = ["en", "zh"] as const;
    return (
      complete.some((locale) => value.title[locale] && value.content[locale]) &&
      complete.every((locale) => Boolean(value.title[locale]) === Boolean(value.content[locale]))
    );
  }, "Provide a title and content together in at least one language");

const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) });
const validateNotice = zValidator("json", noticeSchema, (result, context) => {
  if (!result.success)
    return context.json(
      {
        error: "invalid_notice",
        message:
          "Provide a title and content together in at least one language (title: 160 characters, content: 8000).",
      },
      400,
    );
});
const protectRequest = createMiddleware<AppContext>(async (context, next) => {
  context.header("cache-control", "private, no-store");
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
const limitNoticeWrites = createMiddleware<AppContext>(async (context, next) => {
  if (!["GET", "HEAD"].includes(context.req.method)) {
    await enforceRateLimit({
      limiter: context.env.API_RATE_LIMITER,
      key: `notices:${context.var.user.id}`,
      scope: "notice_write",
      requestId: context.var.requestId,
    });
  }
  await next();
});
const notFound = { error: "not_found", message: "Announcement not found" };

export const noticeRoutes = new Hono<AppContext>();
noticeRoutes.use("*", protectRequest);
noticeRoutes.get("/", zValidator("query", pageSchema), async (context) => {
  const session = await createAuth(context.env).api.getSession({
    headers: context.req.raw.headers,
  });
  return context.json(
    await listNotices(context.env, { ...context.req.valid("query"), userId: session?.user.id }),
  );
});
noticeRoutes.get("/summary", requireAuth, async (context) =>
  context.json({ data: await getNoticeSummary(context.env, context.var.user.id) }),
);
for (const action of ["read", "dismiss"] as const) {
  noticeRoutes.post(`/:id/${action}`, requireAuth, limitNoticeWrites, async (context) => {
    const found = await recordNoticeRead(
      context.env,
      context.var.user.id,
      context.req.param("id"),
      action === "dismiss",
    );
    return found ? context.json({ success: true }) : context.json(notFound, 404);
  });
}

export const adminNoticeRoutes = new Hono<AppContext>();
adminNoticeRoutes.use("*", protectRequest, requireAuth, requirePlatformAdmin, limitNoticeWrites);
adminNoticeRoutes.use(
  "*",
  bodyLimit({
    maxSize: 128 * 1024,
    onError: (context) =>
      context.json({ error: "payload_too_large", message: "Announcement is too large" }, 413),
  }),
);
adminNoticeRoutes.get("/", zValidator("query", pageSchema), async (context) =>
  context.json(await listNotices(context.env, { ...context.req.valid("query"), admin: true })),
);
adminNoticeRoutes.post("/", validateNotice, async (context) =>
  context.json(
    { data: await createNotice(context.env, context.var.user.id, context.req.valid("json")) },
    201,
  ),
);
adminNoticeRoutes.put("/:id", validateNotice, async (context) => {
  const data = await updateNotice(context.env, context.req.param("id"), context.req.valid("json"));
  return data ? context.json({ data }) : context.json(notFound, 404);
});
adminNoticeRoutes.patch(
  "/:id",
  zValidator("json", z.object({ isActive: z.boolean() }).strict()),
  async (context) => {
    const data = await setNoticePublication(
      context.env,
      context.req.param("id"),
      context.req.valid("json").isActive,
    );
    return data ? context.json({ data }) : context.json(notFound, 404);
  },
);
adminNoticeRoutes.delete("/:id", async (context) => {
  const data = await deleteNotice(context.env, context.req.param("id"));
  return data ? context.json({ data }) : context.json(notFound, 404);
});
