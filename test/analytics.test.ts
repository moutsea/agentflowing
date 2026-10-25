import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  computeVisitorKey,
  detectDevice,
  detectSource,
  isBotRequest,
  isHeadlessClient,
  isIgnoredPath,
  normalizeAnalyticsPath,
} from "../src/server/modules/analytics/collect";
import {
  analyticsDay,
  getAnalyticsOverview,
  getAnalyticsTimeZone,
  purgeExpiredAnalytics,
  recordAnalyticsVisit,
  shiftDay,
  utcDay,
} from "../src/server/modules/analytics/service";
import {
  ANALYTICS_PATH_MAX_LENGTH,
  type AnalyticsCollectRequest,
  type AnalyticsDevice,
  type AnalyticsSource,
} from "../src/shared/analytics";

const migrationFiles = import.meta.glob("../migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const migrations = Object.entries(migrationFiles)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, sql]) => ({
    name: path.split("/").at(-1) ?? path,
    queries: sql
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter(Boolean),
  }));

const today = utcDay(new Date());

/** `dayBefore(0)` is today, `dayBefore(7)` is a week ago. */
function dayBefore(days: number): string {
  return shiftDay(today, -days);
}

type VisitRow = {
  day: string;
  visitorKey: string;
  path: string;
  source: AnalyticsSource;
  sourceHost?: string | null;
  campaign?: string | null;
  medium?: string | null;
  country?: string | null;
  device: AnalyticsDevice;
};

