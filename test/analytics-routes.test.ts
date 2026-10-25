import { applyD1Migrations, createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/server";
import { shiftDay, utcDay } from "../src/server/modules/analytics/service";
import { DEFAULT_ANALYTICS_RANGE, type AnalyticsOverview } from "../src/shared/analytics";

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

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/**
 * `SELF` binds the environment from wrangler.jsonc, where
 * `PLATFORM_ADMIN_USER_IDS` is empty — so every signed-in request through it is
 * a non-admin. Reaching the dashboard therefore has to go through `app.fetch`
 * with a real administrator id, which is what `request()` is for.
 */
function request(
  path: string,
  options: {
    cookie?: string;
    adminId?: string;
    method?: string;
    body?: unknown;
    userAgent?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const runtime = { ...env, PLATFORM_ADMIN_USER_IDS: options.adminId ?? "" };
  return app.fetch(
    new Request(`${env.APP_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        origin: env.APP_URL,
        "user-agent": options.userAgent ?? BROWSER_UA,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    runtime,
    createExecutionContext(),
  );
}

async function signUp(): Promise<{ cookie: string; userId: string }> {
  const response = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      name: "Analytics Admin",
      email: `analytics-${crypto.randomUUID()}@example.com`,
      password: "correct-horse-battery-staple",
    },
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { user: { id: string } };
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  expect(cookie).not.toBe("");
  return { cookie, userId: payload.user.id };
}

function beacon(body: unknown, options: { headers?: Record<string, string> } = {}) {
  return SELF.fetch(`${env.APP_URL}/api/analytics/collect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": BROWSER_UA,
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

async function insertVisit(day: string, visitorKey: string, path: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO analytics_visit
     (id, day, path, visitor_key, source, source_host, campaign, medium, country, device, created_at)
     VALUES (?, ?, ?, ?, 'direct', NULL, NULL, NULL, NULL, 'desktop', ?)`,
  )
    .bind(crypto.randomUUID(), day, path, visitorKey, Math.floor(Date.now() / 1000))
    .run();
}

async function countVisits(): Promise<number> {
  const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM analytics_visit").first<number>(
    "total",
  );
  return total ?? 0;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
  // D1 state survives between tests in a file, and the beacon writes rows the
  // dashboard assertions would otherwise count.
  await env.DB.prepare("DELETE FROM analytics_visit").run();
});

describe("analytics collection", () => {
  it("accepts an anonymous beacon and stores the visit", async () => {
    const response = await beacon({ path: "/pricing/?plan=pro" });
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { recorded: true } });

    const row = await env.DB.prepare(
      "SELECT day, path, source, source_host AS sourceHost, device FROM analytics_visit",
    ).first();
    expect(row).toEqual({
      day: today,
      path: "/pricing",
      source: "direct",
      sourceHost: null,
      device: "desktop",
    });
  });

  it("exposes exactly one beacon path", async () => {
    // `/api/analytics` itself is deliberately not a write target: it falls
    // through to the authenticated `/api` router, and nothing is recorded.
    const response = await SELF.fetch(`${env.APP_URL}/api/analytics`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
      body: JSON.stringify({ path: "/" }),
    });
    expect(response.status).toBe(401);
    expect(await countVisits()).toBe(0);
  });

  it("accepts a campaign without a session", async () => {
    const response = await beacon({
      path: "/promo",
      campaign: { source: "twitter", medium: "social", name: "spring-sale" },
    });
    expect(response.status).toBe(202);
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

  it("skips bots, ignored paths and do-not-track visitors", async () => {
    expect(
      await (
        await beacon({ path: "/pricing" }, { headers: { "user-agent": "Googlebot/2.1" } })
      ).json(),
    ).toEqual({
      data: { recorded: false, reason: "bot" },
    });
    // An automated browser can override its user agent but not its client
    // hints, so a convincing UA is not enough to get counted.
    expect(
      await (
        await beacon(
          { path: "/pricing" },
          {
            headers: {
              "user-agent": BROWSER_UA,
              "sec-ch-ua": '"Not:A-Brand";v="99", "HeadlessChrome";v="145"',
            },
          },
        )
      ).json(),
    ).toEqual({
      data: { recorded: false, reason: "bot" },
    });
    expect(await countVisits()).toBe(0);
    expect(await (await beacon({ path: "/api/health" })).json()).toEqual({
      data: { recorded: false, reason: "ignored_path" },
    });
    expect(await (await beacon({ path: "/assets/index-abc.js" })).json()).toEqual({
      data: { recorded: false, reason: "ignored_path" },
    });
    expect(await (await beacon({ path: "/pricing" }, { headers: { dnt: "1" } })).json()).toEqual({
      data: { recorded: false, reason: "do_not_track" },
    });
    expect(await countVisits()).toBe(0);
  });

  it("rejects a payload it cannot use", async () => {
    const empty = await beacon({});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "invalid_payload" });

    const tooLong = await beacon({ path: `/${"a".repeat(600)}` });
    expect(tooLong.status).toBe(400);

    const unknownCampaignKey = await beacon({ path: "/pricing", campaign: { utm: "x" } });
    expect(unknownCampaignKey.status).toBe(400);

    const noBody = await SELF.fetch(`${env.APP_URL}/api/analytics/collect`, {
      method: "POST",
      headers: { "user-agent": BROWSER_UA },
    });
    expect(noBody.status).toBe(400);
    expect(await countVisits()).toBe(0);
  });

  it("refuses an oversized payload before writing", async () => {
    const response = await beacon({ path: "/pricing", referrer: "a".repeat(5 * 1024) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "payload_too_large" });
    expect(await countVisits()).toBe(0);
  });

  it("refuses a beacon posted by another site", async () => {
    const foreign = await beacon(
      { path: "/pricing" },
      { headers: { origin: "https://someone-else.example" } },
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: "forbidden" });
    expect(await countVisits()).toBe(0);

    // A same-origin beacon is what the app actually sends, and must still work.
    const own = await beacon({ path: "/pricing" }, { headers: { origin: env.APP_URL } });
    expect(own.status).toBe(202);
    expect(await countVisits()).toBe(1);
  });
});

describe("admin analytics dashboard", () => {
  it("requires a session", async () => {
    for (const path of ["/api/admin/analytics", "/api/admin/analytics?days=7"]) {
      const response = await request(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "unauthorized" });
    }
  });

  it("refuses a signed-in user who is not a platform administrator", async () => {
    const user = await signUp();
    // A workspace owner is still not a platform administrator: the allow-list is
    // the only thing that grants this dashboard.
    const response = await request("/api/admin/analytics", { cookie: user.cookie });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });

  it("returns the overview to a platform administrator", async () => {
    const admin = await signUp();
    await insertVisit(today, "v1", "/pricing");
    await insertVisit(shiftDay(today, -1), "v2", "/");

    const response = await request("/api/admin/analytics", {
      cookie: admin.cookie,
      adminId: admin.userId,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { data: AnalyticsOverview };
    // No `days` in the query means the shared default range, not an error.
    expect(body.data.range).toEqual({
      days: DEFAULT_ANALYTICS_RANGE,
      since: shiftDay(today, 1 - DEFAULT_ANALYTICS_RANGE),
      until: today,
    });
    expect(body.data.totals).toEqual({ pageViews: 2, visitors: 2 });
    expect(body.data.series).toHaveLength(DEFAULT_ANALYTICS_RANGE);
    expect(body.data.pages).toEqual([
      { path: "/", pageViews: 1, visitors: 1 },
      { path: "/pricing", pageViews: 1, visitors: 1 },
    ]);
  });

  it("only accepts the offered ranges", async () => {
    const admin = await signUp();
    const call = (query: string) =>
      request(`/api/admin/analytics${query}`, { cookie: admin.cookie, adminId: admin.userId });

    for (const query of ["?days=13", "?days=0", "?days=abc", "?days=7.5"]) {
      const response = await call(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_range" });
    }

    const monthly = await call("?days=30");
    expect(monthly.status).toBe(200);
    const body = (await monthly.json()) as { data: AnalyticsOverview };
    expect(body.data.series).toHaveLength(30);
  });
});
