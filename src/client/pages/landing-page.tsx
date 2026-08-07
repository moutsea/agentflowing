import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  Cloud,
  Coins,
  Database,
  GitFork,
  Globe2,
  LockKeyhole,
  Play,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Brand } from "../components/brand";
import { LanguageSwitcher } from "../components/language-switcher";

const features = [
  {
    icon: Bot,
    title: "Stateful agents",
    text: "Streaming chat, persisted memory, tools, schedules, and recovery on Durable Objects.",
    tone: "violet",
  },
  {
    icon: Coins,
    title: "Billing that cannot double-spend",
    text: "Subscriptions, credit packs, immutable usage entries, and database-level idempotency.",
    tone: "lime",
  },
  {
    icon: Workflow,
    title: "Durable work",
    text: "Move long-running agent jobs into Cloudflare Workflows with retries and human approval.",
    tone: "coral",
  },
  {
    icon: LockKeyhole,
    title: "Auth and organizations",
    text: "Email, OAuth, sessions, workspaces, members, invitations, and tenant-aware access control.",
    tone: "sky",
  },
];

export function LandingPage() {
  const { t } = useTranslation();

  return (
    <div className="marketing-page">
      <header className="marketing-nav shell-width">
        <Brand />
        <nav aria-label={t("Main navigation")}>
          <a href="#product">{t("Product")}</a>
          <a href="#architecture">{t("Architecture")}</a>
          <Link to="/pricing">{t("Pricing")}</Link>
          <a href="https://github.com" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <div className="nav-actions">
          <LanguageSwitcher />
          <Link className="text-button" to="/app">
            {t("Sign in")}
          </Link>
          <Link className="button button-dark" to="/app">
            {t("Open dashboard")} <ArrowRight size={16} />
          </Link>
        </div>
      </header>

      <main>
        <section className="hero shell-width">
          <div className="hero-copy">
            <div className="status-pill">
              <span>
                <Sparkles size={13} />
              </span>
              {t("Open-source agent SaaS foundation")}
            </div>
            <h1>
              {t("Build agents.")}
              <br />
              <span>{t("Charge for outcomes.")}</span>
            </h1>
            <p>
              {t(
                "Everything between an AI prototype and a real business—auth, workspaces, durable execution, credits, subscriptions, and a polished product experience.",
              )}
            </p>
            <div className="hero-actions">
              <Link className="button button-accent" to="/sign-up?redirect=%2Fapp">
                <Play size={15} fill="currentColor" /> {t("Launch your first agent")}
              </Link>
              <a
                className="button button-light"
                href="https://github.com"
                target="_blank"
                rel="noreferrer"
              >
                <GitFork size={17} /> {t("View source")}
              </a>
            </div>
            <div className="hero-proof">
              <span>
                <Check size={14} /> {t("MIT licensed")}
              </span>
              <span>
                <Check size={14} /> {t("One-command deploy")}
              </span>
              <span>
                <Check size={14} /> {t("No server to manage")}
              </span>
            </div>
          </div>

          <div className="hero-product" aria-label={t("Agent product preview")}>
            <div className="preview-glow" />
            <div className="preview-window">
              <div className="preview-bar">
                <div className="traffic-lights">
                  <span />
                  <span />
                  <span />
                </div>
                <span>{t("Research Copilot")}</span>
                <div className="live-indicator">
                  <i /> {t("Live")}
                </div>
              </div>
              <div className="preview-body">
                <aside className="preview-rail">
                  <div className="mini-logo">A</div>
                  <span className="selected">
                    <Bot size={15} />
                  </span>
                  <span>
                    <Database size={15} />
                  </span>
                  <span>
                    <Workflow size={15} />
                  </span>
                </aside>
                <div className="preview-chat">
                  <div className="preview-date">{t("TODAY · 10:42")}</div>
                  <div className="message user-message">
                    {t("Compare the top 3 AI support tools and give me a launch angle.")}
                  </div>
                  <div className="agent-row">
                    <div className="agent-avatar">
                      <Sparkles size={14} />
                    </div>
                    <div className="message agent-message">
                      <span className="thinking">
                        <Zap size={12} /> {t("Ran 4 research tools")}
                      </span>
                      <strong>{t("The gap is outcome-based onboarding.")}</strong>
                      <p>
                        {t(
                          "Most competitors sell seats. Position yours around resolved tickets and a 7-day proof-of-value sprint.",
                        )}
                      </p>
                      <div className="source-chips">
                        <span>Intercom</span>
                        <span>G2</span>
                        <span>{t("Pricing pages")}</span>
                      </div>
                    </div>
                  </div>
                  <div className="preview-composer">
                    <span>{t("Ask a follow-up…")}</span>
                    <button type="button">
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
                <aside className="preview-inspector">
                  <span className="eyebrow">{t("THIS RUN")}</span>
                  <div className="run-stat">
                    <small>{t("Cost")}</small>
                    <strong>{t("3 credits")}</strong>
                  </div>
                  <div className="run-stat">
                    <small>{t("Duration")}</small>
                    <strong>{t("12.4 sec")}</strong>
                  </div>
                  <div className="run-steps">
                    <span className="done">
                      <Check size={12} /> {t("Plan")}
                    </span>
                    <span className="done">
                      <Check size={12} /> {t("Research")}
                    </span>
                    <span className="active">
                      <Zap size={12} /> {t("Synthesize")}
                    </span>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </section>

        <section className="trust-strip">
          <div className="shell-width">
            <span>{t("POWERED BY")}</span>
            <strong>
              <Cloud size={18} /> Cloudflare Workers
            </strong>
            <strong>
              <Boxes size={18} /> Durable Objects
            </strong>
            <strong>
              <Database size={18} /> D1 + R2
            </strong>
            <strong>
              <Globe2 size={18} /> {t("Global edge")}
            </strong>
          </div>
        </section>

        <section className="feature-section shell-width" id="product">
          <div className="section-heading">
            <span className="eyebrow">{t("FROM DEMO TO REVENUE")}</span>
            <h2>{t("The product layer your agent is missing.")}</h2>
            <p>
              {t(
                "Keep the parts every SaaS needs. Replace the prompt, tools, and domain workflow with your advantage.",
              )}
            </p>
          </div>
          <div className="feature-grid">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <article className={`feature-card ${feature.tone}`} key={feature.title}>
                  <div className="feature-icon">
                    <Icon size={22} />
                  </div>
                  <h3>{t(feature.title)}</h3>
                  <p>{t(feature.text)}</p>
                  <a href="#architecture">
                    {t("Explore the module")} <ArrowRight size={14} />
                  </a>
                </article>
              );
            })}
          </div>
        </section>

        <section className="architecture-section" id="architecture">
          <div className="shell-width architecture-grid">
            <div>
              <span className="eyebrow">{t("CLOUDFLARE-NATIVE")}</span>
              <h2>{t("Small operational footprint. Serious runtime.")}</h2>
              <p>
                {t(
                  "No Go server, Kubernetes cluster, or always-on database. Each service maps to a managed primitive with a clear responsibility.",
                )}
              </p>
              <Link className="button button-dark" to="/app">
                {t("Inspect the dashboard")} <ArrowRight size={16} />
              </Link>
            </div>
            <div className="stack-diagram">
              <div>
                <span>01</span>
                <strong>{t("React product UI")}</strong>
                <small>{t("Landing · Dashboard · Agent workspace")}</small>
              </div>
              <div>
                <span>02</span>
                <strong>{t("Worker API")}</strong>
                <small>{t("Auth · Billing · Webhooks · Tenant policies")}</small>
              </div>
              <div>
                <span>03</span>
                <strong>{t("Durable agent sessions")}</strong>
                <small>{t("Streaming · Memory · Tools · Schedules")}</small>
              </div>
              <div>
                <span>04</span>
                <strong>{t("Serverless data")}</strong>
                <small>{t("D1 ledger · R2 files · Workflow jobs")}</small>
              </div>
            </div>
          </div>
        </section>

        <section className="final-cta shell-width">
          <div>
            <span className="eyebrow">{t("BUILD THE USEFUL PART")}</span>
            <h2>{t("Your next agent should launch as a business.")}</h2>
          </div>
          <Link className="button button-accent" to="/sign-up?redirect=%2Fapp">
            {t("Start with AgentFlowing")} <ArrowRight size={17} />
          </Link>
        </section>
      </main>

      <footer className="marketing-footer shell-width">
        <Brand />
        <p>{t("Open infrastructure for independent agent businesses.")}</p>
        <span>MIT · 2026</span>
      </footer>
    </div>
  );
}
