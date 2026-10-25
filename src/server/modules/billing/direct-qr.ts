import qrcode from "qrcode-generator";
import type Stripe from "stripe";

import {
  DIRECT_QR_FLOW,
  type DirectQrPresentation,
  type DirectQrStatus,
  type QrPaymentMethod,
} from "../../../shared/direct-qr";

/**
 * Turning a confirmed PaymentIntent into something a customer can scan.
 *
 * Stripe answers the two wallets very differently:
 *
 * - WeChat Pay returns `wechat_pay_display_qr_code`, which usually carries a
 *   ready-made `image_data_url`. When it does not, `data` holds the raw QR
 *   payload and we draw the code ourselves.
 * - Alipay returns `alipay_handle_redirect`, which has no image at all. Its
 *   `url` is a Stripe-hosted page (the slow path this flow exists to avoid),
 *   while `native_url` is the deep link meant to open the Alipay app. Encoding
 *   that deep link as a QR is what lets a desktop customer pay by phone.
 */

/**
 * Render a QR payload as a self-contained SVG data URL.
 *
 * Written by hand instead of using the library's `createSvgTag` so the output
 * is one merged path: the payloads here are wallet deep links of a few hundred
 * characters, and the verbose per-module markup multiplies that into tens of
 * kilobytes of markup for every scan.
 */
function qrSvgDataUrl(payload: string): string {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const margin = 4;
  const size = count + margin * 2;

  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) path += `M${column + margin} ${row + margin}h1v1h-1z`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Exported for tests; `presentDirectQr` is the entry point callers use. */
export { qrSvgDataUrl };

/**
 * Map a confirmed PaymentIntent's `next_action` onto what the dialog can show,
 * or `null` when there is nothing usable (the caller then cancels the intent
 * rather than leaving a payable code stranded).
 */
export function presentDirectQr(
  method: QrPaymentMethod,
  nextAction: Stripe.PaymentIntent.NextAction | null | undefined,
): DirectQrPresentation | null {
  if (method === "wechat_pay") {
    const wechat = nextAction?.wechat_pay_display_qr_code;
    if (wechat?.image_data_url) {
      return { kind: "qr", qrImage: wechat.image_data_url };
    }
    // Stripe documents `data` as the raw QR payload; draw it ourselves if the
    // ready-made image is ever absent.
    if (wechat?.data) {
      return { kind: "qr", qrImage: qrSvgDataUrl(wechat.data) };
    }
    return wechat?.hosted_instructions_url
      ? { kind: "redirect", fallbackUrl: wechat.hosted_instructions_url }
      : null;
  }

  const alipay = nextAction?.alipay_handle_redirect;
  // Not a documented Stripe flow: `native_url` is meant for opening the Alipay
  // app directly. Encoding it as a QR lets a desktop customer scan it with the
  // app. If it is missing, fall back to Stripe's redirect page.
  if (alipay?.native_url) {
    return { kind: "qr", qrImage: qrSvgDataUrl(alipay.native_url) };
  }
  return alipay?.url ? { kind: "redirect", fallbackUrl: alipay.url } : null;
}

/**
 * Collapse PaymentIntent states into what the dialog needs to act on.
 *
 * `requires_payment_method` after a confirm means the attempt is over (the QR
 * expired or the wallet declined); the dialog offers a fresh code.
 */
export function toDirectQrStatus(status: Stripe.PaymentIntent.Status): DirectQrStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "canceled":
      return "canceled";
    case "requires_payment_method":
      return "failed";
    default:
      return "pending";
  }
}

const CANCELABLE_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

/** Whether Stripe still lets us cancel the intent (i.e. nothing is in flight). */
export function isCancelableDirectQrStatus(status: Stripe.PaymentIntent.Status): boolean {
  return CANCELABLE_STATUSES.has(status);
}

/**
 * True for a PaymentIntent this app created for the direct-QR flow. The flow
 * marker is what keeps webhook handling and cancellation from touching intents
 * created anywhere else.
 */
export function isDirectQrIntent(intent: { metadata?: Stripe.Metadata | null }): boolean {
  return intent.metadata?.flow === DIRECT_QR_FLOW;
}