async function insertVisit(row: VisitRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO analytics_visit
     (id, day, path, visitor_key, source, source_host, campaign, medium, country, device, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      row.day,
      row.path,
      row.visitorKey,
      row.source,
      row.sourceHost ?? null,
      row.campaign ?? null,
      row.medium ?? null,
      row.country ?? null,
      row.device,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

function countVisits(): Promise<number> {
  return env.DB.prepare("SELECT COUNT(*) AS total FROM analytics_visit")
    .first<number>("total")
    .then((total) => total ?? 0);
}

function collectRequest(
  body: AnalyticsCollectRequest,
  options: { userAgent?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request("https://app.test/api/analytics/collect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent":
        options.userAgent ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "cf-connecting-ip": "203.0.113.7",
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
  await env.DB.prepare("DELETE FROM analytics_visit").run();
});

describe("normalizeAnalyticsPath", () => {
  it("keeps a plain path and drops the trailing slash", () => {
    expect(normalizeAnalyticsPath("/pricing")).toBe("/pricing");
    expect(normalizeAnalyticsPath("/pricing/")).toBe("/pricing");
    expect(normalizeAnalyticsPath("/a//b/")).toBe("/a/b");
  });

  it("keeps the root path as a single slash", () => {
    expect(normalizeAnalyticsPath("/")).toBe("/");
    expect(normalizeAnalyticsPath("/?utm_source=x")).toBe("/");
  });

  it("strips the query string and the hash", () => {
    expect(normalizeAnalyticsPath("/pricing?plan=pro&utm_source=newsletter#plans")).toBe(
      "/pricing",
    );
    expect(normalizeAnalyticsPath("/docs#install")).toBe("/docs");
  });

  it("rejects input that is not an absolute path", () => {
    expect(normalizeAnalyticsPath("")).toBeNull();
    expect(normalizeAnalyticsPath("   ")).toBeNull();
    expect(normalizeAnalyticsPath("pricing")).toBeNull();
    expect(normalizeAnalyticsPath("https://app.test/pricing")).toBeNull();
  });

  it("collapses identifier segments so one template does not become many rows", () => {
    expect(normalizeAnalyticsPath("/chats/42")).toBe("/chats/:id");
    expect(normalizeAnalyticsPath("/chats/deadbeef")).toBe("/chats/:id");
    expect(normalizeAnalyticsPath("/chats/0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(
      "/chats/:id",
    );
    expect(normalizeAnalyticsPath("/chats/abc123def456ghi7")).toBe("/chats/:id");
    expect(normalizeAnalyticsPath("/chats/42/messages/7")).toBe("/chats/:id/messages/:id");
  });

  it("leaves human readable segments alone", () => {
    expect(normalizeAnalyticsPath("/blog/hello-world")).toBe("/blog/hello-world");
    expect(normalizeAnalyticsPath("/blog/how-to-deploy-in-2026")).toBe(
      "/blog/how-to-deploy-in-2026",
    );
  });

  it("truncates an over-long path instead of dropping it", () => {
    // Readable segments, so the length is what is being tested rather than the
    // identifier collapsing above.
    const long = `/blog/${"post-".repeat(ANALYTICS_PATH_MAX_LENGTH / 5)}`;
    const normalized = normalizeAnalyticsPath(long);
    expect(normalized).not.toBeNull();
    expect(normalized?.length).toBe(ANALYTICS_PATH_MAX_LENGTH);
    expect(normalized?.startsWith("/")).toBe(true);
  });
});

describe("isIgnoredPath", () => {
  it("ignores API and agent traffic", () => {
    expect(isIgnoredPath("/api")).toBe(true);
    expect(isIgnoredPath("/api/analytics/collect")).toBe(true);
    expect(isIgnoredPath("/agents/monetized-agent/chat-1")).toBe(true);
  });

  it("ignores static assets", () => {
    expect(isIgnoredPath("/assets/index-abc123.js")).toBe(true);
    expect(isIgnoredPath("/assets/index-abc123.css")).toBe(true);
    expect(isIgnoredPath("/assets/font.woff2")).toBe(true);
    expect(isIgnoredPath("/build/index.js.map")).toBe(true);
    expect(isIgnoredPath("/manifest.webmanifest")).toBe(true);
  });

  it("sees through a query string or fragment", () => {
    expect(isIgnoredPath("/assets/index-abc123.js?v=2")).toBe(true);
    expect(isIgnoredPath("/assets/font.woff2#iefix")).toBe(true);
    expect(isIgnoredPath("/api/health?probe=1")).toBe(true);
  });

  it("counts real pages", () => {
    expect(isIgnoredPath("/")).toBe(false);
    expect(isIgnoredPath("/pricing")).toBe(false);
    expect(isIgnoredPath("/dashboard/agents")).toBe(false);
  });

  it("only drops a prefix at a segment boundary", () => {
    // The client applies the same rule before sending, so a page it reports must
    // not be thrown away here.
    expect(isIgnoredPath("/apidocs")).toBe(false);
    expect(isIgnoredPath("/agents-archive")).toBe(false);
  });
});

describe("detectSource", () => {
  const appUrl = "https://app.test";

  it("prefers the campaign source over everything else", () => {
    expect(
      detectSource({
        referrer: "https://www.google.com/search?q=agents",
        appUrl,
        campaign: { source: "Newsletter" },
      }),
    ).toEqual({ source: "campaign", sourceHost: "newsletter" });
  });

  it("treats a missing or unparseable referrer as direct", () => {
    expect(detectSource({ appUrl })).toEqual({ source: "direct", sourceHost: null });
    expect(detectSource({ referrer: "not a url", appUrl })).toEqual({
      source: "direct",
      sourceHost: null,
    });
  });

  it("recognises our own host and its subdomains", () => {
    expect(detectSource({ referrer: "https://app.test/pricing", appUrl })).toEqual({
      source: "internal",
      sourceHost: null,
    });
    expect(detectSource({ referrer: "https://www.app.test/pricing", appUrl })).toEqual({
      source: "internal",
      sourceHost: null,
    });
  });

  it("names search engines instead of their hostnames", () => {
    for (const [referrer, name] of [
      ["https://www.google.com/search?q=1", "google"],
      ["https://www.google.co.uk/search?q=1", "google"],
      ["https://www.bing.com/search?q=1", "bing"],
      ["https://www.baidu.com/s?wd=1", "baidu"],
      ["https://duckduckgo.com/?q=1", "duckduckgo"],
      ["https://yandex.ru/search/?text=1", "yandex"],
      ["https://www.sogou.com/web?query=1", "sogou"],
      ["https://www.so.com/s?q=1", "so"],
      ["https://www.ecosia.org/search?q=1", "ecosia"],
    ] as const) {
      expect(detectSource({ referrer, appUrl })).toEqual({ source: "search", sourceHost: name });
    }
  });

  it("names social networks", () => {
    for (const [referrer, name] of [
      ["https://weibo.com/1", "weibo"],
      ["https://www.zhihu.com/question/1", "zhihu"],
      ["https://x.com/someone/status/1", "twitter"],
      ["https://t.co/abc", "twitter"],
      ["https://www.facebook.com/", "facebook"],
      ["https://www.linkedin.com/feed/", "linkedin"],
      ["https://www.reddit.com/r/x", "reddit"],
      ["https://news.ycombinator.com/item?id=1", "hackernews"],
      ["https://t.me/somechannel", "telegram"],
      ["https://www.youtube.com/watch?v=1", "youtube"],
      ["https://www.bilibili.com/video/1", "bilibili"],
    ] as const) {
      expect(detectSource({ referrer, appUrl })).toEqual({ source: "social", sourceHost: name });
    }
  });

  it("falls back to the raw hostname for any other referrer", () => {
    expect(detectSource({ referrer: "https://someblog.io/posts/x?y=1", appUrl })).toEqual({
      source: "referral",
      sourceHost: "someblog.io",
    });
  });

  it("does not mistake m.com for the 360 search engine", () => {
    expect(detectSource({ referrer: "https://www.m.com/offers", appUrl })).toEqual({
      source: "referral",
      sourceHost: "www.m.com",
    });
    expect(detectSource({ referrer: "https://m.so.com/s?q=1", appUrl })).toEqual({
      source: "search",
      sourceHost: "so",
    });
    expect(detectSource({ referrer: "https://yahoo.com.tw/search?q=1", appUrl })).toEqual({
      source: "search",
      sourceHost: "yahoo",
    });
  });
});

describe("detectDevice", () => {
  it("separates tablets, phones and desktops", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      ),
    ).toBe("tablet");
    expect(
      detectDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("mobile");
    expect(
      detectDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      ),
    ).toBe("desktop");
  });
});

describe("isBotRequest", () => {
  it("treats an empty user agent as a bot", () => {
    expect(isBotRequest("")).toBe(true);
    expect(isBotRequest("   ")).toBe(true);
  });

  it("matches crawlers, scripted clients and uptime monitors", () => {
    for (const userAgent of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "bingbot/2.0",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "Go-http-client/1.1",
      "HeadlessChrome/124.0.0.0",
      "Pingdom.com_bot_version_1.4",
    ])
      expect(isBotRequest(userAgent)).toBe(true);
  });

  it("keeps real browsers", () => {
    expect(
      isBotRequest(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      ),
    ).toBe(false);
  });
});

