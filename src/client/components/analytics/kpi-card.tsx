import type { ReactNode } from "react";

interface KpiCardProps {
  title: string;
  /** Already formatted for the visitor's language. */
  value: string;
  /** Percent change from `calculateGrowth`; `null` when there is nothing to compare with. */
  growth: number | null;
  growthLabel: string;
  icon?: ReactNode;
}

/**
 * One headline number on the traffic dashboard.
 *
 * It is styled by the existing `.panel`, `.analytics-kpi*` and `.analytics-delta*`
 * rules, so it matches every other panel on the page, mobile font size included.
 * A `null` growth renders as "—": a previous period with no traffic has no
 * meaningful percentage, and "0%" would claim nothing changed.
 */
export function KpiCard({ title, value, growth, growthLabel, icon }: KpiCardProps) {
  let tone = "neutral";
  if (growth !== null && growth > 0) tone = "positive";
  if (growth !== null && growth < 0) tone = "negative";
  return (
    <article className="panel analytics-kpi">
      <div className="analytics-kpi-heading">
        <span className="eyebrow">{title}</span>
        {icon}
      </div>
      <strong className="analytics-kpi-value">{value}</strong>
      <p className={`analytics-delta ${tone}`}>
        <span>{growth === null ? "—" : `${growth > 0 ? "+" : ""}${growth}%`}</span> {growthLabel}
      </p>
    </article>
  );
}
