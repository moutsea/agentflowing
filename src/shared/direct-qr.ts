/**
 * Shared contract for the direct-QR (WeChat Pay / Alipay) checkout flow.
 *
 * The flow inverts Stripe Checkout: the Worker confirms a PaymentIntent itself
 * and returns a QR code that the browser renders, so the customer's device
 * never has to load a Stripe-hosted page. Everything here is dependency-free
 * and environment-free so the Worker bundle and the browser bundle can import
 * the exact same rules and cannot disagree about what a currency allows.
 */

/** Wallets that can be paid by scanning a QR code we render ourselves. */
export const QR_PAYMENT_METHODS = ["wechat_pay", "alipay"] as const;

export type QrPaymentMethod = (typeof QR_PAYMENT_METHODS)[number];

/**
 * WeChat first: it is the one Stripe answers with a ready-made QR image for,
 * while Alipay has to be drawn from the `native_url` payload.
 */
export const QR_METHOD_ORDER: readonly QrPaymentMethod[] = ["wechat_pay", "alipay"];

export type OneTimePaymentMethod = "card" | QrPaymentMethod;

/** Marks a PaymentIntent this app created for the direct-QR flow. */
export const DIRECT_QR_FLOW = "direct_qr";

/**
 * Currencies each wallet can settle in, from Stripe's payment method support
 * table. Card settles in every currency this app can be priced in, so it is
 * never listed here and is always added below.
 */
const QR_METHOD_CURRENCIES: Record<QrPaymentMethod, readonly string[]> = {
  wechat_pay: [
    "aud",
    "cad",
    "chf",
    "cny",
    "dkk",
    "eur",
    "gbp",
    "hkd",
    "jpy",
    "nok",
    "sek",
    "sgd",
    "usd",
  ],
  alipay: ["aud", "cad", "cny", "eur", "gbp", "hkd", "jpy", "myr", "nzd", "sgd", "usd"],
};

/**
 * Plans are priced in USD (see `DEFAULT_PLANS`), and a direct-QR intent carries
 * its amount explicitly rather than through a Stripe price, so this is the only
 * currency whose amounts mean anything out of the box.
 */
export const DEFAULT_BILLING_CURRENCY = "usd";

function methodsForCurrency(currency: string): QrPaymentMethod[] {
  const normalized = currency.trim().toLowerCase();
  return QR_METHOD_ORDER.filter((method) => QR_METHOD_CURRENCIES[method].includes(normalized));
}

/** Every method a currency may use. Card is always available as the fallback. */
export function getSupportedOneTimePaymentMethods(currency: string): OneTimePaymentMethod[] {
  return ["card", ...methodsForCurrency(currency)];
}

export function isQrPaymentMethod(value: unknown): value is QrPaymentMethod {
  return typeof value === "string" && (QR_PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * The wallets a customer can pay with by scanning a code, in display order.
 * Derived from the same table as Checkout so the two flows stay consistent.
 */
export function getQrPaymentMethods(currency: string): QrPaymentMethod[] {
  return methodsForCurrency(currency);
}

/** What the dialog shows for a confirmed direct-QR PaymentIntent. */
export type DirectQrPresentation =
  | { kind: "qr"; /** A `data:` URL, so rendering it never contacts Stripe. */ qrImage: string }
  | { kind: "redirect"; /** Last-resort Stripe-hosted page. */ fallbackUrl: string };

/** The successful `POST /api/billing/qr` response body. */
export type DirectQrPayment = {
  paymentIntentId: string;
  method: QrPaymentMethod;
  currency: string;
  /** Amount in major currency units, for display only. */
  amount: number;
} & DirectQrPresentation;

export type DirectQrStatus = "pending" | "succeeded" | "failed" | "canceled";

/** `GET /api/billing/qr`: whether this workspace may use the flow. */
export type DirectQrAvailability = {
  enabled: boolean;
  currency: string;
  methods: QrPaymentMethod[];
  /**
   * Whether the caller may start or cancel a payment. Creating one is a
   * workspace-manager action, so a plain member must not be offered the
   * button that would only fail on submit.
   */
  canManage: boolean;
};

/** `POST /api/billing/qr` request body. */
export type DirectQrCreateRequest = {
  planId: string;
  method: QrPaymentMethod;
};
