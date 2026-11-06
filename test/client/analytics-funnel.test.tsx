import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FunnelPanel } from "../../src/client/components/analytics/funnel-panel";
import i18n from "../../src/client/i18n";
import { createTestRoot } from "./helpers";

describe("FunnelPanel", () => {
  let view: ReturnType<typeof createTestRoot>;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    view = createTestRoot();
  });
  afterEach(async () => {
    await view.unmount();
  });

  const rows = () =>
    [...view.container.querySelectorAll(".analytics-row")].map((row) => [
      row.querySelector(".analytics-row-main")?.textContent,
      row.querySelector(".analytics-row-value strong")?.textContent,
      row.querySelector(".analytics-share-value")?.textContent,
    ]);

  it("shows every step as a share of the accounts that signed up", async () => {
    await view.render(
      <FunnelPanel
        funnel={{ signups: 8, ranAgent: 6, createdAgent: 2, createdApiKey: 1, paid: 0 }}
      />,
    );
    expect(rows()).toEqual([
      ["Signed up", "8", "100%"],
      ["Ran an agent", "6", "75%"],
      ["Built their own agent", "2", "25%"],
      ["Created an API key", "1", "13%"],
      ["Made a payment", "0", "0.0%"],
    ]);
  });

  it("says so instead of showing a column of 0% when nobody signed up", async () => {
    await view.render(
      <FunnelPanel
        funnel={{ signups: 0, ranAgent: 0, createdAgent: 0, createdApiKey: 0, paid: 0 }}
      />,
    );
    expect(view.container.querySelector(".analytics-list")).toBeNull();
    expect(view.container.textContent).toContain("No sign-ups in this period");
  });

  it("is translated", async () => {
    await i18n.changeLanguage("zh-CN");
    await view.render(
      <FunnelPanel
        funnel={{ signups: 4, ranAgent: 1, createdAgent: 0, createdApiKey: 0, paid: 1 }}
      />,
    );
    expect(view.container.querySelector("h2")?.textContent?.trim()).toBe("注册转化漏斗");
    expect(rows()[4]).toEqual(["完成付费", "1", "25%"]);
  });
});
