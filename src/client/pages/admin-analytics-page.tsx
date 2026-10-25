import { BarChart3, FileText, Globe2, Link2, Smartphone, Tag } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ANALYTICS_DEVICES,
  ANALYTICS_RANGES,
  ANALYTICS_SOURCE_LABELS,
  ANALYTICS_SOURCES,
  DEFAULT_ANALYTICS_RANGE,
  type AnalyticsDevice,
  type AnalyticsOverview,
  type AnalyticsPoint,
  type AnalyticsRange,
} from "../../shared/analytics";
import { localeFor } from "../i18n";
import { apiRequest } from "../lib/api";
import { useWorkspace } from "../workspace";

const DEVICE_LABELS: Record<AnalyticsDevice, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
};

function rangeLabel(range: AnalyticsRange) {
  if (range === 7) return "Last 7 days";
  if (range === 30) return "Last 30 days";
  return "Last 90 days";
}

function formatNumber(value: number, language: string) {
  return new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: 0 }).format(value);
}

/** Share of a total, guarding the divide-by-zero case. */
function percentOf(value: number, total: number) {
  if (total <= 0) return 0;
  return (value / total) * 100;
}

function formatPercent(value: number) {
  const clamped = Math.min(100, Math.max(0, value));
  return `${clamped >= 10 ? clamped.toFixed(0) : clamped.toFixed(1)}%`;
}

export function AdminAnalyticsPage() {
  const { session } = useWorkspace();
  const { t } = useTranslation();
  if (!session.isPlatformAdmin)
    return (
      <div className="route-state">
        <strong>{t("Platform administrator access is required")}</strong>
      </div>
    );
  return <AnalyticsDashboard />;
}

