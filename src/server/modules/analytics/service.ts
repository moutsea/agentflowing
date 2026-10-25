/**
 * Writing and reading the `analytics_visit` table.
 *
 * Every row here comes from an anonymous browser beacon, so the collector is
 * defensive about what it stores; the reader is a single admin dashboard, so it
 * can afford one `Promise.all` of cheap indexed aggregates per page load.
 */

import type {
  AnalyticsCampaignRow,
  AnalyticsCollectRequest,
  AnalyticsCollectResponse,
  AnalyticsCountryRow,
  AnalyticsDevice,
  AnalyticsDeviceRow,
  AnalyticsOverview,
  AnalyticsPageRow,
  AnalyticsPoint,
  AnalyticsRange,
  AnalyticsReferrerRow,
  AnalyticsSourceRow,
  AnalyticsTotals,
} from "../../../shared/analytics";
import {
  ANALYTICS_CAMPAIGN_MAX_LENGTH,
  ANALYTICS_DEVICES,
  isAnalyticsSource,
} from "../../../shared/analytics";
import { readRuntimeNumber, readRuntimeString } from "../../env";
import { logEvent } from "../../observability";
import {
  computeVisitorKey,
  detectDevice,
  detectSource,
  isBotRequest,
  isHeadlessClient,
  isIgnoredPath,
  normalizeAnalyticsPath,
} from "./collect";

/* -------------------------------------------------------------------------- */
/* Day arithmetic                                                             */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` in UTC. Days are stored in this shape, so no date parsing is needed. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Shift a `YYYY-MM-DD` by whole days.
 *
 * This is arithmetic on the calendar label, not on an instant, so it is correct
 * whatever time zone produced the label.
 */
export function shiftDay(day: string, deltaDays: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return utcDay(date);
}

const DEFAULT_TIME_ZONE = "UTC";

/**
 * `Intl.DateTimeFormat` is expensive to construct, so one is cached per zone.
 * The set of zones comes from a variable, so it holds at most a couple of keys.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
/**
 * Zones `Intl` already refused. Without this the `RangeError` would be thrown
 * and caught on every single beacon, which is the expensive part of a typo.
 */
const rejectedTimeZones = new Set<string>();
const reportedTimeZones = new Set<string>();

function buildDayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * The zone the operator's audience lives in, validated once.
 *
 * A name Intl rejects falls back to UTC with a single warning rather than
 * throwing: a typo in a variable must not stop page views from being recorded,
 * and it must not spam one log line per beacon either.
 */
export function getAnalyticsTimeZone(env: object): string {
  const configured = readRuntimeString(env, "ANALYTICS_TIME_ZONE")?.trim();
  if (!configured) return DEFAULT_TIME_ZONE;
  if (dayFormatters.has(configured)) return configured;
  if (rejectedTimeZones.has(configured)) return DEFAULT_TIME_ZONE;
  try {
    dayFormatters.set(configured, buildDayFormatter(configured));
    return configured;
  } catch {
    rejectedTimeZones.add(configured);
    if (!reportedTimeZones.has(configured)) {
      reportedTimeZones.add(configured);
      logEvent("warn", "analytics.time_zone_invalid", { timeZone: configured });
    }
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * `YYYY-MM-DD` as the audience experiences the day.
 *
 * Bucketing happens in `ANALYTICS_TIME_ZONE` (UTC by default) so that "today"
 * starts filling at the operator's midnight. Recording and reading both go
 * through this function, which is what keeps the stored labels and the query
 * bounds on the same calendar.
 */
export function analyticsDay(env: object, date: Date): string {
  const timeZone = getAnalyticsTimeZone(env);
  if (timeZone === DEFAULT_TIME_ZONE) return utcDay(date);
  const formatter = dayFormatters.get(timeZone) ?? buildDayFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                 */
/* -------------------------------------------------------------------------- */

function isAnalyticsDevice(value: string): value is AnalyticsDevice {
  return (ANALYTICS_DEVICES as readonly string[]).includes(value);
}

function bounded(value: string | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Cloudflare gives us an ISO 3166-1 alpha-2 code; anything else is unknown. */
function countryOf(request: Request): string | null {
  const code = (request as { cf?: { country?: string } }).cf?.country?.toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Record one page view, or explain why it was dropped.
 *
 * The drops are ordered cheapest-first so an obvious bot never costs a SHA-256.
 * Unknown geography and referrers are stored as `NULL` rather than `""`: the
 * dashboard filters `country IS NOT NULL AND country <> ''`, and a nullable
 * column keeps "we do not know" distinguishable from "we stored an empty
 * string".
 */
export async function recordAnalyticsVisit(params: {
  env: Env;
  request: Request;
  input: AnalyticsCollectRequest;
}): Promise<AnalyticsCollectResponse> {
  if (params.request.headers.get("dnt") === "1") {
    return { recorded: false, reason: "do_not_track" };
  }
  if (isIgnoredPath(params.input.path)) {
    return { recorded: false, reason: "ignored_path" };
  }

  const userAgent = params.request.headers.get("user-agent") ?? "";
  if (isBotRequest(userAgent)) {
    return { recorded: false, reason: "bot" };
  }
  // A UA check alone is defeated by `--user-agent`; the browser's own client
  // hints are not, so an automated browser that bothers to lie is still caught.
  const clientHints = params.request.headers.get("sec-ch-ua");
  if (isHeadlessClient(clientHints)) {
    return { recorded: false, reason: "bot" };
  }

  const path = normalizeAnalyticsPath(params.input.path);
  if (!path) return { recorded: false, reason: "ignored_path" };

  const day = analyticsDay(params.env, new Date());
  const ip = params.request.headers.get("cf-connecting-ip") ?? "";
  const { source, sourceHost } = detectSource({
    referrer: params.input.referrer,
    appUrl: params.env.APP_URL,
    campaign: params.input.campaign,
  });
  // Only stable hints feed the identity: the platform and the mobile flag
  // separate two people behind one address, while version numbers would change
  // on every browser update and split one person into many.
  const identityHints = `${params.request.headers.get("sec-ch-ua-platform") ?? ""}|${
    params.request.headers.get("sec-ch-ua-mobile") ?? ""
  }`;
  const visitorKey = await computeVisitorKey({
    env: params.env,
    ip,
    userAgent,
    hints: identityHints,
  });

  await params.env.DB.prepare(
    `INSERT INTO analytics_visit
     (id, day, path, visitor_key, source, source_host, campaign, medium, country, device, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      day,
      path,
      visitorKey,
      source,
      sourceHost,
      bounded(params.input.campaign?.name, ANALYTICS_CAMPAIGN_MAX_LENGTH),
      bounded(params.input.campaign?.medium, ANALYTICS_CAMPAIGN_MAX_LENGTH),
      countryOf(params.request),
      detectDevice(userAgent),
      Math.floor(Date.now() / 1000),
    )
    .run();

  return { recorded: true };
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

