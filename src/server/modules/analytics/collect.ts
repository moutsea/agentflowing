/**
 * Pure helpers that turn one beacon into the normalized row we store.
 *
 * Nothing in here touches D1: the collector has to be unit-testable, because
 * every rule below is a judgement call (what counts as a bot, which referrer is
 * a search engine) and the only way to keep those honest is to pin them down
 * with tests instead of eyeballing production numbers.
 */

import type { AnalyticsDevice, AnalyticsSource } from "../../../shared/analytics";
import {
  ANALYTICS_CAMPAIGN_MAX_LENGTH,
  ANALYTICS_PATH_MAX_LENGTH,
  isPageViewPath,
} from "../../../shared/analytics";
import { readRuntimeString } from "../../env";
import { logEvent } from "../../observability";

/**
 * Longest `source_host` we bother storing. A DNS name cannot exceed 253 bytes,
 * so this only guards against a hostile `utm_source` reaching the column.
 */
const SOURCE_HOST_MAX_LENGTH = 255;

const FALLBACK_SALT = "agentflowing-analytics";

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** A database row id: `/agents/8f14e45fceea167a` becomes `/agents/:id`. */
const NUMERIC_SEGMENT = /^\d+$/;
const HEX_SEGMENT = /^[0-9a-f]{8,}$/i;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TOKEN_SEGMENT = /^(?=.*[a-z])(?=.*\d)[a-z0-9]{16,}$/i;

function looksLikeId(segment: string): boolean {
  return (
    NUMERIC_SEGMENT.test(segment) ||
    HEX_SEGMENT.test(segment) ||
    UUID_SEGMENT.test(segment) ||
    LONG_TOKEN_SEGMENT.test(segment)
  );
}

/**
 * Reduce a reported pathname to something worth grouping by.
 *
 * `?query` and `#hash` are dropped (they are never part of the page identity),
 * repeated slashes and a trailing slash collapse, and id-looking segments
 * become `:id` so `/chats/123` and `/chats/456` share one dashboard row.
 *
 * Returns `null` for anything that is not a pathname, so the caller can drop
 * the beacon instead of storing a value the dashboard can never show usefully.
 */
export function normalizeAnalyticsPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const cut = trimmed.search(/[?#]/);
  const pathname = cut === -1 ? trimmed : trimmed.slice(0, cut);
  if (!pathname.startsWith("/")) return null;

  const segments = pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (looksLikeId(segment) ? ":id" : segment));
  const normalized = `/${segments.join("/")}`;

  // Truncation happens last so a pathological path still collapses to its
  // canonical prefix rather than to a half-mangled segment list.
  return normalized.length > ANALYTICS_PATH_MAX_LENGTH
    ? normalized.slice(0, ANALYTICS_PATH_MAX_LENGTH)
    : normalized;
}

/**
 * Paths that are never a page view: our own API surface, the agent websocket
 * endpoint, and anything that is really a file. Checked before the path is
 * normalized so `/api/health` is dropped even while it is still a raw string.
 *
 * The rule itself is shared with the client (`isPageViewPath`), because the
 * beacon sender and the beacon receiver disagreeing about what a page is would
 * mean requests that are sent and then silently thrown away.
 */
export function isIgnoredPath(path: string): boolean {
  return !isPageViewPath(path);
}

/* -------------------------------------------------------------------------- */
/* Traffic sources                                                            */
/* -------------------------------------------------------------------------- */

type HostPattern = { name: string; pattern: RegExp };

/**
 * Matched against the lowercased referrer hostname. The stored `source_host` is
 * the engine name rather than the hostname, so `google.co.jp` and `google.com`
 * land in the same dashboard row.
 */
