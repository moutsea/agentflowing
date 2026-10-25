import { act } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PricingPage } from "../../src/client/pages/pricing-page";
import i18n from "../../src/client/i18n";
import { DEFAULT_PLANS } from "../../src/shared/config";
import { createTestRoot, deferred } from "./helpers";

const auth = vi.hoisted(() => ({ userId: "payer", isPending: false }));
vi.mock("../../src/client/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: auth.userId ? { user: { id: auth.userId } } : null,
      isPending: auth.isPending,
    }),
  },
}));

let view: ReturnType<typeof createTestRoot>;
const poll = vi.fn<(id: string, init?: RequestInit) => Promise<Response>>();
const mutations = vi.fn();
function response(status: string) {
  return Response.json({ data: { status } });
}
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-location>
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate("/pricing?checkout=qr-return&payment_intent=pi_new")}>
        Another return
      </button>
    </>
  );
}
async function render(
  search = "?checkout=qr-return&payment_intent=pi_paid&payment_intent_client_secret=pi_paid_secret_test&redirect_status=succeeded",
) {
  await view.render(
    <MemoryRouter initialEntries={[`/pricing${search}`]}>
      <PricingPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(async () => {
  vi.useFakeTimers();
  await i18n.changeLanguage("en");
  auth.userId = "payer";
  auth.isPending = false;
  poll.mockReset().mockImplementation(async () => response("succeeded"));
  mutations.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method && init.method !== "GET") mutations(url, init);
      if (url === "/api/billing/catalog")
        return Response.json({
          data: DEFAULT_PLANS.map((plan) => ({ ...plan, currency: "usd", checkoutEnabled: true })),
        });
      if (url === "/api/billing/qr")
        return Response.json({
          data: { enabled: true, canManage: true, currency: "usd", methods: ["alipay"] },
        });
      if (String(url).startsWith("/api/billing/qr/"))
        return poll(String(url).split("/").at(-1)!, init);
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    }),
  );
  view = createTestRoot();
});
afterEach(async () => {
  await view.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("checks the returned payment on a fresh page and removes the unused client secret", async () => {
  await render();
  expect(poll).toHaveBeenCalledWith("pi_paid", expect.objectContaining({ cache: "no-store" }));
  expect(view.container.textContent).toContain("Payment received.");
  expect(view.container.querySelector('a[href="/app"]')).not.toBeNull();
  expect(view.container.querySelector(".pricing-grid")).toBeNull();
  expect(view.container.querySelector("[data-location]")?.textContent).not.toContain(
    "client_secret",
  );
  expect(mutations).not.toHaveBeenCalled();
});

it("polls pending payments without trusting redirect_status or starting another checkout", async () => {
  poll.mockResolvedValueOnce(response("pending")).mockResolvedValue(response("succeeded"));
  await render("?checkout=qr-return&payment_intent=pi_paid&redirect_status=succeeded&plan=pro");
  expect(view.container.textContent).toContain(
    "Payment is still pending. This page updates automatically.",
  );
  expect(view.container.textContent).not.toContain("Payment received.");
  expect(view.container.querySelector(".pricing-grid")).toBeNull();
  await advance(3000);
  expect(view.container.textContent).toContain("Payment received.");
  await advance(9000);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(mutations).not.toHaveBeenCalled();
});

it.each(["failed", "canceled"])(
  "shows the terminal %s outcome and stops polling",
  async (status) => {
    poll.mockResolvedValue(response(status));
    await render();
    expect(view.container.textContent).toContain(
      status === "failed" ? "Payment failed." : "Payment was canceled.",
    );
    expect(view.container.querySelector('a[href="/pricing"]')).not.toBeNull();
    await advance(9000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(mutations).not.toHaveBeenCalled();
  },
);

it.each(["network", "server", "invalid_status"])(
  "allows a status-only retry after %s errors",
  async (error) => {
    if (error === "network") poll.mockRejectedValueOnce(new Error("offline"));
    if (error === "server")
      poll.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    if (error === "invalid_status") poll.mockResolvedValueOnce(response("not_a_status"));
    await render();
    expect(view.container.textContent).toContain(
      "Could not confirm payment status. Check again before starting another payment.",
    );
    await act(async () => view.button("Check payment again").click());
    expect(view.container.textContent).toContain("Payment received.");
    expect(mutations).not.toHaveBeenCalled();
  },
);

it("waits for the session and preserves the payment reference through sign-in", async () => {
  auth.userId = "";
  auth.isPending = true;
  await render();
  expect(poll).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Checking payment status…");
  auth.isPending = false;
  await render();
  const signIn = view.container.querySelector<HTMLAnchorElement>('a[href^="/sign-in?"]')!;
  const destination = new URL(signIn.href).searchParams.get("redirect");
  expect(destination).toBe("/pricing?checkout=qr-return&payment_intent=pi_paid");
  expect(poll).not.toHaveBeenCalled();
  auth.userId = "payer";
  await render();
  expect(view.container.textContent).toContain("Payment received.");
});

it.each([403, 404])("does not reveal success for an inaccessible payment (%s)", async (status) => {
  poll.mockResolvedValue(Response.json({ error: "not_found" }, { status }));
  await render();
  expect(view.container.textContent).toContain(
    "This payment could not be found in your current workspace.",
  );
  expect(view.container.textContent).not.toContain("Payment received.");
  await advance(9000);
  expect(poll).toHaveBeenCalledTimes(1);
});

it.each(["", "&payment_intent=cs_other", "&payment_intent=pi_%2Fbad"])(
  "rejects a missing or malformed payment reference: %s",
  async (suffix) => {
    await render(`?checkout=qr-return${suffix}&redirect_status=succeeded`);
    expect(view.container.textContent).toContain("Invalid payment return link.");
    expect(poll).not.toHaveBeenCalled();
    expect(mutations).not.toHaveBeenCalled();
  },
);

it("ignores a stale response after returning for a different payment", async () => {
  const old = deferred<Response>();
  poll.mockReturnValueOnce(old.promise).mockResolvedValue(response("canceled"));
  await render();
  const signal = poll.mock.calls[0]![1]!.signal;
  await act(async () => view.button("Another return").click());
  expect(signal?.aborted).toBe(true);
  expect(view.container.textContent).toContain("Payment was canceled.");
  await act(async () => old.resolve(response("succeeded")));
  expect(view.container.textContent).not.toContain("Payment received.");
  expect(view.container.textContent).toContain("Payment was canceled.");
});

it("stops pending status checks on unmount", async () => {
  poll.mockResolvedValue(response("pending"));
  await render();
  await view.render(<div>Gone</div>);
  await advance(9000);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(mutations).not.toHaveBeenCalled();
});
