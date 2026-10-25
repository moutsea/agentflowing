import { act, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectQrDialog } from "../../src/client/components/direct-qr-dialog";
import type { DirectQrPayment, DirectQrStatus, QrPaymentMethod } from "../../src/shared/direct-qr";
import i18n from "../../src/client/i18n";
import { createTestRoot, deferred } from "./helpers";

let view: ReturnType<typeof createTestRoot>;
let creates: Array<{ method: QrPaymentMethod; response: ReturnType<typeof deferred<Response>> }>;
const cancel = vi.fn<(id: string) => Promise<Response>>();
const poll = vi.fn<(id: string) => Promise<Response>>();
const onPaid = vi.fn();
const onFallbackToCheckout = vi.fn();

function statusResponse(status: DirectQrStatus) {
  return Response.json({ data: { status } });
}
async function render(methods: QrPaymentMethod[] = ["wechat_pay", "alipay"]) {
  await view.render(
    <StrictMode>
      <DirectQrDialog
        open
        planId="pro"
        planName="Launch"
        credits={5000}
        methods={methods}
        onClose={() => undefined}
        onPaid={onPaid}
        onFallbackToCheckout={onFallbackToCheckout}
      />
    </StrictMode>,
  );
}
async function resolveCreate(index: number, id: string) {
  const creation = creates[index]!;
  const payment: DirectQrPayment = {
    paymentIntentId: id,
    method: creation.method,
    amount: 29,
    currency: "usd",
    kind: "qr",
    qrImage: `data:image/svg+xml,${id}`,
  };
  await act(async () => {
    creation.response.resolve(Response.json({ data: payment }));
  });
}
async function click(label: string) {
  await act(async () => view.button(label).click());
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  await i18n.changeLanguage("en");
  creates = [];
  onPaid.mockReset();
  onFallbackToCheckout.mockReset();
  cancel.mockReset().mockImplementation(async () => statusResponse("canceled"));
  poll.mockReset().mockImplementation(async () => statusResponse("pending"));
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((url, init) => {
      if (url === "/api/billing/qr" && init?.method === "POST") {
        const response = deferred<Response>();
        creates.push({ method: JSON.parse(String(init.body)).method, response });
        return response.promise;
      }
      const id = String(url).split("/").at(-1)!;
      if (init?.method === "DELETE") return cancel(id);
      if (String(url).startsWith("/api/billing/qr/")) return poll(id);
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  view = createTestRoot();
});

afterEach(async () => {
  await view.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("direct QR dialog lifecycle", () => {
  it("creates only one payment under StrictMode", async () => {
    await render();
    expect(creates).toHaveLength(1);
    await resolveCreate(0, "pi_initial");
    expect(view.container.querySelector("img")?.getAttribute("src")).toContain("pi_initial");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("finishes a payment that succeeded during cancellation without starting card checkout", async () => {
    await render();
    await resolveCreate(0, "pi_paid");
    cancel.mockResolvedValue(statusResponse("succeeded"));
    await click("Switch to a card subscription");
    expect(onFallbackToCheckout).not.toHaveBeenCalled();
    await advance(1500);
    expect(onPaid).toHaveBeenCalledOnce();
  });

  it.each(["pending", "http_error", "network_error", "invalid_response"] as const)(
    "keeps polling after an unconfirmed cancellation (%s)",
    async (outcome) => {
      await render();
      await resolveCreate(0, "pi_pending");
      if (outcome === "pending") cancel.mockResolvedValue(statusResponse("pending"));
      if (outcome === "http_error")
        cancel.mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }));
      if (outcome === "network_error") cancel.mockRejectedValue(new Error("offline"));
      if (outcome === "invalid_response") cancel.mockResolvedValue(Response.json({ data: {} }));
      await click("Switch to a card subscription");
      expect(onFallbackToCheckout).not.toHaveBeenCalled();
      expect(view.container.querySelector("[role=alert]")).not.toBeNull();
      poll.mockResolvedValue(statusResponse("succeeded"));
      await advance(3000);
      await advance(1500);
      expect(poll).toHaveBeenCalledWith("pi_pending");
      expect(onPaid).toHaveBeenCalledOnce();
    },
  );

  it.each(["canceled", "failed"] as const)("allows card checkout only after %s", async (status) => {
    await render();
    await resolveCreate(0, "pi_closed");
    cancel.mockResolvedValue(statusResponse(status));
    await click("Switch to a card subscription");
    expect(onFallbackToCheckout).toHaveBeenCalledOnce();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("waits for an in-flight create before cancelling and falling back", async () => {
    await render();
    await click("Switch to a card subscription");
    expect(onFallbackToCheckout).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await resolveCreate(0, "pi_late");
    expect(cancel).toHaveBeenCalledWith("pi_late");
    expect(onFallbackToCheckout).toHaveBeenCalledOnce();
  });

  it("does not start multiple checkouts while cancellation is in flight", async () => {
    await render();
    await resolveCreate(0, "pi_once");
    const response = deferred<Response>();
    cancel.mockReturnValue(response.promise);
    await act(async () => {
      const button = view.button("Switch to a card subscription");
      button.click();
      button.click();
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(onFallbackToCheckout).not.toHaveBeenCalled();
    await act(async () => response.resolve(statusResponse("canceled")));
    expect(onFallbackToCheckout).toHaveBeenCalledOnce();
  });

  it("waits for cancellation before creating a code for another wallet", async () => {
    await render();
    await resolveCreate(0, "pi_wechat");
    const response = deferred<Response>();
    cancel.mockReturnValue(response.promise);
    await click("Alipay");
    expect(creates).toHaveLength(1);
    expect(view.button("WeChat Pay").disabled).toBe(true);
    await act(async () => response.resolve(statusResponse("canceled")));
    expect(creates.map((item) => item.method)).toEqual(["wechat_pay", "alipay"]);
    await resolveCreate(1, "pi_alipay");
    expect(view.container.querySelector("img")?.getAttribute("src")).toContain("pi_alipay");
  });

  it("keeps the existing wallet when cancellation is still pending", async () => {
    await render();
    await resolveCreate(0, "pi_keep");
    cancel.mockResolvedValue(statusResponse("pending"));
    await click("Alipay");
    expect(creates).toHaveLength(1);
    expect(view.button("WeChat Pay").getAttribute("aria-pressed")).toBe("true");
    poll.mockResolvedValue(statusResponse("succeeded"));
    await advance(3000);
    await advance(1500);
    expect(onPaid).toHaveBeenCalledOnce();
  });

  it("rejects the old A response after dependencies change A -> B -> A", async () => {
    await render(["wechat_pay"]);
    await render(["alipay"]);
    await render(["wechat_pay"]);
    expect(creates.map((item) => item.method)).toEqual(["wechat_pay", "alipay", "wechat_pay"]);
    await resolveCreate(2, "pi_new_a");
    await resolveCreate(0, "pi_old_a");
    await resolveCreate(1, "pi_old_b");
    expect(view.container.querySelector("img")?.getAttribute("src")).toContain("pi_new_a");
    expect(cancel).toHaveBeenCalledWith("pi_old_a");
    expect(cancel).toHaveBeenCalledWith("pi_old_b");
    expect(cancel).not.toHaveBeenCalledWith("pi_new_a");
    await advance(3000);
    expect(poll).toHaveBeenCalledWith("pi_new_a");
  });

  it("continues polling when the local timeout cannot cancel the payment", async () => {
    await render();
    await resolveCreate(0, "pi_timeout");
    cancel.mockResolvedValue(statusResponse("pending"));
    vi.setSystemTime(Date.now() + 15 * 60 * 1000);
    await advance(3000);
    expect(cancel).toHaveBeenCalledWith("pi_timeout");
    expect(view.container.textContent).not.toContain("This code is no longer valid.");
    poll.mockResolvedValue(statusResponse("succeeded"));
    await advance(3000);
    await advance(1500);
    expect(onPaid).toHaveBeenCalledOnce();
  });

  it.each(["canceled", "succeeded"] as const)(
    "reconciles a %s payment immediately after a cached page restore",
    async (status) => {
      await render();
      await resolveCreate(0, "pi_restored");
      cancel.mockImplementation(async () => statusResponse(status));
      await act(async () => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      });
      expect(cancel).toHaveBeenCalledWith("pi_restored");
      poll.mockImplementation(async () => statusResponse(status));
      await act(async () => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      expect(poll).toHaveBeenCalledWith("pi_restored");
      expect(view.container.querySelector("img")).toBeNull();
      if (status === "succeeded") {
        await advance(1500);
        expect(onPaid).toHaveBeenCalledOnce();
      } else {
        expect(view.container.textContent).toContain("This code is no longer valid.");
        await click("Get a new code");
        expect(creates).toHaveLength(2);
      }
      expect(onFallbackToCheckout).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "network_error"] as const)(
    "keeps tracking and blocks replacement after an unconfirmed pagehide cancel (%s)",
    async (outcome) => {
      await render();
      await resolveCreate(0, "pi_still_payable");
      if (outcome === "pending") {
        cancel.mockImplementation(async () => statusResponse("pending"));
      } else {
        cancel.mockRejectedValue(new Error("offline"));
        poll.mockRejectedValueOnce(new Error("offline"));
      }
      await act(async () => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      });
      await act(async () => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      expect(poll).toHaveBeenCalledWith("pi_still_payable");
      await click("Switch to a card subscription");
      await click("Alipay");
      expect(cancel).toHaveBeenCalledTimes(3);
      expect(onFallbackToCheckout).not.toHaveBeenCalled();
      expect(creates).toHaveLength(1);
      poll.mockImplementation(async () => statusResponse("succeeded"));
      await advance(3000);
      await advance(1500);
      expect(onPaid).toHaveBeenCalledOnce();
    },
  );

  it("ignores a stale restoration poll after switching wallets", async () => {
    await render();
    await resolveCreate(0, "pi_before_restore");
    const restoredStatus = deferred<Response>();
    poll.mockReturnValueOnce(restoredStatus.promise);
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await click("Alipay");
    await resolveCreate(1, "pi_after_restore");
    await act(async () => restoredStatus.resolve(statusResponse("canceled")));
    expect(view.container.querySelector("img")?.getAttribute("src")).toContain("pi_after_restore");
    await advance(3000);
    expect(poll).toHaveBeenLastCalledWith("pi_after_restore");
  });
});
