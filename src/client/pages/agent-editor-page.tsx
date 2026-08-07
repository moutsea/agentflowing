import { Archive, ArrowLeft, Play, Save, Sparkles } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";

import { apiRequest } from "../lib/api";
import { useWorkspace, type WorkspaceAgent } from "../workspace";
import { AI_MODEL_CATALOG, DEFAULT_AI_MODEL_ID } from "../../shared/ai-models";

type AgentInput = Pick<
  WorkspaceAgent,
  | "slug"
  | "name"
  | "description"
  | "systemPrompt"
  | "model"
  | "creditCost"
  | "status"
  | "visibility"
>;

const emptyAgent: AgentInput = {
  slug: "",
  name: "",
  description: "",
  systemPrompt: "You are a focused AI agent. Complete the user's goal with clear, useful output.",
  model: DEFAULT_AI_MODEL_ID,
  creditCost: 1,
  status: "draft",
  visibility: "workspace",
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function AgentEditorPage({ create = false }: { create?: boolean }) {
  const { t } = useTranslation();
  const { agentId = "" } = useParams();
  const navigate = useNavigate();
  const { agents, session, refreshWorkspace } = useWorkspace();
  const existing = create ? undefined : agents.find((item) => item.id === agentId);
  const [input, setInput] = useState<AgentInput>(existing ?? emptyAgent);
  const [slugEdited, setSlugEdited] = useState(!create);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canManage = session.role === "owner" || session.role === "admin";

  useEffect(() => {
    if (existing) setInput(existing);
  }, [existing]);

  if (!create && !existing) {
    return (
      <div className="route-state">
        <strong>{t("Agent not found")}</strong>
        <p>{t("This agent is not available in the active workspace.")}</p>
        <Link className="button button-light" to="/app/agents">
          {t("Back to agents")}
        </Link>
      </div>
    );
  }

  const setField = <Key extends keyof AgentInput>(key: Key, value: AgentInput[Key]) => {
    setInput((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage) return;
    setSaving(true);
    setError("");
    try {
      const response = await apiRequest<{ data: WorkspaceAgent }>(
        create ? "/api/agents" : `/api/agents/${encodeURIComponent(agentId)}`,
        {
          method: create ? "POST" : "PATCH",
          body: JSON.stringify(input),
        },
      );
      await refreshWorkspace();
      if (create) navigate(`/app/agents/${response.data.id}`, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not save agent"));
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!existing || !canManage || !window.confirm(t("Archive {{name}}?", { name: existing.name })))
      return;
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/api/agents/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
      await refreshWorkspace();
      navigate("/app/agents", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not archive agent"));
      setSaving(false);
    }
  };

  return (
    <div className="dashboard-page editor-page">
      <header className="editor-header">
        <div>
          <Link className="back-link" to="/app/agents">
            <ArrowLeft size={14} /> {t("Agents")}
          </Link>
          <span className="eyebrow">
            {create ? t("NEW PRODUCT") : t("AGENT / {{slug}}", { slug: input.slug })}
          </span>
          <h1>{create ? t("Create an agent") : input.name}</h1>
        </div>
        <div className="header-actions">
          {!create && input.status === "live" && (
            <Link className="button button-light" to={`/app/agents/${agentId}/run`}>
              <Play size={15} /> {t("Run agent")}
            </Link>
          )}
          {canManage && (
            <button
              className="button button-dark"
              disabled={saving}
              form="agent-form"
              type="submit"
            >
              <Save size={15} /> {saving ? t("Saving…") : t("Save changes")}
            </button>
          )}
        </div>
      </header>

      <form className="editor-layout" id="agent-form" onSubmit={submit}>
        <div className="editor-fields">
          <section className="panel form-section">
            <div className="section-heading">
              <span className="section-icon violet">
                <Sparkles size={17} />
              </span>
              <div>
                <h2>{t("Product identity")}</h2>
                <p>{t("What customers see when they choose this agent.")}</p>
              </div>
            </div>
            <div className="field-grid two-columns">
              <label>
                <span>{t("Name")}</span>
                <input
                  disabled={!canManage}
                  maxLength={80}
                  onChange={(event) => {
                    const name = event.target.value;
                    setInput((current) => ({
                      ...current,
                      name,
                      slug: slugEdited ? current.slug : slugify(name),
                    }));
                  }}
                  required
                  value={input.name}
                />
              </label>
              <label>
                <span>{t("Slug")}</span>
                <input
                  disabled={!canManage}
                  maxLength={64}
                  onChange={(event) => {
                    setSlugEdited(true);
                    setField("slug", slugify(event.target.value));
                  }}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  required
                  value={input.slug}
                />
              </label>
            </div>
            <label>
              <span>{t("Description")}</span>
              <textarea
                disabled={!canManage}
                maxLength={500}
                onChange={(event) => setField("description", event.target.value)}
                placeholder={t("Explain the outcome this agent delivers.")}
                rows={3}
                value={input.description}
              />
            </label>
          </section>

          <section className="panel form-section">
            <div className="section-heading">
              <span className="section-icon lime">AI</span>
              <div>
                <h2>{t("Runtime instructions")}</h2>
                <p>{t("The prompt and Workers AI model used for every run.")}</p>
              </div>
            </div>
            <label>
              <span>{t("System prompt")}</span>
              <textarea
                className="prompt-field"
                disabled={!canManage}
                maxLength={20_000}
                minLength={10}
                onChange={(event) => setField("systemPrompt", event.target.value)}
                required
                rows={9}
                value={input.systemPrompt}
              />
            </label>
            <label>
              <span>{t("Workers AI model")}</span>
              <select
                disabled={!canManage}
                onChange={(event) => setField("model", event.target.value)}
                required
                value={input.model}
              >
                {AI_MODEL_CATALOG.map((model) => (
                  <option key={model.id} value={model.id}>
                    {t("{{name}} · minimum {{count}} credits", {
                      name: model.name,
                      count: model.minimumCreditCost,
                    })}
                  </option>
                ))}
              </select>
            </label>
          </section>
        </div>

        <aside className="editor-sidebar">
          <section className="panel form-section">
            <h2>{t("Release settings")}</h2>
            <label>
              <span>{t("Status")}</span>
              <select
                disabled={!canManage}
                onChange={(event) => setField("status", event.target.value as AgentInput["status"])}
                value={input.status}
              >
                <option value="draft">{t("Draft")}</option>
                <option value="live">{t("Live")}</option>
                <option value="archived">{t("Archived")}</option>
              </select>
            </label>
            <label>
              <span>{t("Visibility")}</span>
              <select
                disabled={!canManage}
                onChange={(event) =>
                  setField("visibility", event.target.value as AgentInput["visibility"])
                }
                value={input.visibility}
              >
                <option value="private">{t("Private")}</option>
                <option value="workspace">{t("Workspace")}</option>
                <option value="public">{t("Public")}</option>
              </select>
            </label>
            <label>
              <span>{t("Credits per model run")}</span>
              <input
                disabled={!canManage}
                max={10_000}
                min={1}
                onChange={(event) => setField("creditCost", Number(event.target.value))}
                required
                type="number"
                value={input.creditCost}
              />
            </label>
            <div className="release-note">
              <strong>
                {input.status === "live" ? t("Available to run") : t("Not customer-facing")}
              </strong>
              <p>
                {input.status === "live"
                  ? t("New conversations can use this agent and consume credits.")
                  : t("Publish the agent when its prompt and pricing are ready.")}
              </p>
            </div>
          </section>

          {!create && canManage && (
            <button
              className="danger-action"
              disabled={saving}
              onClick={() => void archive()}
              type="button"
            >
              <Archive size={15} /> {t("Archive agent")}
            </button>
          )}
          {!canManage && (
            <p className="permission-note">{t("Only owners and admins can edit agents.")}</p>
          )}
          {error && <div className="form-error">{error}</div>}
        </aside>
      </form>
    </div>
  );
}