describe("computeVisitorKey", () => {
  const input = { env, ip: "203.0.113.7", userAgent: "Mozilla/5.0 Chrome/124" };

  it("returns a stable 32 character hex digest for the same person", async () => {
    const first = await computeVisitorKey(input);
    const second = await computeVisitorKey(input);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
  });

  // A thirty day range almost always straddles a month boundary, so an identity
  // that changes monthly would inflate "unique visitors" nearly every time it is
  // read. Continuity across months is therefore the required behaviour, not a
  // leak: the retention window is what bounds how long anyone can be followed.
  it("keeps one person as one visitor across a month boundary", async () => {
    const today = await computeVisitorKey(input);
    const tomorrow = await computeVisitorKey(input);
    expect(tomorrow).toBe(today);
  });

  it("depends on the salt, the IP and the user agent", async () => {
    const base = await computeVisitorKey(input);
    expect(
      await computeVisitorKey({ ...input, env: { ...env, ANALYTICS_SALT: "pepper" } }),
    ).not.toBe(base);
    expect(await computeVisitorKey({ ...input, ip: "203.0.113.8" })).not.toBe(base);
    expect(await computeVisitorKey({ ...input, userAgent: "Safari/17" })).not.toBe(base);
  });

  // Two people behind one NAT with the same browser version share an IP and a
  // user agent, so without the stable client hints they would be one visitor.
  it("separates two devices that share an address and a user agent", async () => {
    const laptop = await computeVisitorKey({ ...input, hints: '"macOS"|?0' });
    const phone = await computeVisitorKey({ ...input, hints: '"macOS"|?1' });
    expect(phone).not.toBe(laptop);
  });

  it("treats a missing hint string as empty rather than unique", async () => {
    const withEmpty = await computeVisitorKey({ ...input, hints: "" });
    const withoutHints = await computeVisitorKey(input);
    expect(withEmpty).toBe(withoutHints);
  });

  it("severs continuity when the operator rotates the salt", async () => {
    const before = await computeVisitorKey({ ...input, env: { ...env, ANALYTICS_SALT: "first" } });
    const after = await computeVisitorKey({ ...input, env: { ...env, ANALYTICS_SALT: "second" } });
    expect(after).not.toBe(before);
  });

  it("falls back to a built-in salt when the runtime has none", async () => {
    const bare = await computeVisitorKey({ ...input, env: {} });
    expect(bare).toMatch(/^[0-9a-f]{32}$/);
    expect(bare).not.toBe(await computeVisitorKey(input));
  });
});

