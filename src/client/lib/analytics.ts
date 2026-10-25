/**
 * Browser-side page view beacon.
 *
 * Why this has to live in the browser: the built SPA is served by Cloudflare's
 * static asset handler, so a page view never reaches the Worker and never shows
 * up in server logs or request middleware. The only participant that knows a
 * page was actually shown is the browser itself, so the browser has to report
 * it. 静态 HTML 由 Cloudflare Assets 以 SPA 方式直出，Worker 完全看不到页面请求，
 * 因此「页面浏览」只能由浏览器主动上报。
 *
 * What to report is decided by `analytics-payload.ts`, which is pure and tested;
 * this module only supplies the real browser values and sends the request.
 *
 * Reporting is strictly best-effort: it never blocks rendering and never
 * surfaces an error to the visitor.
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { buildPageViewPayload, isDoNotTrackEnabled } from "./analytics-payload";

const COLLECT_ENDPOINT = "/api/analytics/collect";

/**
 * Report one page view. Fire-and-forget on purpose: `keepalive` lets the request
 * finish even when the visitor navigates away, and every failure is swallowed so
 * analytics can never break the product.
 *
 * `options.referrer` overrides the document referrer. `document.referrer` never
 * changes while the SPA is mounted, so using it for every route change would
 * credit the landing channel with the whole session's browsing; the hook below
 * passes our own origin for in-app navigation instead, which is what the
 * "internal" source is for.
 */
export function trackPageView(path: string, options: { referrer?: string } = {}): void {
  if (typeof window === "undefined") return;

  const navigatorFlag = (navigator as Navigator & { doNotTrack?: string | null }).doNotTrack;
  const windowFlag = (window as Window & { doNotTrack?: string | null }).doNotTrack;
  if (isDoNotTrackEnabled({ navigatorFlag, windowFlag })) return;

  const payload = buildPageViewPayload({
    path,
    referrer: options.referrer ?? document.referrer,
    search: window.location.search,
  });
  if (!payload) return;

  void fetch(COLLECT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Report one page view per route change.
 *
 * The ref is what makes this safe under `<StrictMode>`: development mounts every
 * effect twice, so a naive hook would double-count each visit. Remembering the
 * last reported pathname keeps a single view per path, while still reporting
 * again when the visitor comes back to the same path later.
 *
 * Only the first view of a document carries the external referrer. Everything
 * after it was reached from inside the app, so it is reported as coming from our
 * own previous page: the server maps our hostname to the "internal" source, and
 * without this the landing channel would be credited with the whole session.
 */
export function usePageViewTracking(): void {
  const { pathname } = useLocation();
  const lastTrackedPath = useRef<string | null>(null);

  useEffect(() => {
    if (lastTrackedPath.current === pathname) return;
    const previousPath = lastTrackedPath.current;
    lastTrackedPath.current = pathname;
    trackPageView(
      pathname,
      previousPath === null ? {} : { referrer: `${window.location.origin}${previousPath}` },
    );
  }, [pathname]);
}