function AnalyticsDashboard() {
  const { i18n, t } = useTranslation();
  const [days, setDays] = useState<AnalyticsRange>(DEFAULT_ANALYTICS_RANGE);
  /**
   * The range travels with the payload. Keeping them together is what stops a
   * 30-day total from being rendered under an active "Last 90 days" button while
   * the wider request is still in flight, or after it fails.
   */
  const [data, setData] = useState<{ days: AnalyticsRange; overview: AnalyticsOverview } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const latestRequest = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++latestRequest.current;
      const requestedDays = days;
      setLoading(true);
      try {
        const payload = await apiRequest<{ data: AnalyticsOverview }>(
          `/api/admin/analytics?days=${requestedDays}`,
          { signal },
        );
        if (!signal?.aborted && requestId === latestRequest.current) {
          setData({ days: requestedDays, overview: payload.data });
          setError("");
        }
      } catch {
        if (!signal?.aborted && requestId === latestRequest.current)
          setError(t("Could not load traffic analytics"));
      } finally {
        if (!signal?.aborted && requestId === latestRequest.current) setLoading(false);
      }
    },
    [days, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const format = (value: number) => formatNumber(value, i18n.language);
  const overview = data?.days === days ? data.overview : null;
  const totals = overview?.totals;
  const hasTraffic = (totals?.pageViews ?? 0) > 0;

  return (
    <div className="dashboard-page analytics-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">{t("Platform administration")}</span>
          <h1>{t("Traffic analytics")}</h1>
          <p className="page-intro">
            {t("Page views reported by visitors' browsers across every page.")}
          </p>
        </div>
        <div className="analytics-range" role="group" aria-label={t("Date range")}>
          {ANALYTICS_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              className={
                range === days ? "analytics-range-button active" : "analytics-range-button"
              }
              aria-pressed={range === days}
              disabled={loading && range === days}
              onClick={() => setDays(range)}
            >
              {t(rangeLabel(range))}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="settings-error" role="alert">
          {error}
          <button className="text-button" type="button" onClick={() => void load()}>
            {t("Try again")}
          </button>
        </div>
      )}

      {loading && !overview && (
        <p className="analytics-loading" role="status">
          {t("Loading traffic analytics…")}
        </p>
      )}

      {overview && (
        <>
          {overview.historyStartsAt && (
            <p className="analytics-note">
              {t("Collecting data since {{date}}", { date: overview.historyStartsAt })}
            </p>
          )}

          <section className="analytics-kpi-grid">
            <article className="panel analytics-kpi">
              <span className="eyebrow">{t("Page views")}</span>
              <strong className="analytics-kpi-value">{format(overview.totals.pageViews)}</strong>
              <Delta current={overview.totals.pageViews} previous={overview.previous.pageViews} />
            </article>
            <article className="panel analytics-kpi">
              <span className="eyebrow">{t("Unique visitors")}</span>
              <strong className="analytics-kpi-value">{format(overview.totals.visitors)}</strong>
              <Delta current={overview.totals.visitors} previous={overview.previous.visitors} />
            </article>
          </section>

          {hasTraffic ? (
            <>
              <section className="analytics-section">
                <article className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{t("Audience")}</span>
                      <h2>{t("Page views over time")}</h2>
                    </div>
                  </div>
                  <TrafficChart series={overview.series} />
                </article>
              </section>

              <section className="analytics-section">
                <article className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{t("Acquisition")}</span>
                      <h2>{t("Traffic sources")}</h2>
                    </div>
                  </div>
                  <div className="analytics-table-wrap">
                    <table className="analytics-table">
                      <thead>
                        <tr>
                          <th scope="col">{t("Source")}</th>
                          <th scope="col">{t("Page views")}</th>
                          <th scope="col">{t("Unique visitors")}</th>
                          <th scope="col">{t("Share")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ANALYTICS_SOURCES.map((source) => {
                          const row = overview.sources.find((item) => item.source === source);
                          const pageViews = row?.pageViews ?? 0;
                          return (
                            <tr key={source}>
                              <th scope="row">
                                <span
                                  className={`analytics-source-dot ${source}`}
                                  aria-hidden="true"
                                />
                                {t(ANALYTICS_SOURCE_LABELS[source])}
                              </th>
                              <td>{format(pageViews)}</td>
                              <td>{format(row?.visitors ?? 0)}</td>
                              <td>
                                <ShareBar
                                  percent={percentOf(pageViews, overview.totals.pageViews)}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>
              </section>

              <div className="analytics-columns">
                <article className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{t("Content")}</span>
                      <h2>
                        <FileText size={15} aria-hidden="true" /> {t("Top pages")}
                      </h2>
                    </div>
                  </div>
                  {overview.pages.length === 0 ? (
                    <p className="analytics-empty-line">{t("No data for this period")}</p>
                  ) : (
                    <ul className="analytics-list">
                      {overview.pages.slice(0, 10).map((row) => (
                        <li className="analytics-row" key={row.path}>
                          <span className="analytics-row-main">
                            <span className="analytics-path">{row.path}</span>
                          </span>
                          <span className="analytics-row-value">
                            <strong>{format(row.pageViews)}</strong>
                            <small>
                              {row.visitors === 1
                                ? t("{{visitors}} unique visitor", {
                                    visitors: format(row.visitors),
                                  })
                                : t("{{visitors}} unique visitors", {
                                    visitors: format(row.visitors),
                                  })}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>

                <article className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{t("Audience")}</span>
                      <h2>
                        <Globe2 size={15} aria-hidden="true" /> {t("Countries")}
                      </h2>
                    </div>
                  </div>
                  {overview.countries.length === 0 ? (
                    <p className="analytics-empty-line">{t("No data for this period")}</p>
                  ) : (
                    <ul className="analytics-list">
                      {overview.countries.slice(0, 10).map((row) => (
                        <li className="analytics-row" key={row.country}>
                          <span className="analytics-row-main">
                            <span className="analytics-country">{row.country.toUpperCase()}</span>
                          </span>
                          <span className="analytics-row-value">
                            <strong>{format(row.pageViews)}</strong>
                          </span>
                          <ShareBar percent={percentOf(row.pageViews, overview.totals.pageViews)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </article>

                <article className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{t("Audience")}</span>
                      <h2>
                        <Smartphone size={15} aria-hidden="true" /> {t("Devices")}
                      </h2>
                    </div>
                  </div>
                  <ul className="analytics-list">
                    {ANALYTICS_DEVICES.map((device) => {
                      const row = overview.devices.find((item) => item.device === device);
                      const pageViews = row?.pageViews ?? 0;
                      return (
                        <li className="analytics-row" key={device}>
                          <span className="analytics-row-main">
                            <span>{t(DEVICE_LABELS[device])}</span>
                          </span>
                          <span className="analytics-row-value">
                            <strong>{format(pageViews)}</strong>
                          </span>
                          <ShareBar percent={percentOf(pageViews, overview.totals.pageViews)} />
                        </li>
                      );
                    })}
                  </ul>
                </article>
              </div>

              <div className="analytics-columns">
                <article className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{t("Acquisition")}</span>
                      <h2>
                        <Link2 size={15} aria-hidden="true" /> {t("Top referrers")}
                      </h2>
                    </div>
                  </div>
                  {overview.referrers.length === 0 ? (
                    <p className="analytics-empty-line">{t("No data for this period")}</p>
                  ) : (
                    <ul className="analytics-list">
                      {overview.referrers.slice(0, 10).map((row) => (
                        <li className="analytics-row" key={`${row.source}:${row.host}`}>
                          <span className="analytics-row-main">
                            <span className="analytics-host">{row.host}</span>
                            <span className={`analytics-tag ${row.source}`}>
                              {t(ANALYTICS_SOURCE_LABELS[row.source])}
                            </span>
                          </span>
                          <span className="analytics-row-value">
                            <strong>{format(row.pageViews)}</strong>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>

                <article className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">{t("Acquisition")}</span>
                      <h2>
                        <Tag size={15} aria-hidden="true" /> {t("Campaigns")}
                      </h2>
                    </div>
                  </div>
                  {overview.campaigns.length === 0 ? (
                    <p className="analytics-empty-line">
                      {t("No campaigns recorded for this period")}
                    </p>
                  ) : (
                    <ul className="analytics-list">
                      {overview.campaigns.slice(0, 10).map((row) => (
                        <li
                          className="analytics-row"
                          key={`${row.name}:${row.source}:${row.medium}`}
                        >
                          <span className="analytics-row-main">
                            <span className="analytics-host">{row.name}</span>
                            <small className="analytics-muted">
                              {[row.source, row.medium].filter(Boolean).join(" / ")}
                            </small>
                          </span>
                          <span className="analytics-row-value">
                            <strong>{format(row.pageViews)}</strong>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              </div>
            </>
          ) : (
            <article className="panel analytics-empty-state">
              <BarChart3 size={30} aria-hidden="true" />
              <h2>{t("No traffic recorded yet")}</h2>
              <p>{t("Views are collected from the moment this feature is deployed.")}</p>
            </article>
          )}
        </>
      )}
    </div>
  );
}

/** Percentage change against the previous period, or `null` when it had none. */
function Delta({ current, previous }: { current: number; previous: number }) {
  const { t } = useTranslation();
  if (previous <= 0)
    return (
      <p className="analytics-delta neutral">
        <span>—</span> {t("vs previous period")}
      </p>
    );
  const change = ((current - previous) / previous) * 100;
  const rounded = Math.abs(change) >= 10 ? Math.round(change) : Math.round(change * 10) / 10;
  let tone = "neutral";
  if (rounded > 0) tone = "positive";
  if (rounded < 0) tone = "negative";
  return (
    <p className={`analytics-delta ${tone}`}>
      <span>
        {rounded > 0 ? "+" : ""}
        {rounded}%
      </span>{" "}
      {t("vs previous period")}
    </p>
  );
}

function ShareBar({ percent }: { percent: number }) {
  return (
    <span className="analytics-share">
      <span className="analytics-share-track">
        <span
          className="analytics-share-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
      <span className="analytics-share-value">{formatPercent(percent)}</span>
    </span>
  );
}

/**
 * Which X axis ticks to label: every day for a week, first/middle/last for a
 * month, first + every 30th day + last for a quarter.
 */
function tickIndexes(length: number): number[] {
  if (length <= 0) return [];
  if (length <= 8) return Array.from({ length }, (_, index) => index);
  if (length <= 31) {
    const middle = Math.floor((length - 1) / 2);
    return [0, middle, length - 1].filter((value, index, all) => all.indexOf(value) === index);
  }
  const ticks = new Set<number>([0, length - 1]);
  for (let index = 30; index < length - 1; index += 30) ticks.add(index);
  return [...ticks].sort((a, b) => a - b);
}

/**
 * Dependency-free trend chart.
 *
 * The SVG box is `0 0 100 100` with `preserveAspectRatio="none"` so the plot
 * stretches to whatever width the card has, while `vector-effect` keeps stroke
 * widths constant (a stretched stroke would look like a smear). Axis labels are
 * HTML positioned by percentage, so they keep a readable font size on phones
 * instead of being scaled down with the viewBox.
 */
function TrafficChart({ series }: { series: AnalyticsPoint[] }) {
  const { t, i18n } = useTranslation();
  const maxValue = Math.max(1, ...series.map((point) => point.pageViews));
  const lastIndex = Math.max(1, series.length - 1);
  const ratioFor = (index: number) => (index / lastIndex) * 100;
  const yFor = (value: number) => 100 - (value / maxValue) * 100;
  const buildPath = (value: (point: AnalyticsPoint) => number) =>
    series
      .map((point, index) => `${index === 0 ? "M" : "L"}${ratioFor(index)} ${yFor(value(point))}`)
      .join(" ");
  const pvLine = buildPath((point) => point.pageViews);
  const uvLine = buildPath((point) => point.visitors);
  const pvArea =
    series.length < 2
      ? ""
      : `${pvLine} L ${ratioFor(series.length - 1)} 100 L ${ratioFor(0)} 100 Z`;

  const yTicks = maxValue >= 4 ? [0, Math.round(maxValue / 2), maxValue] : [0, maxValue];

  if (series.length < 2)
    return <p className="analytics-empty-line">{t("No traffic recorded yet")}</p>;

  return (
    <div className="analytics-chart" role="img" aria-label={t("Page views over time")}>
      <div className="analytics-chart-legend">
        <span>
          <i className="pv" aria-hidden="true" /> {t("Page views")}
        </span>
        <span>
          <i className="uv" aria-hidden="true" /> {t("Unique visitors")}
        </span>
      </div>
      <div className="analytics-chart-body">
        <div className="analytics-chart-axis-y" aria-hidden="true">
          {yTicks.map((tick) => (
            <span key={tick} style={{ top: `${yFor(tick)}%` }}>
              {formatNumber(tick, i18n.language)}
            </span>
          ))}
        </div>
        <div className="analytics-chart-plot">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <linearGradient id="analytics-pv-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6d5ce8" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#6d5ce8" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {yTicks.map((tick) => (
              <line
                key={tick}
                className="analytics-chart-grid"
                x1="0"
                x2="100"
                y1={yFor(tick)}
                y2={yFor(tick)}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {pvArea && <path d={pvArea} fill="url(#analytics-pv-fill)" />}
            <path
              className="analytics-chart-line pv"
              d={pvLine}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
            <path
              className="analytics-chart-line uv"
              d={uvLine}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          </svg>
          <div className="analytics-chart-axis-x" aria-hidden="true">
            {tickIndexes(series.length).map((index) => {
              const point = series[index];
              if (!point) return null;
              const ratio = ratioFor(index);
              const style =
                index === 0
                  ? { left: "0%", transform: "none" }
                  : index === series.length - 1
                    ? { left: "100%", transform: "translateX(-100%)" }
                    : { left: `${ratio}%`, transform: "translateX(-50%)" };
              return (
                <span key={point.day} style={style}>
                  {point.day.slice(5)}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
