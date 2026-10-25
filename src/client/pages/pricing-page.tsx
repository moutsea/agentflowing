import { ArrowLeft, ArrowRight, Check, LoaderCircle, ScanLine, Sparkles } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { DEFAULT_PLANS } from "../../shared/config";
import {
  DEFAULT_BILLING_CURRENCY,
  isQrPaymentMethod,
  type DirectQrAvailability,
} from "../../shared/direct-qr";
import { formatMoney } from "../../shared/money";
import { authClient } from "../auth-client";
import { Brand } from "../components/brand";
import { DirectQrDialog } from "../components/direct-qr-dialog";
import { DirectQrReturn } from "../components/direct-qr-return";
import { LanguageSwitcher } from "../components/language-switcher";
import { localeFor } from "../i18n";
import { apiRequest } from "../lib/api";
import { WorkspaceContext } from "../workspace";

type CatalogPlan = (typeof DEFAULT_PLANS)[number] & {
  checkoutEnabled: boolean;
  /** Quoted by the server alongside the plan so the price never re-labels itself. */
  currency: string;
};

export function PricingPage() {
  const { i18n, t } = useTranslation();
  const { data: session } = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const search = new URLSearchParams(location.search);
  const returningFromQr = search.get("checkout") === "qr-return";
  // This page renders outside AppShell, so the workspace context is usually
  // absent here; the hook that throws would break the marketing page.
  const workspace = useContext(WorkspaceContext);
  const [plans, setPlans] = useState<readonly CatalogPlan[]>(
    DEFAULT_PLANS.map((plan) => ({
      ...plan,
      checkoutEnabled: plan.id === "free",
      currency: DEFAULT_BILLING_CURRENCY,
    })),
  );
  const [checkoutPlan, setCheckoutPlan] = useState("");
  const [error, setError] = useState("");
  const [availability, setAvailability] = useState<DirectQrAvailability | null>(null);
  const [qrPlan, setQrPlan] = useState<CatalogPlan | null>(null);
  const resumedCheckout = useRef(false);

  useEffect(() => {
    void apiRequest<{ data: CatalogPlan[] }>("/api/billing/catalog")
      .then(({ data }) => setPlans(data))
      .catch(() => undefined);
  }, []);

  // A workspace that cannot use the wallet flow simply does not offer it, so a
  // failure here stays silent instead of pretending checkout is broken.
  useEffect(() => {
    void apiRequest<{ data: DirectQrAvailability }>("/api/billing/qr")
      .then(({ data }) => setAvailability(data))
      .catch(() => undefined);
  }, []);

  // Only wallets this build understands, only while the server still enables
  // them, and only for someone who may create the payment: an empty list means
  // the action is not rendered at all.
  const qrMethods = useMemo(
    () =>
      availability?.enabled && availability.canManage
        ? availability.methods.filter(isQrPaymentMethod)
        : [],
    [availability],
  );

  // The price the server will actually charge, in the currency it will charge
  // it in. Both arrive with the plan itself, so the label is right on first
  // paint and does not depend on the QR availability request at all.
  const formatPrice = (amount: number, currency: string) =>
    formatMoney(localeFor(i18n.resolvedLanguage), amount, currency, {
      // "$29" reads better than "$29.00" on a marketing page.
      trimZeroFraction: true,
    });

  const beginCheckout = async (planId: string) => {
    if (planId === "free") {
      navigate(session?.user ? "/app" : "/sign-up?redirect=%2Fapp");
      return;
    }
    if (!session?.user) {
      const returnTo = `/pricing?plan=${encodeURIComponent(planId)}`;
      navigate(`/sign-in?redirect=${encodeURIComponent(returnTo)}`);
      return;
    }
    setCheckoutPlan(planId);
    setError("");
    try {
      const { data } = await apiRequest<{ data: { checkoutUrl: string } }>(
        "/api/billing/checkout",
        { method: "POST", body: JSON.stringify({ planId }) },
      );
      window.location.assign(data.checkoutUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Checkout is unavailable"));
      setCheckoutPlan("");
    }
  };

  const openQrCheckout = (plan: CatalogPlan) => {
    // The intent belongs to a workspace, so sign in exactly like card checkout.
    if (!session?.user) {
      const returnTo = `/pricing?plan=${encodeURIComponent(plan.id)}`;
      navigate(`/sign-in?redirect=${encodeURIComponent(returnTo)}`);
      return;
    }
    setError("");
    setQrPlan(plan);
  };

  const handleQrPaid = useCallback(async () => {
    setQrPlan(null);
    try {
      await workspace?.refreshWorkspace();
    } catch {
      // A stale workspace must not keep a customer who just paid out of the
      // dashboard, which loads its own workspace state on mount anyway.
    }
    navigate("/app");
  }, [navigate, workspace]);

  useEffect(() => {
    const planId = new URLSearchParams(location.search).get("plan");
    if (returningFromQr || !session?.user || !planId || resumedCheckout.current) return;
    resumedCheckout.current = true;
    void beginCheckout(planId);
  }, [location.search, session?.user, returningFromQr]);

  const canceled = new URLSearchParams(location.search).get("checkout") === "canceled";

  return (
    <div className="pricing-page">
      <header className="marketing-nav shell-width">
        <Brand />
        <div className="nav-actions">
          <LanguageSwitcher />
          <Link className="text-button" to="/">
            <ArrowLeft size={15} /> {t("Back home")}
          </Link>
        </div>
      </header>
      <main className="pricing-main shell-width">
        {returningFromQr ? (
          <DirectQrReturn paymentIntentId={search.get("payment_intent") ?? ""} />
        ) : (
          <>
            <div className="section-heading centered">
              <span className="status-pill">
                <Sparkles size={13} /> {t("Predictable by design")}
              </span>
              <h1>{t("Price the outcome, meter the work.")}</h1>
              <p>
                {t(
                  "Plans live in a server-authoritative catalog. Stripe price IDs stay in Worker secrets, while every credit grant is idempotent and auditable.",
                )}
              </p>
            </div>
            {(error || canceled) && (
              <div className={error ? "pricing-notice error" : "pricing-notice"}>
                {error || t("Checkout was canceled. No charge was made.")}
              </div>
            )}
            <div className="pricing-grid">
              {plans.map((plan, index) => (
                <article
                  className={index === 1 ? "price-card featured" : "price-card"}
                  key={plan.id}
                >
                  {index === 1 && <span className="popular-label">{t("BEST FOR LAUNCH")}</span>}
                  <span className="eyebrow">{t(plan.name)}</span>
                  <div className="price">
                    <strong>{formatPrice(plan.monthlyPrice, plan.currency)}</strong>
                    <span>{t("/ month")}</span>
                  </div>
                  <p>{t(plan.description)}</p>
                  <button
                    className={index === 1 ? "button button-accent" : "button button-light"}
                    disabled={!plan.checkoutEnabled || Boolean(checkoutPlan)}
                    onClick={() => void beginCheckout(plan.id)}
                    type="button"
                  >
                    {checkoutPlan === plan.id ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <ArrowRight size={15} />
                    )}
                    {!plan.checkoutEnabled
                      ? t("Configure Stripe price")
                      : plan.monthlyPrice
                        ? t("Subscribe monthly")
                        : t("Start free")}
                  </button>
                  <ul>
                    {plan.features.map((feature) => (
                      <li key={feature}>
                        <Check size={15} /> {t(feature)}
                      </li>
                    ))}
                  </ul>
                  {qrMethods.length > 0 && plan.checkoutEnabled && plan.monthlyPrice > 0 && (
                    <div className="credit-pack-option">
                      <h3>{t("One-time credit pack")}</h3>
                      <p>
                        {t("{{credits}} credits for {{price}} once.", {
                          credits: plan.credits.toLocaleString(localeFor(i18n.resolvedLanguage)),
                          price: formatPrice(plan.monthlyPrice, plan.currency),
                        })}
                      </p>
                      <p>{t("No automatic renewal or subscription upgrade.")}</p>
                      <button
                        className="button direct-qr-action"
                        disabled={Boolean(checkoutPlan)}
                        onClick={() => openQrCheckout(plan)}
                        type="button"
                      >
                        <ScanLine size={15} />
                        {t("Buy credits with WeChat Pay / Alipay")}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
      </main>
      {qrPlan && !returningFromQr && (
        <DirectQrDialog
          credits={qrPlan.credits}
          methods={qrMethods}
          onClose={() => setQrPlan(null)}
          onFallbackToCheckout={() => {
            const planId = qrPlan.id;
            setQrPlan(null);
            void beginCheckout(planId);
          }}
          onPaid={handleQrPaid}
          open
          planId={qrPlan.id}
          planName={t(qrPlan.name)}
        />
      )}
    </div>
  );
}
