import { Funnel } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  ANALYTICS_FUNNEL_LABELS,
  ANALYTICS_FUNNEL_STEPS,
  type AnalyticsFunnel,
} from "../../../shared/analytics";
import { formatNumber } from "../../lib/format";
import { ShareBar } from "./share-bar";

/**
 * Accounts created in the range and how far they got.
 *
 * Every step is the same cohort, so a share of sign-ups is a real rate. There
 * is no delta: an older cohort has simply had more time to convert.
 */
export function FunnelPanel({ funnel }: { funnel: AnalyticsFunnel }) {
  const { i18n, t } = useTranslation();
  const format = (value: number) => formatNumber(value, i18n.language);
  const shareOf = (value: number) => (funnel.signups > 0 ? (value / funnel.signups) * 100 : 0);

  return (
    <article className="panel analytics-card">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{t("Conversion")}</span>
          <h2>
            <Funnel size={15} aria-hidden="true" /> {t("Sign-up funnel")}
          </h2>
        </div>
      </div>
      {funnel.signups === 0 ? (
        <p className="analytics-empty-line">{t("No sign-ups in this period")}</p>
      ) : (
        <>
          <ul className="analytics-list">
            <li className="analytics-row">
              <span className="analytics-row-main">
                <span>{t("Signed up")}</span>
              </span>
              <span className="analytics-row-value">
                <strong>{format(funnel.signups)}</strong>
              </span>
              <ShareBar percent={100} />
            </li>
            {ANALYTICS_FUNNEL_STEPS.map((step) => (
              <li className="analytics-row" key={step}>
                <span className="analytics-row-main">
                  <span>{t(ANALYTICS_FUNNEL_LABELS[step])}</span>
                </span>
                <span className="analytics-row-value">
                  <strong>{format(funnel[step])}</strong>
                </span>
                <ShareBar percent={shareOf(funnel[step])} />
              </li>
            ))}
          </ul>
          <p className="analytics-note">
            {t("Accounts created in this period and what they have done since.")}
          </p>
        </>
      )}
    </article>
  );
}
