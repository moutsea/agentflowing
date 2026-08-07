import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";

import { apiRequest } from "../lib/api";
import { useWorkspace } from "../workspace";

export function AgentLauncherPage() {
  const { t } = useTranslation();
  const { agentId = "" } = useParams();
  const { agents } = useWorkspace();
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState("");
  const selectedAgent = agents.find((item) => item.id === agentId);

  useEffect(() => {
    if (!selectedAgent || started.current) return;
    started.current = true;
    void apiRequest<{ data: { id: string } }>("/api/chats", {
      method: "POST",
      body: JSON.stringify({ agentId: selectedAgent.id }),
    })
      .then(({ data }) => navigate(`/app/chats/${data.id}`, { replace: true }))
      .catch((caught) => {
        started.current = false;
        setError(caught instanceof Error ? caught.message : t("Could not create a conversation"));
      });
  }, [navigate, selectedAgent, t]);

  if (!selectedAgent) {
    return (
      <div className="route-state">
        <strong>{t("Agent not found")}</strong>
        <p>{t("This agent is not available in the active workspace.")}</p>
        <Link className="button button-light" to="/app">
          {t("Back to dashboard")}
        </Link>
      </div>
    );
  }

  return (
    <div className="route-state">
      <LoaderCircle className="spin" size={24} />
      <strong>{t("Starting {{name}}", { name: selectedAgent.name })}</strong>
      <p>{error || t("Creating a durable conversation and checking workspace access…")}</p>
      {error && (
        <button
          className="button button-dark"
          onClick={() => {
            setError("");
            started.current = false;
          }}
          type="button"
        >
          {t("Try again")}
        </button>
      )}
    </div>
  );
}
