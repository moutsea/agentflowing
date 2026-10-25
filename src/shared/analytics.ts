/**
 * Traffic analytics contract.
 *
 * The SPA is served by Cloudflare's static asset handler, so a page view never
 * reaches the Worker: the browser has to report one. Everything in this file is
 * therefore shared by the beacon (`POST /api/analytics/collect`) and the admin
 * dashboard that reads the aggregated result back.
 */

/** How a visit was acquired. `internal` means the visitor came from our own pages. */
export const ANALYTICS_SOURCES = [
  "direct",
  "search",
  "social",
  "referral",
  "campaign",
  "internal",
] as const;

export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];

/** English display names, doubled as i18n keys on the client. */
export const ANALYTICS_SOURCE_LABELS: Record<AnalyticsSource, string> = {
  direct: "Direct",
  search: "Search",
  social: "Social",
  referral: "Referral",
  campaign: "Campaign",
  internal: "Internal",
};

export const ANALYTICS_DEVICES = ["desktop", "mobile", "tablet"] as const;
export type AnalyticsDevice = (typeof ANALYTICS_DEVICES)[number];

/** Ranges the dashboard offers. Anything else is rejected rather than clamped. */
export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = 30;

/** Bounds the beacon payload so a hostile client cannot store arbitrary text. */
export const ANALYTICS_PATH_MAX_LENGTH = 512;
export const ANALYTICS_REFERRER_MAX_LENGTH = 2048;
export const ANALYTICS_CAMPAIGN_MAX_LENGTH = 160;

/** Mount points that answer JSON instead of a page, so a visit there is not one. */
export const ANALYTICS_IGNORED_PREFIXES = ["/api", "/agents"] as const;

/**
 * Files the browser loads on its own. A `pushState` never lands on one, so a
 * path with a static extension is a request rather than a page view.
 */
const ANALYTICS_ASSET_EXTENSION =
  /\.(?:js|mjs|css|map|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|txt|xml|json|webmanifest)$/i;

/**
 * Whether `path` is a page a visitor looked at.
 *
 * Both bundles ask this question — the client to avoid sending a pointless
 * beacon, the server to decide whether to store one — so it lives here, where
 * the two cannot drift apart. Prefixes are matched on a segment boundary:
 * `/apidocs` is a page, `/api/health` is not.
 *
 * The query string and fragment are dropped first: our own beacon reports a
 * bare `location.pathname`, but a hand-rolled client appending `?v=2` to an
 * asset would otherwise slip past the extension test.
 */
export function isPageViewPath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return false;

  const cut = trimmed.search(/[?#]/);
  const pathname = cut === -1 ? trimmed : trimmed.slice(0, cut);

  const ignored = ANALYTICS_IGNORED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (ignored) return false;

  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !ANALYTICS_ASSET_EXTENSION.test(lastSegment);
}

/**
 * What the page reports. The client only knows what the browser knows; the
 * server derives visitor identity, device and country, and never trusts these
 * values for anything but the row it stores.
 */
export type AnalyticsCollectRequest = {
  /** `location.pathname` of the page that was just shown. */
  path: string;
  /** `document.referrer`, still a full URL; the server keeps only the host. */
  referrer?: string;
  /** `utm_*` parameters of the page itself, when it has any. */
  campaign?: {
    source?: string;
    medium?: string;
    name?: string;
  };
};

export type AnalyticsCollectResponse = {
  recorded: boolean;
  /** Why a view was dropped, so the dashboard owner can debug a silent zero. */
  reason?: "bot" | "ignored_path" | "do_not_track";
};

export type AnalyticsPoint = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  pageViews: number;
  visitors: number;
};

export type AnalyticsTotals = {
  pageViews: number;
  visitors: number;
};

export type AnalyticsSourceRow = {
  source: AnalyticsSource;
  pageViews: number;
  visitors: number;
};

export type AnalyticsReferrerRow = {
  host: string;
  source: AnalyticsSource;
  pageViews: number;
};

export type AnalyticsCampaignRow = {
  name: string;
  /** UTM source or inferred referrer host; empty when unknown. */
  source: string;
  medium: string;
  pageViews: number;
};

export type AnalyticsPageRow = {
  path: string;
  pageViews: number;
  visitors: number;
};

export type AnalyticsCountryRow = {
  country: string;
  pageViews: number;
};

export type AnalyticsDeviceRow = {
  device: AnalyticsDevice;
  pageViews: number;
};

export type AnalyticsOverview = {
  range: {
    days: AnalyticsRange;
    /** Inclusive first day, `YYYY-MM-DD`. */
    since: string;
    /** Inclusive last day, `YYYY-MM-DD`. */
    until: string;
  };
  /** The selected range. */
  totals: AnalyticsTotals;
  /** The equally long range immediately before it, for a delta. */
  previous: AnalyticsTotals;
  /** One entry per day in the range, zero-filled so the chart has no gaps. */
  series: AnalyticsPoint[];
  sources: AnalyticsSourceRow[];
  referrers: AnalyticsReferrerRow[];
  campaigns: AnalyticsCampaignRow[];
  pages: AnalyticsPageRow[];
  countries: AnalyticsCountryRow[];
  devices: AnalyticsDeviceRow[];
  /** Oldest day still stored, so the dashboard can say what history it has. */
  historyStartsAt: string | null;
};

export function isAnalyticsSource(value: unknown): value is AnalyticsSource {
  return typeof value === "string" && (ANALYTICS_SOURCES as readonly string[]).includes(value);
}

export function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return typeof value === "number" && (ANALYTICS_RANGES as readonly number[]).includes(value);
}