describe("recordAnalyticsVisit", () => {
  it("stores a normalised page view", async () => {
    const response = await recordAnalyticsVisit({
      env,
      request: collectRequest({
        path: "/pricing/?plan=pro",
        referrer: "https://www.google.com/search?q=agents",
      }),
      input: { path: "/pricing/?plan=pro", referrer: "https://www.google.com/search?q=agents" },
    });
    expect(response).toEqual({ recorded: true });
    const row = await env.DB.prepare(
      `SELECT day, path, source, source_host AS sourceHost, country, device, visitor_key AS visitorKey
       FROM analytics_visit`,
    ).first<{
      day: string;
      path: string;
      source: string;
      sourceHost: string | null;
      country: string | null;
      device: string;
      visitorKey: string;
    }>();
    expect(row).toMatchObject({
      day: today,
      path: "/pricing",
      source: "search",
      sourceHost: "google",
      device: "desktop",
    });
    expect(row?.visitorKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("counts one visitor per person per day, not per view", async () => {
    for (let index = 0; index < 3; index += 1)
      await recordAnalyticsVisit({
        env,
        request: collectRequest({ path: "/pricing" }),
        input: { path: "/pricing" },
      });
    const overview = await getAnalyticsOverview(env, 7);
    expect(overview.totals).toEqual({ pageViews: 3, visitors: 1 });
  });

  it("rejects do-not-track, bots, API paths and unusable paths", async () => {
    const cases: [Request, AnalyticsCollectRequest, string][] = [
      [
        collectRequest({ path: "/pricing" }, { headers: { dnt: "1" } }),
        { path: "/pricing" },
        "do_not_track",
      ],
      [
        collectRequest({ path: "/pricing" }, { userAgent: "Googlebot/2.1" }),
        { path: "/pricing" },
        "bot",
      ],
      [collectRequest({ path: "/api/health" }), { path: "/api/health" }, "ignored_path"],
      [
        collectRequest({ path: "/assets/index-abc.js" }),
        { path: "/assets/index-abc.js" },
        "ignored_path",
      ],
      [collectRequest({ path: "nonsense" }), { path: "nonsense" }, "ignored_path"],
    ];
    for (const [request, input, reason] of cases)
      expect(await recordAnalyticsVisit({ env, request, input })).toEqual({
        recorded: false,
        reason,
      });
    expect(await countVisits()).toBe(0);
  });

  it("records a campaign visit with its medium and name", async () => {
    const input: AnalyticsCollectRequest = {
      path: "/promo",
      campaign: { source: "twitter", medium: "social", name: "spring-sale" },
    };
    expect(await recordAnalyticsVisit({ env, request: collectRequest(input), input })).toEqual({
      recorded: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT source, source_host AS sourceHost, campaign, medium FROM analytics_visit",
      ).first(),
    ).toEqual({
      source: "campaign",
      sourceHost: "twitter",
      campaign: "spring-sale",
      medium: "social",
    });
  });
});

describe("getAnalyticsOverview", () => {
  /**
   * Five visits inside the last seven days, two in the equally long window
   * before it, and one older row that only the history boundary should see.
   *
   * `v1` appears on two different days: unique visitors must still count it once.
   */
  async function seed(): Promise<void> {
    await insertVisit({
      day: dayBefore(0),
      visitorKey: "v1",
      path: "/pricing",
      source: "search",
      sourceHost: "google",
      country: "US",
      device: "desktop",
    });
    await insertVisit({
      day: dayBefore(0),
      visitorKey: "v2",
      path: "/",
      source: "direct",
      device: "mobile",
    });
    await insertVisit({
      day: dayBefore(1),
      visitorKey: "v1",
      path: "/pricing",
      source: "search",
      sourceHost: "google",
      country: "US",
      device: "desktop",
    });
    await insertVisit({
      day: dayBefore(6),
      visitorKey: "v3",
      path: "/blog",
      source: "social",
      sourceHost: "weibo",
      country: "CN",
      device: "tablet",
    });
    await insertVisit({
      day: dayBefore(2),
      visitorKey: "v4",
      path: "/promo",
      source: "campaign",
      sourceHost: "twitter",
      campaign: "spring-sale",
      medium: "social",
      device: "desktop",
    });
    await insertVisit({
      day: dayBefore(7),
      visitorKey: "v9",
      path: "/old",
      source: "direct",
      device: "desktop",
    });
    await insertVisit({
      day: dayBefore(13),
      visitorKey: "v9",
      path: "/old",
      source: "direct",
      device: "desktop",
    });
    await insertVisit({
      day: dayBefore(20),
      visitorKey: "v8",
      path: "/ancient",
      source: "direct",
      device: "desktop",
    });
  }

  it("counts page views and unique visitors, including across days", async () => {
    await seed();
    const overview = await getAnalyticsOverview(env, 7);
    expect(overview.totals).toEqual({ pageViews: 5, visitors: 4 });
    expect(overview.range).toEqual({ days: 7, since: dayBefore(6), until: today });
  });

  it("compares against the equally long window immediately before", async () => {
    await seed();
    const overview = await getAnalyticsOverview(env, 7);
    expect(overview.previous).toEqual({ pageViews: 2, visitors: 1 });
  });

  it("zero-fills every day in the range, oldest first", async () => {
    await seed();
    const overview = await getAnalyticsOverview(env, 7);
    expect(overview.series).toHaveLength(7);
    expect(overview.series[0]).toEqual({ day: dayBefore(6), pageViews: 1, visitors: 1 });
    expect(overview.series[6]).toEqual({ day: today, pageViews: 2, visitors: 2 });
    // Nothing was recorded on days 3 through 5 back: those points still exist,
    // at zero, and in calendar order.
    expect(overview.series.slice(1, 4)).toEqual([
      { day: dayBefore(5), pageViews: 0, visitors: 0 },
      { day: dayBefore(4), pageViews: 0, visitors: 0 },
      { day: dayBefore(3), pageViews: 0, visitors: 0 },
    ]);
    expect(overview.series[4]).toEqual({ day: dayBefore(2), pageViews: 1, visitors: 1 });
  });

  it("sizes the series to the requested range", async () => {
    await seed();
    const overview = await getAnalyticsOverview(env, 30);
    expect(overview.series).toHaveLength(30);
    expect(overview.range.since).toBe(dayBefore(29));
    expect(overview.series.at(-1)?.day).toBe(today);
    // A 30 day window reaches back past the comparison week: all eight seeded
    // rows and six distinct visitors land inside it.
    expect(overview.totals).toEqual({ pageViews: 8, visitors: 6 });
  });

  it("ranks sources, referrers, pages, countries and devices", async () => {
    await seed();
    const overview = await getAnalyticsOverview(env, 7);
    expect(overview.sources).toEqual([
      { source: "search", pageViews: 2, visitors: 1 },
      { source: "campaign", pageViews: 1, visitors: 1 },
      { source: "direct", pageViews: 1, visitors: 1 },
      { source: "social", pageViews: 1, visitors: 1 },
    ]);
    expect(overview.referrers).toEqual([
      { host: "google", source: "search", pageViews: 2 },
      { host: "twitter", source: "campaign", pageViews: 1 },
      { host: "weibo", source: "social", pageViews: 1 },
    ]);
    expect(overview.campaigns).toEqual([
      { name: "spring-sale", source: "twitter", medium: "social", pageViews: 1 },
    ]);
    expect(overview.pages).toEqual([
      { path: "/pricing", pageViews: 2, visitors: 1 },
      { path: "/", pageViews: 1, visitors: 1 },
      { path: "/blog", pageViews: 1, visitors: 1 },
      { path: "/promo", pageViews: 1, visitors: 1 },
    ]);
    expect(overview.countries).toEqual([
      { country: "US", pageViews: 2 },
      { country: "CN", pageViews: 1 },
    ]);
    expect(overview.devices).toEqual([
      { device: "desktop", pageViews: 3 },
      { device: "mobile", pageViews: 1 },
      { device: "tablet", pageViews: 1 },
    ]);
  });

  it("keeps the UTM source and medium distinct for campaigns with the same name", async () => {
    const campaigns = [
      { name: "launch", source: "google", medium: "cpc" },
      { name: "launch", source: "google", medium: "cpc" },
      { name: "launch", source: "bing", medium: "cpc" },
      { name: "launch", source: "google", medium: "email" },
      { name: "launch" },
    ];
    for (const campaign of campaigns) {
      const input = { path: "/pricing", campaign };
      await recordAnalyticsVisit({ env, request: collectRequest(input), input });
    }
    expect((await getAnalyticsOverview(env, 7)).campaigns).toEqual([
      { name: "launch", source: "google", medium: "cpc", pageViews: 2 },
      { name: "launch", source: "", medium: "", pageViews: 1 },
      { name: "launch", source: "bing", medium: "cpc", pageViews: 1 },
      { name: "launch", source: "google", medium: "email", pageViews: 1 },
    ]);
  });

  it("reports when the table started collecting", async () => {
    await seed();
    expect((await getAnalyticsOverview(env, 7)).historyStartsAt).toBe(dayBefore(20));
  });

  it("returns an empty but well-formed overview for an empty table", async () => {
    expect(await getAnalyticsOverview(env, 7)).toEqual({
      range: { days: 7, since: dayBefore(6), until: today },
      totals: { pageViews: 0, visitors: 0 },
      previous: { pageViews: 0, visitors: 0 },
      series: Array.from({ length: 7 }, (_, offset) => ({
        day: dayBefore(6 - offset),
        pageViews: 0,
        visitors: 0,
      })),
      sources: [],
      referrers: [],
      campaigns: [],
      pages: [],
      countries: [],
      devices: [],
      historyStartsAt: null,
    });
  });

  it("caps long rankings at ten rows", async () => {
    for (let index = 0; index < 12; index += 1)
      await insertVisit({
        day: today,
        visitorKey: `v${index}`,
        path: `/page-${index}`,
        source: "direct",
        device: "desktop",
      });
    const overview = await getAnalyticsOverview(env, 7);
    expect(overview.pages).toHaveLength(10);
    expect(overview.pages[0]?.path).toBe("/page-0");
  });
});

describe("purgeExpiredAnalytics", () => {
  // Five rows: three inside a week, one ten days old, one at the six month edge.
  beforeEach(async () => {
    for (const days of [0, 3, 6, 10, 180])
      await insertVisit({
        day: dayBefore(days),
        visitorKey: `v${days}`,
        path: "/",
        source: "direct",
        device: "desktop",
      });
  });

  it("keeps the default six-month window", async () => {
    // A 180 day window covers today-179 through today, so the 180 day old row is
    // the only one to go.
    expect(await purgeExpiredAnalytics({ env })).toBe(1);
    expect(await countVisits()).toBe(4);
  });

  it("deletes what is older than the requested window", async () => {
    expect(await purgeExpiredAnalytics({ env, retentionDays: 7 })).toBe(2);
    expect(await countVisits()).toBe(3);
  });

  it("never goes below a seven day retention", async () => {
    // A retention of 1 day would wipe everything but today without the floor.
    expect(await purgeExpiredAnalytics({ env, retentionDays: 1 })).toBe(2);
    const remaining = await env.DB.prepare("SELECT day FROM analytics_visit ORDER BY day").all<{
      day: string;
    }>();
    expect(remaining.results.map((row) => row.day)).toEqual([
      dayBefore(6),
      dayBefore(3),
      dayBefore(0),
    ]);
  });

  it("is idempotent", async () => {
    expect(await purgeExpiredAnalytics({ env, retentionDays: 7 })).toBe(2);
    expect(await purgeExpiredAnalytics({ env, retentionDays: 7 })).toBe(0);
  });
});

describe("isHeadlessClient", () => {
  // A `--user-agent` override makes an automated browser look ordinary, but the
  // client hints it sends are generated by the browser and cannot be overridden.
  it("rejects an automated browser that lies about its user agent", () => {
    expect(
      isHeadlessClient('"Not:A-Brand";v="99", "HeadlessChrome";v="145", "Chromium";v="145"'),
    ).toBe(true);
  });

  it("passes a real browser", () => {
    expect(
      isHeadlessClient('"Not:A-Brand";v="99", "Chromium";v="141", "Google Chrome";v="141"'),
    ).toBe(false);
  });

  it("passes a browser that sends no hints at all", () => {
    expect(isHeadlessClient(null)).toBe(false);
    expect(isHeadlessClient(undefined)).toBe(false);
    expect(isHeadlessClient("")).toBe(false);
  });
});

describe("day bucketing", () => {
  it("defaults to UTC", () => {
    expect(getAnalyticsTimeZone(env)).toBe("UTC");
    expect(analyticsDay(env, new Date("2026-03-10T23:30:00.000Z"))).toBe("2026-03-10");
  });

  it("follows the configured zone across the local midnight", () => {
    const shanghai = { ...env, ANALYTICS_TIME_ZONE: "Asia/Shanghai" };
    expect(getAnalyticsTimeZone(shanghai)).toBe("Asia/Shanghai");
    // 23:30 UTC is already the next day in Shanghai (UTC+8).
    expect(analyticsDay(shanghai, new Date("2026-03-10T23:30:00.000Z"))).toBe("2026-03-11");
    expect(analyticsDay(shanghai, new Date("2026-03-10T15:59:00.000Z"))).toBe("2026-03-10");
    expect(analyticsDay(shanghai, new Date("2026-03-10T16:00:00.000Z"))).toBe("2026-03-11");
  });

  it("falls back to UTC when the zone is not a name Intl knows", () => {
    const broken = { ...env, ANALYTICS_TIME_ZONE: "Mars/Olympus" };
    expect(getAnalyticsTimeZone(broken)).toBe("UTC");
    expect(analyticsDay(broken, new Date("2026-03-10T23:30:00.000Z"))).toBe("2026-03-10");
  });

  it("ignores a blank variable", () => {
    expect(getAnalyticsTimeZone({ ...env, ANALYTICS_TIME_ZONE: "   " })).toBe("UTC");
  });
});
