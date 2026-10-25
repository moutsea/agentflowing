import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";

import type { DirectQrStatus } from "../../shared/direct-qr";
import { authClient } from "../auth-client";
import { ApiError, apiRequest } from "../lib/api";

function SignInToCheck({ paymentIntentId }: { paymentIntentId: string }) {
  const { t } = useTranslation();
  const returnTo = `/pricing?checkout=qr-return&payment_intent=${encodeURIComponent(paymentIntentId)}`;
  return (
    <>
      <p>{t("Sign in to check your payment status.")}</p>
      <Link className="button button-dark" to={`/sign-in?redirect=${encodeURIComponent(returnTo)}`}>
        {t("Sign in")}
      </Link>
    </>
  );
}

function ReturnedPaymentStatus({ paymentIntentId }: { paymentIntentId: string }) {
  const { t } = useTranslation();
  const { refetch } = authClient.useSession();
  const [status, setStatus] = useState<DirectQrStatus | "checking" | "error" | "unavailable">(
    "checking",
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const check = async () => {
      try {
        // The authenticated server verifies workspace ownership. Never trust
        // redirect_status or use the client secret to infer payment success.
        const { data } = await apiRequest<{ data: { status: DirectQrStatus } }>(
          `/api/billing/qr/${encodeURIComponent(paymentIntentId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (stopped) return;
        if (!["pending", "succeeded", "failed", "canceled"].includes(data?.status)) {
          throw new Error("Invalid payment status response");
        }
        setStatus(data.status);
        if (data.status === "pending") timer = window.setTimeout(() => void check(), 3_000);
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 401) {
          // AuthPage redirects cached users away from its form. Revalidate the
          // shared session first: a confirmed expiry makes DirectQrReturn show
          // sign-in. If refresh fails and retains the old user, offer a status
          // retry instead of sending that stale user into a redirect loop.
          try {
            await refetch();
          } catch {
            // A failed session refresh is retryable along with the status read.
          }
          if (stopped) return;
        }
        setStatus(
          error instanceof ApiError && [403, 404].includes(error.status) ? "unavailable" : "error",
        );
      }
    };
    void check();
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [paymentIntentId, attempt, refetch]);

  return (
    <>
      <div aria-live="polite" role="status">
        {status === "checking" && <p>{t("Checking payment status…")}</p>}
        {status === "pending" && (
          <p>{t("Payment is still pending. This page updates automatically.")}</p>
        )}
        {status === "succeeded" && <p>{t("Payment received.")}</p>}
        {status === "failed" && <p>{t("Payment failed.")}</p>}
        {status === "canceled" && <p>{t("Payment was canceled.")}</p>}
        {status === "unavailable" && (
          <p>{t("This payment could not be found in your current workspace.")}</p>
        )}
        {status === "error" && (
          <p>
            {t("Could not confirm payment status. Check again before starting another payment.")}
          </p>
        )}
      </div>
      {status === "succeeded" && (
        <Link className="button button-dark" to="/app">
          {t("Go to workspace")}
        </Link>
      )}
      {(status === "failed" || status === "canceled") && (
        <Link className="button button-light" to="/pricing">
          {t("Back to pricing")}
        </Link>
      )}
      {(status === "error" || status === "unavailable") && (
        <button
          className="button button-light"
          type="button"
          onClick={() => {
            setStatus("checking");
            setAttempt((value) => value + 1);
          }}
        >
          {t("Check payment again")}
        </button>
      )}
    </>
  );
}

/** A redirect can land in a new tab with no mounted QR dialog or local state. */
export function DirectQrReturn({ paymentIntentId }: { paymentIntentId: string }) {
  const { t } = useTranslation();
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const valid = /^pi_[A-Za-z0-9]+$/.test(paymentIntentId);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("payment_intent_client_secret")) return;
    params.delete("payment_intent_client_secret");
    navigate(
      { pathname: location.pathname, search: `?${params}`, hash: location.hash },
      { replace: true },
    );
  }, [location.pathname, location.search, location.hash, navigate]);

  return (
    <section className="payment-return">
      <h1>{t("Payment status")}</h1>
      {!valid ? (
        <p role="alert">{t("Invalid payment return link.")}</p>
      ) : isPending ? (
        <p role="status">{t("Checking payment status…")}</p>
      ) : !session?.user ? (
        <SignInToCheck paymentIntentId={paymentIntentId} />
      ) : (
        <ReturnedPaymentStatus
          key={`${session.user.id}:${paymentIntentId}`}
          paymentIntentId={paymentIntentId}
        />
      )}
    </section>
  );
}
