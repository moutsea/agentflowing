import { CheckCircle2, LoaderCircle, MessageCircle, RefreshCw, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DirectQrCreateRequest,
  DirectQrPayment,
  DirectQrStatus,
  QrPaymentMethod,
} from "../../shared/direct-qr";
import { formatMoney } from "../../shared/money";
import { localeFor } from "../i18n";
import { ApiError, apiRequest } from "../lib/api";

const POLL_INTERVAL_MS = 3_000;
// Try to expire an abandoned code; keep polling if cancellation is unconfirmed.
const MAX_POLL_MS = 15 * 60 * 1_000;
const SUCCESS_CLOSE_DELAY_MS = 1_500;

type Phase =
  | { name: "loading" }
  | { name: "ready"; payment: DirectQrPayment }
  | { name: "paid" }
  | { name: "expired" }
  | { name: "error" };

export type DirectQrDialogProps = {
  open: boolean;
  planId: string;
  planName: string;
  credits: number;
  methods: QrPaymentMethod[];
  /** Close the dialog; cancellation on dismissal is best effort. */
  onClose: () => void;
  /** Switch to a recurring subscription after canceling the one-time payment. */
  onFallbackToCheckout: () => void;
  onPaid: () => void;
};

/**
 * The wallet can settle an intent before the browser ever sees a code, which
 * the server reports as `already_paid`. The credits are granted at that point,
 * so it has to read as success.
 */
function isAlreadyPaid(error: unknown) {
  return error instanceof ApiError && error.code === "already_paid";
}

/** A replacement payment requires a confirmed result, not just an HTTP response. */
async function cancelIntent(paymentIntentId: string): Promise<DirectQrStatus> {
  const { data } = await apiRequest<{ data: { status: DirectQrStatus } }>(
    `/api/billing/qr/${encodeURIComponent(paymentIntentId)}`,
    { method: "DELETE", keepalive: true },
  );
  if (!["pending", "succeeded", "failed", "canceled"].includes(data?.status)) {
    throw new Error("Invalid payment cancellation response");
  }
  return data.status;
}

function MethodGlyph({ method }: { method: QrPaymentMethod }) {
  return method === "wechat_pay" ? (
    <MessageCircle aria-hidden="true" size={15} />
  ) : (
    <Wallet aria-hidden="true" size={15} />
  );
}

