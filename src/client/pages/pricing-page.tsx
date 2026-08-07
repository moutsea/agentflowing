import { ArrowLeft, ArrowRight, Check, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { DEFAULT_PLANS } from "../../shared/config";
import { authClient } from "../auth-client";
import { Brand } from "../components/brand";
import { LanguageSwitcher } from "../components/language-switcher";
import { apiRequest } from "../lib/api";

type CatalogPlan = (typeof DEFAULT_PLANS)[number] & { checkoutEnabled: boolean };

export function PricingPage() {
  const { t } = useTranslation();
  const { data: session } = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<readonly CatalogPlan[]>(
    DEFAULT_PLANS.map((plan) => ({ ...plan, checkoutEnabled: plan.id === "free" })),
  );
  const [checkoutPlan, setCheckoutPlan] = useState("");
  const [error, setError] = useState("");
  const resumedCheckout = useRef(false);

  useEffect(() => {
    void apiRequest<{ data: CatalogPlan[] }>("/api/billing/catalog")
      .then(({ data }) => setPlans(data))
      .catch(() => undefined);
  }, []);

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

  useEffect(() => {
    const planId = new URLSearchParams(location.search).get("plan");
    if (!session?.user || !planId || resumedCheckout.current) return;
    resumedCheckout.current = true;
    void beginCheckout(planId);
  }, [location.search, session?.user]);

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
            <article className={index === 1 ? "price-card featured" : "price-card"} key={plan.id}>
              {index === 1 && <span className="popular-label">{t("BEST FOR LAUNCH")}</span>}
              <span className="eyebrow">{t(plan.name)}</span>
              <div className="price">
                <strong>${plan.monthlyPrice}</strong>
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
                    ? t("Choose plan")
                    : t("Start free")}
              </button>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={15} /> {t(feature)}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
