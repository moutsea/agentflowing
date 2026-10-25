import { describe, expect, it } from "vitest";

import {
  buildCampaign,
  buildPageViewPayload,
  isDoNotTrackEnabled,
  isTrackablePath,
} from "../src/client/lib/analytics-payload";
import {
  ANALYTICS_CAMPAIGN_MAX_LENGTH,
  ANALYTICS_PATH_MAX_LENGTH,
  ANALYTICS_REFERRER_MAX_LENGTH,
} from "../src/shared/analytics";

describe("isTrackablePath", () => {
  it("rejects empty input", () => {
    expect(isTrackablePath("")).toBe(false);
    expect(isTrackablePath("   ")).toBe(false);
  });

  it("ignores the API and agent runtime prefixes", () => {
    expect(isTrackablePath("/api")).toBe(false);
    expect(isTrackablePath("/api/billing/qr")).toBe(false);
    expect(isTrackablePath("/agents")).toBe(false);
    expect(isTrackablePath("/agents/run/42")).toBe(false);
  });

  it("only matches a prefix at a segment boundary", () => {
    // `/apix` and `/agents-archive` are ordinary pages, not the ignored trees.
    expect(isTrackablePath("/apix")).toBe(true);
    expect(isTrackablePath("/agents-archive")).toBe(true);
  });

  it("accepts a normal page", () => {
    expect(isTrackablePath("/")).toBe(true);
    expect(isTrackablePath("/pricing")).toBe(true);
    expect(isTrackablePath("/app/agents/8f14e45fceea167a")).toBe(true);
    expect(isTrackablePath("  /pricing  ")).toBe(true);
  });

  it("rejects a static file the server would discard anyway", () => {
    // Both sides apply one rule, so the client does not pay for a request the
    // collector would drop on arrival.
    expect(isTrackablePath("/assets/index-abc123.js")).toBe(false);
    expect(isTrackablePath("/assets/font.woff2#iefix")).toBe(false);
    expect(isTrackablePath("/apidocs")).toBe(true);
  });
});

describe("isDoNotTrackEnabled", () => {
  it("honours both spellings", () => {
    expect(isDoNotTrackEnabled({ navigatorFlag: "1" })).toBe(true);
    expect(isDoNotTrackEnabled({ windowFlag: "1" })).toBe(true);
  });

  it("stays off for anything else", () => {
    expect(isDoNotTrackEnabled({})).toBe(false);
    expect(isDoNotTrackEnabled({ navigatorFlag: "0", windowFlag: "0" })).toBe(false);
    expect(isDoNotTrackEnabled({ navigatorFlag: null, windowFlag: "yes" })).toBe(false);
  });
});

describe("buildCampaign", () => {
  it("returns nothing when no utm parameter is present", () => {
    expect(buildCampaign("")).toBeUndefined();
    expect(buildCampaign("?ref=newsletter")).toBeUndefined();
  });

  it("keeps only the parameters that were sent", () => {
    expect(buildCampaign("?utm_source=weibo")).toEqual({ source: "weibo" });
  });

  it("reads all three and trims them", () => {
    expect(buildCampaign("?utm_source=%20weibo%20&utm_medium=social&utm_campaign=launch")).toEqual({
      source: "weibo",
      medium: "social",
      name: "launch",
    });
  });

  it("bounds every value to the column width", () => {
    const long = "a".repeat(ANALYTICS_CAMPAIGN_MAX_LENGTH + 40);
    const campaign = buildCampaign(`?utm_source=${long}`);
    expect(campaign?.source).toHaveLength(ANALYTICS_CAMPAIGN_MAX_LENGTH);
  });
});

describe("buildPageViewPayload", () => {
  it("skips a view that must not be reported", () => {
    expect(buildPageViewPayload({ path: "/api/health", referrer: "", search: "" })).toBeNull();
  });

  it("sends the bare path when there is no referrer and no campaign", () => {
    expect(buildPageViewPayload({ path: "/pricing", referrer: "", search: "" })).toEqual({
      path: "/pricing",
    });
  });

  it("keeps a trimmed external referrer", () => {
    expect(
      buildPageViewPayload({
        path: "/pricing",
        referrer: "  https://www.google.com/  ",
        search: "",
      }),
    ).toEqual({ path: "/pricing", referrer: "https://www.google.com/" });
  });

  it("attaches the campaign", () => {
    expect(
      buildPageViewPayload({
        path: "/",
        referrer: "",
        search: "?utm_source=weibo&utm_medium=social&utm_campaign=launch",
      }),
    ).toEqual({
      path: "/",
      campaign: { source: "weibo", medium: "social", name: "launch" },
    });
  });

  it("bounds the path and the referrer", () => {
    const payload = buildPageViewPayload({
      path: `/${"p".repeat(ANALYTICS_PATH_MAX_LENGTH + 50)}`,
      referrer: `https://example.com/${"r".repeat(ANALYTICS_REFERRER_MAX_LENGTH + 50)}`,
      search: "",
    });
    expect(payload?.path).toHaveLength(ANALYTICS_PATH_MAX_LENGTH);
    expect(payload?.referrer).toHaveLength(ANALYTICS_REFERRER_MAX_LENGTH);
  });
});
