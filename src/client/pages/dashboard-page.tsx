import {
  ArrowRight,
  Bot,
  Check,
  Coins,
  Gauge,
  Radio,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { apiRequest } from "../lib/api";
import { localeFor } from "../i18n";
import { useWorkspace } from "../workspace";

type CreditEntry = {
  id: string;
  delta: number;
  type: string;
  description: string;
  createdAt: string;
};

const tones = ["violet", "lime", "coral", "sky"];

export function DashboardPage() {
  const { i18n, t } = useTranslation();
  const { session, agents } = useWorkspace();
  const [history, setHistory] = useState<CreditEntry[]>([]);
  const credits = session.credits;
  const liveAgents = agents.filter((item) => item.status === "live");
  const firstName = session.user.name.split(/\s+/)[0] || t("builder");
  const date = new Intl.DateTimeFormat(localeFor(i18n.resolvedLanguage), {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());

  useEffect(() => {
    void apiRequest<{ data: { history: CreditEntry[] } }>("/api/credits")
      .then(({ data }) => setHistory(data.history))
      .catch(() => setHistory([]));
  }, [credits?.balance]);

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">{date}</span>
          <h1>{t("Good to see you, {{name}}.", { name: firstName })}</h1>
        </div>
        <div className="header-actions">
          <a
            className="button button-light"
            href="https://github.com"
            rel="noreferrer"
            target="_blank"
          >
            {t("Read the docs")}
          </a>
          {liveAgents[0] && (
            <Link className="button button-dark" to={`/app/agents/${liveAgents[0].id}/run`}>
              <Sparkles size={16} /> {t("Start a run")}
            </Link>
          )}
        </div>
      </header>

      <section className="metric-grid">
        <article className="metric-card">
          <span className="metric-icon lime">
            <Coins size={19} />
          </span>
          <div>
            <small>{t("Available credits")}</small>
            <strong>{credits?.balance ?? 0}</strong>
            <span>{t("ready to spend")}</span>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon violet">
            <Gauge size={19} />
          </span>
          <div>
            <small>{t("Lifetime usage")}</small>
            <strong>{credits?.lifetimeSpent ?? 0}</strong>
            <span>{t("credits settled")}</span>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon coral">
            <Bot size={19} />
          </span>
          <div>
            <small>{t("Published agents")}</small>
            <strong>{liveAgents.length}</strong>
            <span>{t("{{count}} total configured", { count: agents.length })}</span>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon sky">
            <ShieldCheck size={19} />
          </span>
          <div>
            <small>{t("Workspace access")}</small>
            <strong className="metric-word">{t(session.role)}</strong>
            <span>{t("organization scoped")}</span>
          </div>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel revenue-panel launch-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("LAUNCH PATH")}</span>
              <h2>{t("Your monetized agent foundation")}</h2>
            </div>
            <span className="status live">
              <i /> {t("Ready")}
            </span>
          </div>
          <div className="launch-checklist">
            <div>
              <span>
                <Check size={14} />
              </span>
              <p>
                <strong>{t("Workspace and identity")}</strong>
                <small>{t("Better Auth organization boundary")}</small>
              </p>
            </div>
            <div>
              <span>
                <Check size={14} />
              </span>
              <p>
                <strong>{t("Durable conversations")}</strong>
                <small>{t("One stateful Agent per D1 chat")}</small>
              </p>
            </div>
            <div>
              <span>
                <Check size={14} />
              </span>
              <p>
                <strong>{t("Usage enforcement")}</strong>
                <small>{t("Immutable ledger and overdraft triggers")}</small>
              </p>
            </div>
            <div className="next">
              <span>
                <TrendingUp size={14} />
              </span>
              <p>
                <strong>{t("Connect your Stripe catalog")}</strong>
                <small>{t("Turn plans into recurring revenue")}</small>
              </p>
            </div>
          </div>
        </article>

        <article className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("CREDIT LEDGER")}</span>
              <h2>{t("Recent activity")}</h2>
            </div>
            <Radio size={17} />
          </div>
          <div className="activity-list">
            {history.slice(0, 4).map((entry) => (
              <div key={entry.id}>
                <span className={`activity-icon ${entry.delta >= 0 ? "lime" : "violet"}`}>
                  {entry.delta >= 0 ? <Coins size={15} /> : <Zap size={15} />}
                </span>
                <p>
                  <strong>{t(entry.description)}</strong>
                  <small>{t(entry.type.replaceAll("_", " "))}</small>
                </p>
                <time>
                  {entry.delta > 0 ? "+" : ""}
                  {entry.delta}
                </time>
              </div>
            ))}
            {history.length === 0 && (
              <div className="empty-activity">{t("Your first agent run will appear here.")}</div>
            )}
          </div>
          <Link className="panel-link" to="/pricing">
            {t("View plans")} <ArrowRight size={14} />
          </Link>
        </article>
      </section>

      <section className="agents-section" id="agents">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{t("YOUR PRODUCTS")}</span>
            <h2>{t("Agents")}</h2>
          </div>
          <span>{t("{{count}} configured", { count: agents.length })}</span>
        </div>
        <div className="agent-card-grid">
          {agents.map((item, index) => (
            <Link className="agent-card" to={`/app/agents/${item.id}`} key={item.id}>
              <div className={`agent-card-icon ${tones[index % tones.length]}`}>
                <Bot size={22} />
              </div>
              <div className="agent-card-title">
                <div>
                  <h3>{item.name}</h3>
                  <p>{item.description}</p>
                </div>
                <span className={item.status === "live" ? "status live" : "status"}>
                  <i /> {t(item.status === "live" ? "Live" : item.status)}
                </span>
              </div>
              <div className="agent-card-footer">
                <span>
                  <strong>{item.creditCost}</strong>{" "}
                  {t(item.creditCost === 1 ? "credit / model run" : "credits / model run")}
                </span>
                <span>
                  {t("Configure")} <ArrowRight size={14} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
