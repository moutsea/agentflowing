import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import i18n from "../../src/client/i18n";
import { PricingPage } from "../../src/client/pages/pricing-page";
import { SettingsPage } from "../../src/client/pages/settings-page";
import { WorkspaceContext, type WorkspaceContextValue } from "../../src/client/workspace";
import { DEFAULT_PLANS } from "../../src/shared/config";
import { createTestRoot, type TestRoot } from "./helpers";

vi.mock("../../src/client/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "payer" } } }) },
}));

let view: TestRoot;
const refreshWorkspace = vi.fn(async () => {});
const workspace: WorkspaceContextValue = {
  session: {
    user: { id: "payer", name: "Payer", email: "payer@example.com" },
    organization: { id: "active-workspace", name: "Active", slug: "active" },
    isPlatformAdmin: false,
    role: "member",
    organizations: [],
  },
  agents: [],
  refreshWorkspace,
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  refreshWorkspace.mockClear();
  view = createTestRoot();
});
afterEach(async () => {
  await view.unmount();
  vi.unstubAllGlobals();
});

async function input(label: string, value: string) {
  const field = view.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("previews a coupon without creating payment, then sends it to the QR checkout", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/billing/catalog")
        return Response.json({
          data: DEFAULT_PLANS.map((plan) => ({ ...plan, currency: "usd", checkoutEnabled: true })),
        });
      if (url === "/api/billing/qr" && init?.method !== "POST")
        return Response.json({
          data: { enabled: true, canManage: true, currency: "usd", methods: ["wechat_pay"] },
        });
      if (init?.method === "POST") writes.push({ path: url, body: JSON.parse(String(init.body)) });
      if (url === "/api/billing/coupons/validate")
        return Response.json({ valid: true, rate: 20, expiresAt: "2030-01-01T00:00:00.000Z" });
      if (url === "/api/billing/qr")
        return Response.json({
          data: {
            paymentIntentId: "pi_coupon",
            method: "wechat_pay",
            amount: 23.2,
            currency: "usd",
            kind: "qr",
            qrImage: "data:image/png;base64,AA==",
          },
        });
      return Response.json({ data: { status: "canceled" } });
    }),
  );
  await view.render(
    <MemoryRouter>
      <PricingPage />
    </MemoryRouter>,
  );
  await input("Coupon code", " cbabcdefghjk ");
  await act(async () => view.button("Coupon preview").click());
  expect(writes).toEqual([
    { path: "/api/billing/coupons/validate", body: { code: "cbabcdefghjk" } },
  ]);
  expect(view.container.textContent).toContain("20%");
  expect(view.container.textContent).toContain("2030");
  await act(async () =>
    (view.container.querySelector(".direct-qr-action") as HTMLButtonElement).click(),
  );
  expect(writes[1]).toEqual({
    path: "/api/billing/qr",
    body: { planId: "pro", method: "wechat_pay", couponCode: "cbabcdefghjk" },
  });
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("23.20");
});

it("previews and redeems into the active workspace, shows balance and refreshes workspace state", async () => {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") writes.push(url);
      if (url.endsWith("/validate"))
        return Response.json({ valid: true, credits: 7, expiresAt: "2030-01-01T00:00:00.000Z" });
      if (url.endsWith("/redeem"))
        return Response.json({ data: { credits: 7, balance: 107, ledgerId: "ledger" } });
      return Response.json({ data: url === "/api/billing/subscription" ? null : [] });
    }),
  );
  await view.render(
    <MemoryRouter>
      <WorkspaceContext.Provider value={workspace}>
        <SettingsPage />
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
  await input("Redemption code", "RCABCDEFGHJKLM");
  await act(async () => view.button("Redemption preview").click());
  expect(writes).toEqual(["/api/billing/redemption-codes/validate"]);
  expect(view.container.textContent).toContain("7");
  expect(view.container.textContent).toContain("2030");
  await act(async () => view.button("Redeem code").click());
  expect(writes).toEqual([
    "/api/billing/redemption-codes/validate",
    "/api/billing/redemption-codes/redeem",
  ]);
  expect(view.container.textContent).toContain("Redemption succeeded");
  expect(view.container.textContent).toContain("Balance updated: 107 credits");
  expect(refreshWorkspace).toHaveBeenCalledTimes(1);
});

it.each(["expired", "revoked", "already_used"])(
  "shows the server's bilingual %s preview and does not claim",
  async (reason) => {
    await i18n.changeLanguage("zh-CN");
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") writes.push(url);
        if (url.endsWith("/validate"))
          return Response.json({
            valid: false,
            reason,
            messages: { en: reason, "zh-CN": `服务端：${reason}` },
          });
        return Response.json({ data: url === "/api/billing/subscription" ? null : [] });
      }),
    );
    await view.render(
      <MemoryRouter>
        <WorkspaceContext.Provider value={workspace}>
          <SettingsPage />
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
    await input("兑换码", "RCABCDEFGHJKLM");
    await act(async () => view.button("兑换码预览").click());
    expect(view.container.textContent).toContain(`服务端：${reason}`);
    expect(writes).toEqual(["/api/billing/redemption-codes/validate"]);
    expect(refreshWorkspace).not.toHaveBeenCalled();
  },
);
