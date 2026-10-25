import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PricingPage } from "../../src/client/pages/pricing-page";
import { DEFAULT_PLANS } from "../../src/shared/config";
import { createTestRoot } from "./helpers";
import i18n from "../../src/client/i18n";

vi.mock("../../src/client/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "payer" } } }),
  },
}));

let view: ReturnType<typeof createTestRoot>;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  view = createTestRoot();
});
afterEach(async () => {
  await view.unmount();
  vi.unstubAllGlobals();
});

it.each([{ configured: [] }, { configured: ["pro"] }, { configured: ["pro", "scale"] }])(
  "offers QR only for configured plans: $configured",
  async ({ configured }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (url === "/api/billing/catalog")
          return Response.json({
            data: DEFAULT_PLANS.map((plan) => ({
              ...plan,
              currency: "usd",
              checkoutEnabled: plan.id === "free" || configured.includes(plan.id),
            })),
          });
        if (url === "/api/billing/qr")
          return Response.json({
            data: {
              enabled: true,
              canManage: true,
              currency: "usd",
              methods: ["wechat_pay", "alipay"],
            },
          });
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    await view.render(
      <MemoryRouter initialEntries={["/pricing"]}>
        <PricingPage />
      </MemoryRouter>,
    );
    const cards = [...view.container.querySelectorAll(".price-card")];
    expect(cards).toHaveLength(DEFAULT_PLANS.length);
    for (const [index, plan] of DEFAULT_PLANS.entries()) {
      expect(Boolean(cards[index]?.querySelector(".direct-qr-action"))).toBe(
        plan.id !== "free" && configured.includes(plan.id),
      );
    }
  },
);

it("distinguishes a one-time credit pack from the recurring card subscription", async () => {
  const actions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      if (url === "/api/billing/catalog")
        return Response.json({
          data: DEFAULT_PLANS.map((plan) => ({ ...plan, currency: "usd", checkoutEnabled: true })),
        });
      if (url === "/api/billing/qr" && init?.method !== "POST")
        return Response.json({
          data: { enabled: true, canManage: true, currency: "usd", methods: ["wechat_pay"] },
        });
      if (url === "/api/billing/qr" && init?.method === "POST") {
        actions.push("create-pack");
        return Response.json({
          data: {
            paymentIntentId: "pi_pack",
            method: "wechat_pay",
            amount: 29,
            currency: "usd",
            kind: "qr",
            qrImage: "data:image/svg+xml,qr",
          },
        });
      }
      if (url === "/api/billing/qr/pi_pack" && init?.method === "DELETE") {
        actions.push("cancel-pack");
        return Response.json({ data: { status: "canceled" } });
      }
      if (url === "/api/billing/checkout") {
        actions.push("subscribe");
        expect(JSON.parse(String(init?.body))).toEqual({ planId: "pro" });
        // Keep this test in the app instead of navigating to Stripe.
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  await view.render(
    <MemoryRouter>
      <PricingPage />
    </MemoryRouter>,
  );
  const pack = view.container.querySelectorAll(".credit-pack-option")[0]!;
  expect(pack?.textContent).toContain("One-time credit pack");
  expect(pack?.textContent).toContain("5,000 credits for $29 once.");
  expect(pack?.textContent).toContain("No automatic renewal or subscription upgrade.");
  await act(async () => (pack.querySelector("button") as HTMLButtonElement).click());
  const dialog = view.container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("5,000 credits · One-time purchase");
  expect(dialog.textContent).toContain("No automatic renewal or subscription upgrade.");
  expect(dialog.textContent).toContain(
    "This starts a monthly subscription that renews automatically.",
  );
  expect(dialog.textContent).not.toContain("Pay by card instead");
  expect(actions).toEqual(["create-pack"]);
  await act(async () => view.button("Switch to a card subscription").click());
  expect(actions).toEqual(["create-pack", "cancel-pack", "subscribe"]);
});
