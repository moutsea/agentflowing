/**
 * Pure rules behind the page view beacon.
 *
 * These live apart from `analytics.ts` so they can be unit-tested in the Worker
 * test pool: nothing here touches `window`, `document` or `navigator`, and every
 * input arrives as an argument. The browser-facing module is then thin glue that
 * only supplies the real values, which is the part that cannot be tested without
 * a browser.
 *
 * 上报规则的纯函数部分单独放在这里：Worker 测试池没有 DOM，把输入变成显式参数
 * 之后，路径过滤、DNT、UTM 解析这些「判断」就能被自动化测试固定下来。
 */
import {
  ANALYTICS_CAMPAIGN_MAX_LENGTH,
  ANALYTICS_PATH_MAX_LENGTH,
  ANALYTICS_REFERRER_MAX_LENGTH,
  isPageViewPath,
  type AnalyticsCollectRequest,
} from "../../shared/analytics";

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Whether this view is worth reporting.
 *
 * The rule lives in `shared/analytics.ts` because the server applies the same
 * one when it decides whether to store the row: a beacon the client sends and
 * the server silently discards is pure waste, and two copies of this judgement
 * would eventually disagree.
 */
export function isTrackablePath(path: string): boolean {
  return isPageViewPath(path);
}

/** Respect Do Not Track, including the legacy `window.doNotTrack` spelling. */
export function isDoNotTrackEnabled(flags: {
  navigatorFlag?: string | null;
  windowFlag?: string | null;
}): boolean {
  return flags.navigatorFlag === "1" || flags.windowFlag === "1";
}

/** Read the `utm_*` parameters of the page that is being reported. */
export function buildCampaign(search: string): AnalyticsCollectRequest["campaign"] {
  const params = new URLSearchParams(search);
  const source = truncate(params.get("utm_source")?.trim() ?? "", ANALYTICS_CAMPAIGN_MAX_LENGTH);
  const medium = truncate(params.get("utm_medium")?.trim() ?? "", ANALYTICS_CAMPAIGN_MAX_LENGTH);
  const name = truncate(params.get("utm_campaign")?.trim() ?? "", ANALYTICS_CAMPAIGN_MAX_LENGTH);
  if (!source && !medium && !name) return undefined;
  const campaign: NonNullable<AnalyticsCollectRequest["campaign"]> = {};
  if (source) campaign.source = source;
  if (medium) campaign.medium = medium;
  if (name) campaign.name = name;
  return campaign;
}

/**
 * The body of one beacon, or `null` when this view must not be reported at all.
 *
 * Every field is bounded here rather than in the caller: the server rejects
 * anything longer, and a dropped beacon is invisible, so the truncation has to
 * happen where it can be tested.
 */
export function buildPageViewPayload(input: {
  path: string;
  referrer: string;
  search: string;
}): AnalyticsCollectRequest | null {
  if (!isTrackablePath(input.path)) return null;

  const payload: AnalyticsCollectRequest = {
    path: truncate(input.path, ANALYTICS_PATH_MAX_LENGTH),
  };
  const referrer = input.referrer.trim();
  if (referrer) payload.referrer = truncate(referrer, ANALYTICS_REFERRER_MAX_LENGTH);
  const campaign = buildCampaign(input.search);
  if (campaign) payload.campaign = campaign;
  return payload;
}