const SEARCH_ENGINES: readonly HostPattern[] = [
  { name: "google", pattern: /^(?:[\w-]+\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/ },
  { name: "bing", pattern: /^(?:[\w-]+\.)?bing\.com$/ },
  { name: "baidu", pattern: /^(?:[\w-]+\.)?baidu\.com$/ },
  { name: "yahoo", pattern: /^(?:[\w-]+\.)?yahoo\.[a-z]{2,}(?:\.[a-z]{2,})?$/ },
  { name: "duckduckgo", pattern: /^(?:[\w-]+\.)?duckduckgo\.com$/ },
  { name: "yandex", pattern: /^(?:[\w-]+\.)?(?:yandex\.[a-z.]+|ya\.ru)$/ },
  { name: "sogou", pattern: /^(?:[\w-]+\.)?sogou\.com$/ },
  // 360 Search (`so.com`), including `www.so.com` and `m.so.com`. Anchored on
  // `so\.com` so `m.com` — a real company — is not swept in as a search engine.
  { name: "so", pattern: /^(?:[\w-]+\.)?so\.com$/ },
  { name: "ecosia", pattern: /^(?:[\w-]+\.)?ecosia\.org$/ },
  { name: "naver", pattern: /^(?:[\w-]+\.)?naver\.com$/ },
  { name: "seznam", pattern: /^(?:[\w-]+\.)?seznam\.cz$/ },
];

/** Same idea, but the stored `source_host` is the network name. */
const SOCIAL_NETWORKS: readonly HostPattern[] = [
  { name: "weibo", pattern: /^(?:[\w-]+\.)?weibo\.(?:com|cn)$/ },
  { name: "zhihu", pattern: /^(?:[\w-]+\.)?zhihu\.com$/ },
  { name: "douyin", pattern: /^(?:[\w-]+\.)?douyin\.com$/ },
  { name: "xiaohongshu", pattern: /^(?:[\w-]+\.)?xiaohongshu\.com$/ },
  // `x.com` shortens to `t.co`, which is the referrer we actually see.
  { name: "twitter", pattern: /^(?:[\w-]+\.)?(?:twitter\.com|x\.com|t\.co)$/ },
  { name: "facebook", pattern: /^(?:[\w-]+\.)?(?:facebook\.com|fb\.me)$/ },
  { name: "instagram", pattern: /^(?:[\w-]+\.)?instagram\.com$/ },
  { name: "linkedin", pattern: /^(?:[\w-]+\.)?linkedin\.com$/ },
  { name: "reddit", pattern: /^(?:[\w-]+\.)?reddit\.com$/ },
  { name: "hackernews", pattern: /^news\.ycombinator\.com$/ },
  { name: "telegram", pattern: /^(?:t\.me|telegram\.me)$/ },
  { name: "youtube", pattern: /^(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)$/ },
  { name: "bilibili", pattern: /^(?:[\w-]+\.)?bilibili\.com$/ },
];

function matchHost(table: readonly HostPattern[], hostname: string): string | null {
  for (const entry of table) {
    if (entry.pattern.test(hostname)) return entry.name;
  }
  return null;
}

function boundHost(value: string): string | null {
  const host = value.trim().toLowerCase().slice(0, SOURCE_HOST_MAX_LENGTH);
  return host || null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Classify where a visit came from.
 *
 * `utm_source` wins over the referrer because a campaign link is deliberately
 * tagged; the referrer alone would credit the network the link was posted on.
 */
export function detectSource(input: {
  referrer?: string;
  appUrl: string;
  campaign?: { source?: string };
}): { source: AnalyticsSource; sourceHost: string | null } {
  const campaignSource = input.campaign?.source?.trim();
  if (campaignSource) {
    return {
      source: "campaign",
      sourceHost: boundHost(campaignSource.slice(0, ANALYTICS_CAMPAIGN_MAX_LENGTH)),
    };
  }

  const referrer = input.referrer?.trim();
  if (!referrer) return { source: "direct", sourceHost: null };

  const hostname = hostOf(referrer);
  if (!hostname) return { source: "direct", sourceHost: null };

  // Our own pages, including any subdomain we serve the app from. Not stored as
  // a referrer: listing our own host in "Top referrers" is pure noise.
  const appHost = hostOf(input.appUrl);
  if (appHost && (hostname === appHost || hostname.endsWith(`.${appHost}`))) {
    return { source: "internal", sourceHost: null };
  }

  const searchEngine = matchHost(SEARCH_ENGINES, hostname);
  if (searchEngine) return { source: "search", sourceHost: searchEngine };

  const socialNetwork = matchHost(SOCIAL_NETWORKS, hostname);
  if (socialNetwork) return { source: "social", sourceHost: socialNetwork };

  return { source: "referral", sourceHost: boundHost(hostname) };
}

/* -------------------------------------------------------------------------- */
/* Device and bot detection                                                   */
/* -------------------------------------------------------------------------- */

/** Order matters: an iPad UA also contains "Mobi"-adjacent tokens elsewhere. */
export function detectDevice(userAgent: string): AnalyticsDevice {
  if (/ipad|tablet|playbook|silk/i.test(userAgent)) return "tablet";
  if (/mobi|android|iphone|ipod|windows phone/i.test(userAgent)) return "mobile";
  return "desktop";
}

const BOT_PATTERN =
  /bot|crawl|spider|slurp|preview|headless|phantom|curl|wget|python-requests|go-http-client|java\/|monitor|uptime|pingdom|lighthouse/i;

/**
 * An empty UA counts as a bot: every real browser sends one, and a blank UA in
 * the logs is a script that did not bother to lie.
 */
export function isBotRequest(userAgent: string): boolean {
  const value = userAgent.trim();
  if (!value) return true;
  return BOT_PATTERN.test(value);
}

/**
 * Catch an automated browser that lies about its user agent.
 *
 * Client hints are generated by the browser itself and are not affected by a
 * `--user-agent` override, so `HeadlessChrome` in `sec-ch-ua` is a signal a
 * plain UA check cannot see. Real browsers never send that token, and browsers
 * that send no hints at all simply pass this check.
 */
export function isHeadlessClient(hints: string | null | undefined): boolean {
  return typeof hints === "string" && /headless/i.test(hints);
}

/* -------------------------------------------------------------------------- */
/* Visitor identity                                                           */
/* -------------------------------------------------------------------------- */

function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * A pseudo-id for a visitor, stable for as long as the salt is.
 *
 * The salt deliberately does NOT rotate on a calendar boundary. Rotating it
 * monthly would slice one person into one identity per month, and since a
 * thirty day range almost always straddles a month boundary (it only does not
 * on the 30th and 31st), the headline "unique visitors" number would be
 * inflated nearly every time it was read. Accuracy of that number is the whole
 * point of the dashboard, so continuity wins here.
 *
 * The privacy bound is deletion, not rotation: rows are removed after
 * `ANALYTICS_RETENTION_DAYS`, so the horizon over which anyone can be followed
 * is finite by construction. An operator who does want a hard reset can change
 * `ANALYTICS_SALT` at any time, which severs continuity from that moment on.
 *
 * `hints` adds the stable client hints (platform and the mobile flag) so two
 * people sharing one address and one user agent do not collapse into a single
 * visitor. Version numbers are left out on purpose: they change on every
 * browser update and would break continuity for a returning visitor.
 *
 * Nothing here is reversible without the salt, and the raw IP is never stored.
 */
export async function computeVisitorKey(input: {
  env: object;
  ip: string;
  userAgent: string;
  hints?: string;
}): Promise<string> {
  const salt = resolveSalt(input.env);
  const material = `${salt}|${input.ip}|${input.userAgent}|${input.hints ?? ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return toHex(digest).slice(0, 32);
}

let reportedSaltFallback = false;

/**
 * The salt, with the fallback made loud.
 *
 * Falling back to `BETTER_AUTH_SECRET` means rotating that secret — which is the
 * standard response to a leak — silently makes every returning visitor look new
 * and spikes the unique-visitor number. Nothing can be done about the rotation
 * itself, but an operator can only connect the two events if it is logged.
 */
function resolveSalt(env: object): string {
  const configured = readRuntimeString(env, "ANALYTICS_SALT");
  if (configured) return configured;
  const authSecret = readRuntimeString(env, "BETTER_AUTH_SECRET");
  if (authSecret) {
    if (!reportedSaltFallback) {
      reportedSaltFallback = true;
      logEvent("warn", "analytics.salt_fallback", {
        detail:
          "Set ANALYTICS_SALT so rotating BETTER_AUTH_SECRET does not reset visitor continuity",
      });
    }
    return authSecret;
  }
  return FALLBACK_SALT;
}
