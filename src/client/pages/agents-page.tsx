import { ArrowRight, Bot, Plus, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useWorkspace } from "../workspace";

const tones = ["violet", "lime", "coral", "sky"];

export function AgentsPage() {
  const { t } = useTranslation();
  const { agents, session } = useWorkspace();
  const canManage = session.role === "owner" || session.role === "admin";

  return (
    <div className="dashboard-page management-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">{t("AGENT CATALOG")}</span>
          <h1>{t("Products you can monetize.")}</h1>
          <p className="page-intro">
            {t(
              "Configure prompts, pricing units, visibility, and release state without touching the runtime.",
            )}
          </p>
        </div>
        {canManage && (
          <Link className="button button-dark" to="/app/agents/new">
            <Plus size={16} /> {t("New agent")}
          </Link>
        )}
      </header>

      <section className="agent-card-grid management-grid">
        {agents.map((item, index) => (
          <Link className="agent-card" to={`/app/agents/${item.id}`} key={item.id}>
            <div className={`agent-card-icon ${tones[index % tones.length]}`}>
              <Bot size={22} />
            </div>
            <div className="agent-card-title">
              <div>
                <h3>{item.name}</h3>
                <p>{item.description || t("No customer-facing description yet.")}</p>
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
                <Settings2 size={13} /> {t("Configure")} <ArrowRight size={14} />
              </span>
            </div>
          </Link>
        ))}
        {agents.length === 0 && (
          <div className="empty-catalog">
            <span>
              <Bot size={24} />
            </span>
            <h2>{t("Create your first agent product")}</h2>
            <p>{t("Define its job, cost, and visibility, then publish it when you are ready.")}</p>
            {canManage && (
              <Link className="button button-dark" to="/app/agents/new">
                <Plus size={16} /> {t("New agent")}
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
