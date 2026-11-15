import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminCodesPage } from "../../src/client/pages/admin-codes-page";
import i18n from "../../src/client/i18n";
import { createTestRoot, type TestRoot } from "./helpers";

vi.mock("../../src/client/workspace", () => ({
  useWorkspace: () => ({ session: { isPlatformAdmin: true } }),
}));

let view: TestRoot;
beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage("en");
  view = createTestRoot();
});
afterEach(async () => {
  await view.unmount();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it.each(["Coupons", "Redemption codes"])(
  "restores the exact %s issuance after a lost response and refresh",
  async (kind) => {
    const requests: Array<{ key: string | null; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== "POST") return Response.json({ data: {} });
        requests.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          body: JSON.parse(String(init.body)),
        });
        if (requests.length === 1) throw new TypeError("response lost after commit");
        return Response.json({ data: { codes: [{ code: "original-code" }] } });
      }),
    );
    await view.render(<AdminCodesPage />);
    if (kind === "Redemption codes")
      await act(async () =>
        (view.container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click(),
      );
    const count = view.container.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(count, "2");
      count.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => view.button("Issue codes").click());
    await view.unmount();
    view = createTestRoot();
    await view.render(<AdminCodesPage />);
    if (kind === "Redemption codes")
      await act(async () =>
        (view.container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click(),
      );
    const recoveredCount =
      view.container.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!;
    expect(recoveredCount.value).toBe("2");
    await act(async () => view.button("Recover original issuance").click());
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(view.container.textContent).toContain("original-code");
  },
);

it("allows correcting an issuance rejected by the daily cap without losing unknown recovery", async () => {
  const requests: Array<{ key: string | null; body: { count: number } }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST")
        return Response.json({
          data: { creditsRemaining: 5, dailyCreditsCap: 5000, creditsIssued: 4995 },
        });
      const body = JSON.parse(String(init.body));
      requests.push({ key: new Headers(init.headers).get("Idempotency-Key"), body });
      return body.count > 1
        ? Response.json(
            { error: "daily_cap_reached", message: "Daily issuance limit reached" },
            { status: 429 },
          )
        : Response.json({ data: { codes: [{ code: "corrected-code" }] } });
    }),
  );
  await view.render(<AdminCodesPage />);
  await act(async () =>
    (view.container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click(),
  );
  const count = view.container.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!;
  const setCount = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(count, value);
      count.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await setCount("2");
  await act(async () => view.button("Issue codes").click());
  expect(view.container.querySelector("fieldset")!.disabled).toBe(false);
  expect(sessionStorage.getItem("admin-redemption-issuance-request")).toBeNull();
  await setCount("1");
  await act(async () => view.button("Issue codes").click());
  expect(requests.map((request) => request.body.count)).toEqual([2, 1]);
  expect(requests[0]!.key).not.toBe(requests[1]!.key);
  expect(view.container.textContent).toContain("corrected-code");
});

it.each([500, 409])(
  "retains the original issuance after an unknown HTTP %s outcome",
  async (status) => {
    const requests: Array<{ key: string | null; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== "POST") return Response.json({ data: {} });
        requests.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          body: String(init.body),
        });
        return requests.length === 1
          ? Response.json(
              { error: status === 409 ? "idempotency_in_progress" : "internal_error" },
              { status },
            )
          : Response.json({ data: { codes: [{ code: "original-batch" }] } });
      }),
    );
    await view.render(<AdminCodesPage />);
    await act(async () => view.button("Issue codes").click());
    expect(view.container.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () => view.button("Recover original issuance").click());
    expect(requests[1]).toEqual(requests[0]);
    expect(view.container.textContent).toContain("original-batch");
  },
);
