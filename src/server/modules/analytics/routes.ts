import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import {
  ANALYTICS_CAMPAIGN_MAX_LENGTH,
  ANALYTICS_PATH_MAX_LENGTH,
  ANALYTICS_REFERRER_MAX_LENGTH,
  DEFAULT_ANALYTICS_RANGE,
  isAnalyticsRange,
} from "../../../shared/analytics";
import { requireAuth } from "../../middleware/auth";
import { requirePlatformAdmin } from "../../middleware/platform-admin";
import { anonymousRateLimitKey, enforceRateLimit } from "../../middleware/rate-limit";
import type { AppContext } from "../../types";
import { getAnalyticsOverview, recordAnalyticsVisit } from "./service";

/** What the beacon may send. The browser knows nothing the server cannot bound. */
const collectSchema = z.object({
  path: z.string().min(1).max(ANALYTICS_PATH_MAX_LENGTH),
  referrer: z.string().max(ANALYTICS_REFERRER_MAX_LENGTH).optional(),
  // Strict: an unknown utm_* key is a client bug we want to reject loudly. The
  // top level stays open so the beacon can add diagnostic fields without a
  // server deploy.
  campaign: z
    .object({
      source: z.string().max(ANALYTICS_CAMPAIGN_MAX_LENGTH).optional(),
      medium: z.string().max(ANALYTICS_CAMPAIGN_MAX_LENGTH).optional(),
      name: z.string().max(ANALYTICS_CAMPAIGN_MAX_LENGTH).optional(),
    })
    .strict()
    .optional(),
});

const collectBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: (context) =>
    context.json({ error: "payload_too_large", message: "Analytics payload is too large" }, 413),
});

/**
 * Reject beacons posted by a page on someone else's site.
 *
 * Without this, any page could POST plausible-looking page views and inflate a
 * customer's numbers. A cross-site `fetch` cannot suppress `Origin`, so a
 * mismatch with the URL the Worker was actually reached on is a reliable signal;
 * a request with no `Origin` at all is a non-browser client, and the per-IP rate
 * limit is what bounds those.
 *
 * The comparison is against the request's own origin rather than `APP_URL` on
 * purpose: a deployment reached through a second domain would otherwise reject
 * every real beacon and quietly record nothing.
 */
const protectCollect = createMiddleware<AppContext>(async (context, next) => {
  const origin = context.req.header("origin");
  if (origin && origin !== new URL(context.req.url).origin)
    return context.json({ error: "forbidden", message: "Invalid request origin" }, 403);
  await next();
});

const limitCollect = createMiddleware<AppContext>(async (context, next) => {
  await enforceRateLimit({
    limiter: context.env.API_RATE_LIMITER,
    key: anonymousRateLimitKey(context.req.raw),
    scope: "analytics_collect",
    requestId: context.var.requestId,
  });
  await next();
});

const validateCollect = zValidator("json", collectSchema, (result, context) => {
  if (!result.success)
    return context.json(
      {
        error: "invalid_payload",
        message:
          "Provide the page path (up to 512 characters) and, optionally, a referrer or campaign.",
      },
      400,
    );
});

export const analyticsRoutes = new Hono<AppContext>();

// The single documented beacon target: `POST /api/analytics/collect`. This
// router is mounted at `/api/analytics`, and no alias is offered on the mount
// point itself — a second unauthenticated write path would only widen the
// attack surface.
//
// Landing pages are anonymous, so this route cannot require a session. The
// bounds that keep it cheap are the body limit and the per-IP rate limit above;
// everything it decides is best effort, and a visitor with JavaScript disabled
// is simply not counted.
analyticsRoutes.post(
  "/collect",
  protectCollect,
  // Ordered cheapest-first: reject the wrong origin without reading anything,
  // then let the rate limiter turn away a flood before its payloads are buffered.
  limitCollect,
  collectBodyLimit,
  validateCollect,
  async (context) => {
    const data = await recordAnalyticsVisit({
      env: context.env,
      request: context.req.raw,
      input: context.req.valid("json"),
    });
    context.header("cache-control", "no-store");
    return context.json({ data }, 202);
  },
);

const rangeSchema = z.object({
  days: z.coerce.number().int().default(DEFAULT_ANALYTICS_RANGE),
});

const validateRange = zValidator("query", rangeSchema, (result, context) => {
  if (!result.success)
    return context.json({ error: "invalid_range", message: "Days must be a whole number." }, 400);
});

export const adminAnalyticsRoutes = new Hono<AppContext>();

adminAnalyticsRoutes.use("*", async (context, next) => {
  context.header("cache-control", "private, no-store");
  await next();
});
adminAnalyticsRoutes.use(
  "*",
  requireAuth,
  requirePlatformAdmin,
  // Reading the dashboard costs a batch of indexed aggregates over the whole
  // retention window, so it is bounded like every other billing read. One
  // admin gets one bucket, which keeps a stuck retry loop off the database.
  async (context, next) => {
    await enforceRateLimit({
      limiter: context.env.API_RATE_LIMITER,
      key: `${context.var.user.id}:admin-analytics`,
      scope: "admin_analytics_read",
      requestId: context.var.requestId,
    });
    await next();
  },
);

adminAnalyticsRoutes.get("/", validateRange, async (context) => {
  const { days } = context.req.valid("query");
  // Ranges are exact on purpose: the dashboard offers 7/30/90, so anything else
  // is a stale client rather than a number worth clamping.
  if (!isAnalyticsRange(days))
    return context.json(
      { error: "invalid_range", message: "Choose a 7, 30 or 90 day range." },
      400,
    );

  context.header("cache-control", "private, no-store");
  return context.json({ data: await getAnalyticsOverview(context.env, days) });
});