export function DirectQrDialog({
  open,
  planId,
  planName,
  credits,
  methods,
  onClose,
  onFallbackToCheckout,
  onPaid,
}: DirectQrDialogProps) {
  const { i18n, t } = useTranslation();
  const headingId = useId();
  const [selectedMethod, setSelectedMethod] = useState<QrPaymentMethod | null>(methods[0] ?? null);
  // Bumped by "get a new code" to request a fresh intent for the same wallet.
  const [attempt, setAttempt] = useState(0);
  // A wallet the server dropped (its currency list changed after a workspace
  // switch) falls back to the first supported one instead of asking for a
  // method the server would reject.
  const method =
    selectedMethod && methods.includes(selectedMethod) ? selectedMethod : (methods[0] ?? null);
  // The outcome of one request, tagged with the wallet/attempt it belongs to.
  // A request whose key no longer matches is still loading by definition, so
  // switching wallet shows the spinner without setting state in an effect.
  const requestKey = `${planId}:${method ?? "none"}:${attempt}`;
  const [result, setResult] = useState<{ key: string; phase: Phase } | null>(null);
  const phase: Phase = result?.key === requestKey ? result.phase : { name: "loading" };
  const setPhase = useCallback(
    (next: Phase) => setResult({ key: requestKey, phase: next }),
    [requestKey],
  );

  // The intent currently on screen, so every exit path can cancel it. A ref,
  // not state: cleanup and unload handlers must see the latest value.
  const activeIntentRef = useRef<string | null>(null);
  // The request behind the code on screen, tagged with the wallet/attempt it
  // belongs to. Keeping it here means React's StrictMode double-invoke of the
  // effect reuses the same request instead of opening a second PaymentIntent.
  const createdRef = useRef<{ key: string; request: Promise<DirectQrPayment> } | null>(null);
  // False once the request has been abandoned, so a late response is released
  // instead of shown to someone who has already moved on.
  const aliveRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const replacingRef = useRef(false);
  const [replacing, setReplacing] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState("");

  const releaseActiveIntent = useCallback(() => {
    const id = activeIntentRef.current;
    activeIntentRef.current = null;
    // Only dismissal/cleanup may abandon tracking without a confirmed cancel.
    return id ? cancelIntent(id).catch(() => undefined) : Promise.resolve();
  }, []);

  // Create a code when the dialog opens, the wallet changes, or a new code is
  // requested; cancel it when any of those change again or the dialog closes.
  useEffect(() => {
    if (!open || !method) {
      createdRef.current = null;
      return;
    }
    aliveRef.current = true;
    void releaseActiveIntent();

    const key = requestKey;
    const previous = createdRef.current;
    const request =
      previous && previous.key === key
        ? previous.request
        : apiRequest<{ data: DirectQrPayment }>("/api/billing/qr", {
            method: "POST",
            body: JSON.stringify({ planId, method } satisfies DirectQrCreateRequest),
          }).then(({ data }) => data);
    if (!previous || previous.key !== key) createdRef.current = { key, request };

    // A -> B -> A can reuse the same key. Only this exact request may publish
    // its result; StrictMode still reuses that Promise on the second setup.
    const abandoned = () => !aliveRef.current || createdRef.current?.request !== request;

    void request
      .then((payment) => {
        if (abandoned()) {
          // Nobody is looking at this code any more, so release it rather than
          // leave an intent waiting on a payment that cannot arrive.
          void cancelIntent(payment.paymentIntentId).catch(() => undefined);
          return;
        }
        activeIntentRef.current = payment.paymentIntentId;
        setPhase({ name: "ready", payment });
      })
      .catch((error: unknown) => {
        if (abandoned()) return;
        setPhase(isAlreadyPaid(error) ? { name: "paid" } : { name: "error" });
      });

    return () => {
      aliveRef.current = false;
      void releaseActiveIntent();
    };
  }, [open, method, planId, releaseActiveIntent, requestKey, setPhase]);

  // A hidden page may return from bfcache without remounting. Keep the intent
  // identity even if this best-effort cancellation fails; pageshow rechecks it.
  useEffect(() => {
    if (!open) return;
    const onPageHide = () => {
      const id = activeIntentRef.current;
      if (id) void cancelIntent(id).catch(() => undefined);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [open]);

  // Poll the status while a code is on screen.
  const readyIntentId = phase.name === "ready" ? phase.payment.paymentIntentId : null;
  useEffect(() => {
    if (!readyIntentId) return;
    const startedAt = Date.now();
    let stopped = false;
    let expiryAttempted = false;

    const check = () =>
      apiRequest<{ data: { status: DirectQrStatus } }>(
        `/api/billing/qr/${encodeURIComponent(readyIntentId)}`,
        { cache: "no-store" },
      ).then(({ data }) => data.status);

    /** Returns true when the payment reached a final state. */
    const settle = (status: DirectQrStatus) => {
      if (status === "succeeded") {
        // Paid: nothing left to cancel.
        activeIntentRef.current = null;
        setPhase({ name: "paid" });
        return true;
      }
      if (status === "failed" || status === "canceled") {
        activeIntentRef.current = null;
        setPaymentMessage("");
        setPhase({ name: "expired" });
        return true;
      }
      return false;
    };

    // The code has been on screen too long: confirm the real state before
    // telling the customer it expired, because a payment can land at the very
    // last moment.
    const expireAfterFinalCheck = async () => {
      let status: DirectQrStatus = "pending";
      try {
        status = await check();
      } catch {
        // Try cancellation, but keep polling unless its outcome is confirmed.
      }
      if (stopped || activeIntentRef.current !== readyIntentId) return;
      if (settle(status)) {
        window.clearInterval(timer);
        return;
      }
      try {
        status = await cancelIntent(readyIntentId);
      } catch {
        // An unreachable cancellation endpoint cannot make a code expire.
      }
      if (stopped || activeIntentRef.current !== readyIntentId) return;
      if (settle(status)) window.clearInterval(timer);
    };

    const poll = () => {
      if (stopped || activeIntentRef.current !== readyIntentId) return;
      void check()
        .then((status) => {
          if (stopped || activeIntentRef.current !== readyIntentId) return;
          if (settle(status)) window.clearInterval(timer);
        })
        .catch(() => {
          // Transient network error: keep the intent and try on the next tick.
        });
    };

    const timer = window.setInterval(() => {
      if (stopped || activeIntentRef.current !== readyIntentId) return;
      if (!expiryAttempted && Date.now() - startedAt > MAX_POLL_MS) {
        expiryAttempted = true;
        void expireAfterFinalCheck();
        return;
      }
      poll();
    }, POLL_INTERVAL_MS);

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) poll();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [readyIntentId, setPhase]);

  useEffect(() => {
    if (phase.name !== "paid") return;
    const timer = window.setTimeout(onPaid, SUCCESS_CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [phase.name, onPaid]);

  const handleClose = useCallback(() => {
    if (phase.name === "paid") {
      onPaid();
      return;
    }
    void releaseActiveIntent();
    onClose();
  }, [onClose, onPaid, phase.name, releaseActiveIntent]);

  const replacePayment = async (replace: () => void) => {
    if (replacingRef.current || phase.name === "paid") return;
    replacingRef.current = true;
    setReplacing(true);
    setPaymentMessage("");
    const creation = createdRef.current;
    const isCurrent = () => aliveRef.current && createdRef.current === creation;
    try {
      // The create call can still be in flight when the customer changes their
      // mind. Wait for its id before cancelling or opening another payment.
      let id = activeIntentRef.current;
      if (!id && phase.name === "loading" && creation) {
        id = (await creation.request).paymentIntentId;
      }
      if (!isCurrent()) return;
      if (id) {
        const status = await cancelIntent(id);
        if (!isCurrent()) return;
        if (status === "succeeded") {
          activeIntentRef.current = null;
          setPhase({ name: "paid" });
          return;
        }
        if (status === "pending") {
          setPaymentMessage("Payment is still pending. Wait before switching payment methods.");
          return;
        }
        activeIntentRef.current = null;
      }
      replace();
    } catch (error) {
      if (!isCurrent()) return;
      if (isAlreadyPaid(error)) {
        setPhase({ name: "paid" });
      } else {
        setPaymentMessage(
          "Could not confirm cancellation. Try again before starting another payment.",
        );
      }
    } finally {
      replacingRef.current = false;
      if (aliveRef.current) setReplacing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, handleClose]);

  // Focus moves into the dialog and stays there: the page behind a modal must
  // not be reachable by Tab, and the background must not scroll while it is up.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      // Wrap around the ends, and treat focus still sitting on the dialog
      // itself as "before the first control".
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  const locale = localeFor(i18n.resolvedLanguage);
  const methodLabel = (value: QrPaymentMethod) =>
    value === "wechat_pay" ? t("WeChat Pay") : t("Alipay");

  return (
    <div
      className="direct-qr-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
      role="presentation"
    >
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="direct-qr-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-label={t("Close dialog")}
          className="direct-qr-close"
          onClick={handleClose}
          type="button"
        >
          <X aria-hidden="true" size={15} />
        </button>

        <span className="eyebrow">{planName}</span>
        <h2 id={headingId}>{t("Scan to pay")}</h2>
        <p className="direct-qr-purchase">
          {t("{{credits}} credits · One-time purchase", {
            credits: credits.toLocaleString(locale),
          })}
        </p>
        <p className="direct-qr-hint">{t("No automatic renewal or subscription upgrade.")}</p>
        <p className="direct-qr-hint">
          {method === "alipay"
            ? t("Open Alipay and scan the code to pay.")
            : t("Open WeChat and scan the code to pay.")}
        </p>

        {methods.length > 1 && (
          <div aria-label={t("Payment method")} className="direct-qr-methods" role="group">
            {methods.map((option) => (
              <button
                aria-pressed={option === method}
                className="direct-qr-method"
                disabled={phase.name === "paid" || replacing}
                key={option}
                onClick={() => {
                  if (option === method) return;
                  void replacePayment(() => {
                    setSelectedMethod(option);
                    setAttempt((value) => value + 1);
                  });
                }}
                type="button"
              >
                <MethodGlyph method={option} />
                {methodLabel(option)}
              </button>
            ))}
          </div>
        )}

        <div className="direct-qr-stage">
          {phase.name === "loading" && (
            <LoaderCircle aria-hidden="true" className="spin direct-qr-spinner" size={30} />
          )}

          {phase.name === "ready" && (
            <>
              {/* The intent's own currency, so a non-USD catalogue cannot show a dollar sign. */}
              <p className="direct-qr-amount">
                {t("Amount due")}{" "}
                <strong>{formatMoney(locale, phase.payment.amount, phase.payment.currency)}</strong>
              </p>
              {phase.payment.kind === "qr" ? (
                // A data: URL, so rendering the code never contacts Stripe.
                <div className="direct-qr-panel">
                  <img
                    alt={t("{{method}} payment code", {
                      method: methodLabel(phase.payment.method),
                    })}
                    className="direct-qr-code"
                    height={224}
                    src={phase.payment.qrImage}
                    width={224}
                  />
                </div>
              ) : (
                <a
                  className="button button-dark direct-qr-redirect"
                  href={phase.payment.fallbackUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t("Continue on the payment page")}
                </a>
              )}
            </>
          )}

          {phase.name === "paid" && (
            <CheckCircle2 aria-hidden="true" className="direct-qr-paid" size={46} />
          )}

          {(phase.name === "expired" || phase.name === "error") && (
            <button
              className="button button-light"
              disabled={replacing}
              onClick={() => void replacePayment(() => setAttempt((value) => value + 1))}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={15} />
              {t("Get a new code")}
            </button>
          )}

          <p aria-live="polite" className="direct-qr-status" role="status">
            {phase.name === "loading" && t("Creating a payment code…")}
            {phase.name === "ready" && t("Waiting for payment… This window updates automatically.")}
            {phase.name === "paid" && <span className="paid">{t("Payment received.")}</span>}
            {phase.name === "expired" && t("This code is no longer valid.")}
            {phase.name === "error" && t("Could not create a payment code. Try again.")}
          </p>
          {paymentMessage && phase.name !== "paid" && (
            <p className="direct-qr-status" role="alert">
              {t(paymentMessage)}
            </p>
          )}
        </div>

        <div className="direct-qr-card">
          <button
            className="button button-light"
            disabled={phase.name === "paid" || replacing}
            onClick={() => {
              void replacePayment(onFallbackToCheckout);
            }}
            type="button"
          >
            {t("Switch to a card subscription")}
          </button>
          <p className="direct-qr-card-hint">
            {t("This starts a monthly subscription that renews automatically.")}
          </p>
          <p className="direct-qr-card-hint">
            {t("The card checkout page may be slow to load in mainland China.")}
          </p>
        </div>
      </div>
    </div>
  );
}
