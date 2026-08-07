import { createFactory } from "hono/factory";

import { logEvent } from "../observability";
import type { AppContext } from "../types";

const factory = createFactory<AppContext>();
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

export const observeRequest = factory.createMiddleware(async (context, next) => {
  const providedRequestId = context.req.header("x-request-id") ?? "";
  const requestId = REQUEST_ID_PATTERN.test(providedRequestId)
    ? providedRequestId
    : crypto.randomUUID();
  const startedAt = Date.now();
  let failed = false;
  context.set("requestId", requestId);

  try {
    await next();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    context.header("x-request-id", requestId);
    logEvent("info", "request.completed", {
      requestId,
      method: context.req.method,
      path: context.req.path,
      status: failed ? 500 : context.res.status,
      durationMs: Date.now() - startedAt,
      cfRay: context.req.header("cf-ray"),
    });
  }
});
