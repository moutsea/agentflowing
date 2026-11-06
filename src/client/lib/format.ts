/**
 * Number formatting shared by the traffic analytics dashboard.
 */

import { localeFor } from "../i18n";

/** Whole number with the separators of the visitor's language. */
export function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: 0 }).format(value);
}

/** Share of a whole, clamped to 0–100, with one decimal below 10%. */
export function formatPercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  return `${clamped >= 10 ? clamped.toFixed(0) : clamped.toFixed(1)}%`;
}

/**
 * Percentage change against the previous period, or `null` when that period
 * had no traffic.
 *
 * `null` is not the same as 0: going from 0 to 500 views is not "no change",
 * it is a change no percentage can express. Right after this feature is
 * deployed the previous period is always empty, so returning 0 here would show
 * "0%" on exactly the day someone first looks at the dashboard.
 */
export function calculateGrowth(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  const change = ((current - previous) / previous) * 100;
  return Math.abs(change) >= 10 ? Math.round(change) : Math.round(change * 10) / 10;
}
