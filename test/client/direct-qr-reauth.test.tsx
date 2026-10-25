import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Keep Better Auth's real shared session cache. Only the network is replaced;
// mocking useSession would miss AuthPage's redirect with a stale cached user.
const { request } = vi.hoisted(() => {
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  return { request };
});

import { authClient } from "../../src/client/auth-client";
import i18n from "../../src/client/i18n";
import { AuthPage } from "../../src/client/pages/auth-page";
import { PricingPage } from "../../src/client/pages/pricing-page";
import { DEFAULT_PLANS } from "../../src/shared/config";
import { createTestRoot } from "./helpers";

const returnPath = "/pricing?checkout=qr-return&payment_intent=pi_reauth";
let view: ReturnType<typeof createTestRoot>;
let signedIn: boolean;
let paid: boolean;
let sessionFailure: boolean;
let sessionReads: number;
let paymentReads: string[];
let paymentWrites: string[];
let credentials: unknown[];

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-location>
      {location.pathname}
      {location.search}
    </output>
  );
}
function currentPath() {
  return view.container.querySelector("[data-location]")?.textContent;
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function setInput(type: string, value: string) {
  const input = view.container.querySelector<HTMLInputElement>(`input[type=${type}]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openLoginAndPay() {
  const link = view.container.querySelector<HTMLAnchorElement>('a[href^="/sign-in?"]')!;
  expect(new URL(link.href).searchParams.get("redirect")).toBe(returnPath);
  await act(async () => link.click());
  expect(currentPath()).toBe(`/sign-in?redirect=${encodeURIComponent(returnPath)}`);
  expect(view.container.querySelector('input[type="email"]')).not.toBeNull();
  expect(view.container.querySelector('input[type="password"]')).not.toBeNull();

  await setInput("email", "payer@example.com");
  await setInput("password", "test-password-123");
  await act(async () => {
    view.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  // Better Auth publishes successful sign-in to its shared session on a timer.
  await advance(20);
  expect(credentials).toEqual([{ email: "payer@example.com", password: "test-password-123" }]);
  expect(currentPath()).toBe(returnPath);
  expect(view.container.textContent).toContain("Payment received.");
  expect(paymentReads.length).toBeGreaterThanOrEqual(3);
  expect(new Set(paymentReads)).toEqual(new Set(["/api/billing/qr/pi_reauth"]));
  expect(paymentWrites).toEqual([]);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  await i18n.changeLanguage("en");
  signedIn = true;
  paid = false;
  sessionFailure = false;
  sessionReads = 0;
  paymentReads = [];
  paymentWrites = [];
  credentials = [];
  request.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost:5173");
    if (url.pathname === "/api/auth/get-session") {
      sessionReads++;
      if (sessionFailure) return Response.json({ message: "Unavailable" }, { status: 503 });
      return Response.json(
        signedIn
          ? {
              session: { id: "session", userId: "payer", expiresAt: "2030-01-01T00:00:00.000Z" },
              user: { id: "payer", name: "Payer", email: "payer@example.com" },
            }
          : null,
      );
    }
    if (url.pathname === "/api/auth/capabilities") return Response.json({ emailPassword: true });
    if (url.pathname === "/api/auth/sign-in/email") {
      credentials.push(JSON.parse(String(init?.body)));
      signedIn = true;
      paid = true;
      return Response.json({ user: { id: "payer" }, token: "test-session-token" });
    }
    if (url.pathname.startsWith("/api/billing/") && init?.method && init.method !== "GET") {
      paymentWrites.push(`${init.method} ${url.pathname}`);
      return Response.json({ error: "unexpected_mutation" }, { status: 500 });
    }
    if (url.pathname === "/api/billing/catalog")
      return Response.json({
        data: DEFAULT_PLANS.map((plan) => ({ ...plan, currency: "usd", checkoutEnabled: true })),
      });
    if (url.pathname === "/api/billing/qr")
      return Response.json({
        data: { enabled: true, canManage: true, currency: "usd", methods: ["alipay"] },
      });
    if (url.pathname === "/api/billing/qr/pi_reauth") {
      paymentReads.push(url.pathname);
      return signedIn
        ? Response.json({ data: { status: paid ? "succeeded" : "pending" } })
        : Response.json({ error: "unauthorized" }, { status: 401 });
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  });
  // Prime the real cache through its network-backed refetch, including between
  // cases: the regression requires a cached user whose server session expires.
  const session = authClient.$store.atoms.session;
  if (!session) throw new Error("Better Auth session store is unavailable");
  await act(async () => session.get().refetch());
  view = createTestRoot();
  await view.render(
    <MemoryRouter
      initialEntries={[
        `${returnPath}&payment_intent_client_secret=pi_reauth_secret_example&plan=pro`,
      ]}
    >
      <Routes>
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/sign-in" element={<AuthPage mode="sign-in" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  await advance(0);
  expect(view.container.textContent).toContain("Payment is still pending.");
});

afterEach(async () => {
  await view.unmount();
  await advance(1100);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("refreshes an expired session, crosses AuthPage, and resumes the original payment after sign-in", async () => {
  signedIn = false;
  await advance(3000);
  await openLoginAndPay();
});

it("keeps a failed session refresh retryable without routing with the stale cached user", async () => {
  signedIn = false;
  sessionFailure = true;
  const readsBefore = sessionReads;
  await advance(3000);
  expect(sessionReads).toBeGreaterThan(readsBefore);
  expect(view.container.textContent).toContain("Could not confirm payment status.");
  expect(view.container.querySelector('a[href^="/sign-in?"]')).toBeNull();
  expect(paymentWrites).toEqual([]);

  sessionFailure = false;
  await act(async () => view.button("Check payment again").click());
  await openLoginAndPay();
});
