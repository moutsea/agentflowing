import { formatPercent } from "../../lib/format";

/**
 * Displays a percentage value as a horizontal progress bar.
 */
export function ShareBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));

  return (
    <span className="analytics-share">
      <span className="analytics-share-track">
        <span className="analytics-share-fill" style={{ width: `${clamped}%` }} />
      </span>
      <span className="analytics-share-value">{formatPercent(percent)}</span>
    </span>
  );
}