type TotalsRow = { pageViews: number; visitors: number };
type SourceRow = { source: string; pageViews: number; visitors: number };
type ReferrerRow = { host: string | null; source: string; pageViews: number };
type CampaignRow = { name: string | null; source: string; medium: string; pageViews: number };
type PageRow = { path: string; pageViews: number; visitors: number };
type CountryRow = { country: string; pageViews: number };
type DeviceRow = { device: string; pageViews: number };
type SeriesRow = { day: string; pageViews: number; visitors: number };

const WINDOW = "WHERE day BETWEEN ? AND ?";

/**
 * Everything the dashboard shows, in one round trip of queries.
 *
 * `since`/`until` are inclusive day labels on the configured calendar (see
 * `analyticsDay`), and the comparison window is the equally long stretch
 * immediately before it: `since - days` through `since - 1` is exactly `days`
 * days long, adjacent to the current one and never overlapping it.
 */
export async function getAnalyticsOverview(
  env: Env,
  days: AnalyticsRange,
): Promise<AnalyticsOverview> {
  const until = analyticsDay(env, new Date());
  const since = shiftDay(until, 1 - days);
  const previousUntil = shiftDay(since, -1);
  const previousSince = shiftDay(previousUntil, 1 - days);

  const totalsStatement = (from: string, to: string) =>
    env.DB.prepare(
      `SELECT COUNT(*) AS pageViews, COUNT(DISTINCT visitor_key) AS visitors
       FROM analytics_visit ${WINDOW}`,
    )
      .bind(from, to)
      .first<TotalsRow>();

  const [totalsRow, previousRow, seriesResult, sourceResult, referrerResult, campaignResult] =
    await Promise.all([
      totalsStatement(since, until),
      totalsStatement(previousSince, previousUntil),
      env.DB.prepare(
        `SELECT day, COUNT(*) AS pageViews, COUNT(DISTINCT visitor_key) AS visitors
         FROM analytics_visit ${WINDOW} GROUP BY day ORDER BY day`,
      )
        .bind(since, until)
        .all<SeriesRow>(),
      env.DB.prepare(
        `SELECT source, COUNT(*) AS pageViews, COUNT(DISTINCT visitor_key) AS visitors
         FROM analytics_visit ${WINDOW} GROUP BY source ORDER BY pageViews DESC, source ASC`,
      )
        .bind(since, until)
        .all<SourceRow>(),
      env.DB.prepare(
        `SELECT source_host AS host, source, COUNT(*) AS pageViews
         FROM analytics_visit ${WINDOW} AND source_host IS NOT NULL
         GROUP BY source_host, source ORDER BY pageViews DESC, host ASC LIMIT 10`,
      )
        .bind(since, until)
        .all<ReferrerRow>(),
      env.DB.prepare(
        `SELECT campaign AS name, ifnull(source_host, '') AS source,
                ifnull(medium, '') AS medium, COUNT(*) AS pageViews
         FROM analytics_visit ${WINDOW} AND campaign IS NOT NULL
         GROUP BY campaign, ifnull(source_host, ''), ifnull(medium, '')
         ORDER BY pageViews DESC, name ASC, source ASC, medium ASC LIMIT 10`,
      )
        .bind(since, until)
        .all<CampaignRow>(),
    ]);

  const [pageResult, countryResult, deviceResult, historyRow] = await Promise.all([
    env.DB.prepare(
      `SELECT path, COUNT(*) AS pageViews, COUNT(DISTINCT visitor_key) AS visitors
       FROM analytics_visit ${WINDOW} GROUP BY path ORDER BY pageViews DESC, path ASC LIMIT 10`,
    )
      .bind(since, until)
      .all<PageRow>(),
    env.DB.prepare(
      `SELECT country, COUNT(*) AS pageViews
       FROM analytics_visit ${WINDOW} AND country IS NOT NULL AND country <> ''
       GROUP BY country ORDER BY pageViews DESC, country ASC LIMIT 10`,
    )
      .bind(since, until)
      .all<CountryRow>(),
    env.DB.prepare(
      `SELECT device, COUNT(*) AS pageViews
       FROM analytics_visit ${WINDOW} GROUP BY device ORDER BY pageViews DESC, device ASC`,
    )
      .bind(since, until)
      .all<DeviceRow>(),
    env.DB.prepare("SELECT MIN(day) AS since FROM analytics_visit").first<{
      since: string | null;
    }>(),
  ]);

  // Days with no traffic simply do not come back from SQLite. The chart needs a
  // point per day, so the gap is filled here instead of on the client.
  const pointsByDay = new Map(seriesResult.results.map((row) => [row.day, row]));
  const series: AnalyticsPoint[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = shiftDay(since, offset);
    const row = pointsByDay.get(day);
    series.push({ day, pageViews: row?.pageViews ?? 0, visitors: row?.visitors ?? 0 });
  }

  // Rows are written by this module, so a value outside the enum means a row
  // was tampered with; drop it rather than widen the contract.
  const sources: AnalyticsSourceRow[] = sourceResult.results.flatMap((row) =>
    isAnalyticsSource(row.source)
      ? [{ source: row.source, pageViews: row.pageViews, visitors: row.visitors }]
      : [],
  );
  const referrers: AnalyticsReferrerRow[] = referrerResult.results.flatMap((row) =>
    row.host && isAnalyticsSource(row.source)
      ? [{ host: row.host, source: row.source, pageViews: row.pageViews }]
      : [],
  );
  const campaigns: AnalyticsCampaignRow[] = campaignResult.results.flatMap((row) =>
    row.name
      ? [{ name: row.name, source: row.source, medium: row.medium, pageViews: row.pageViews }]
      : [],
  );
  const pages: AnalyticsPageRow[] = pageResult.results.map((row) => ({
    path: row.path,
    pageViews: row.pageViews,
    visitors: row.visitors,
  }));
  const countries: AnalyticsCountryRow[] = countryResult.results.map((row) => ({
    country: row.country,
    pageViews: row.pageViews,
  }));
  const devices: AnalyticsDeviceRow[] = deviceResult.results.flatMap((row) =>
    isAnalyticsDevice(row.device) ? [{ device: row.device, pageViews: row.pageViews }] : [],
  );

  const totals: AnalyticsTotals = {
    pageViews: totalsRow?.pageViews ?? 0,
    visitors: totalsRow?.visitors ?? 0,
  };

  return {
    range: { days, since, until },
    totals,
    previous: {
      pageViews: previousRow?.pageViews ?? 0,
      visitors: previousRow?.visitors ?? 0,
    },
    series,
    sources,
    referrers,
    campaigns,
    pages,
    countries,
    devices,
    historyStartsAt: historyRow?.since ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                  */
/* -------------------------------------------------------------------------- */

/** Hard floor on retention: a mis-set variable must not empty the dashboard. */
const MIN_RETENTION_DAYS = 7;

const DEFAULT_RETENTION_DAYS = 180;

/**
 * Delete visits older than the retention window and report how many went.
 *
 * The floor exists because `ANALYTICS_RETENTION_DAYS` is an operator-facing
 * string: a typo ("7d", "0") would otherwise wipe the whole history on the next
 * cron tick, and there is no backup to restore it from.
 */
export async function purgeExpiredAnalytics(params: {
  env: Env;
  retentionDays?: number;
}): Promise<number> {
  const configured =
    params.retentionDays ??
    readRuntimeNumber(params.env, "ANALYTICS_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  const retentionDays = Math.max(MIN_RETENTION_DAYS, Math.floor(configured));
  // Keep `retentionDays` days including today, so the oldest kept day is the
  // one below.
  const oldestKeptDay = shiftDay(analyticsDay(params.env, new Date()), 1 - retentionDays);

  const result = await params.env.DB.prepare("DELETE FROM analytics_visit WHERE day < ?")
    .bind(oldestKeptDay)
    .run();
  const deleted = result.meta.changes ?? 0;
  if (deleted > 0) logEvent("info", "analytics.purged", { deleted, retentionDays });
  return deleted;
}
