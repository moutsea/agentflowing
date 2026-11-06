import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KpiCard } from "../../src/client/components/analytics/kpi-card";
import { calculateGrowth } from "../../src/client/lib/format";
import { createTestRoot } from "./helpers";

describe("calculateGrowth", () => {
  it("has no percentage when the previous period was empty", () => {
    // Right after deploy the previous period is always empty; 0 -> 500 is not "0%".
    expect(calculateGrowth(500, 0)).toBeNull();
    expect(calculateGrowth(0, 0)).toBeNull();
  });

  it("rounds to whole percent from 10% and to one decimal below", () => {
    expect(calculateGrowth(120, 100)).toBe(20);
    expect(calculateGrowth(50, 100)).toBe(-50);
    expect(calculateGrowth(1041, 1000)).toBe(4.1);
    expect(calculateGrowth(100, 100)).toBe(0);
  });
});

describe("KpiCard", () => {
  let view: ReturnType<typeof createTestRoot>;
  beforeEach(() => {
    view = createTestRoot();
  });
  afterEach(async () => {
    await view.unmount();
  });

  const delta = () => view.container.querySelector(".analytics-delta");

  it("shows a dash, not 0%, when there is nothing to compare with", async () => {
    await view.render(
      <KpiCard title="Page views" value="500" growth={null} growthLabel="vs previous period" />,
    );
    expect(delta()?.className).toContain("neutral");
    expect(delta()?.querySelector("span")?.textContent).toBe("—");
  });

  it("signs and colors a real change", async () => {
    await view.render(
      <KpiCard title="Page views" value="120" growth={20} growthLabel="vs previous period" />,
    );
    expect(delta()?.className).toContain("positive");
    expect(delta()?.querySelector("span")?.textContent).toBe("+20%");

    await view.render(
      <KpiCard title="Page views" value="50" growth={-50} growthLabel="vs previous period" />,
    );
    expect(delta()?.className).toContain("negative");
    expect(delta()?.querySelector("span")?.textContent).toBe("-50%");
  });
});
