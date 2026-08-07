import {
  Check,
  Clipboard,
  Cloud,
  Coins,
  CreditCard,
  FileText,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LanguageSwitcher } from "../components/language-switcher";
import { apiRequest } from "../lib/api";
import { localeFor } from "../i18n";
import { useWorkspace } from "../workspace";

type Subscription = {
  id: string;
  planId: string;
  status: string;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd: boolean;
};

type ApiKeyItem = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string;
  lastUsedAt?: string | null;
  createdAt: string;
};

type FileAsset = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function SettingsPage() {
  const { i18n, t } = useTranslation();
  const { session } = useWorkspace();
  const canManage = session.role === "owner" || session.role === "admin";
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedSecret, setRevealedSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const formatDate = (value?: string | null) => {
    if (!value) return t("Never");
    return new Intl.DateTimeFormat(localeFor(i18n.resolvedLanguage), {
      dateStyle: "medium",
    }).format(new Date(value));
  };

  const load = useCallback(async () => {
    const requests: [Promise<{ data: Subscription | null }>, Promise<{ data: FileAsset[] }>] = [
      apiRequest("/api/billing/subscription"),
      apiRequest("/api/files"),
    ];
    const [subscriptionResponse, filesResponse] = await Promise.all(requests);
    setSubscription(subscriptionResponse.data);
    setFiles(filesResponse.data);
    if (canManage) {
      const keysResponse = await apiRequest<{ data: ApiKeyItem[] }>("/api/api-keys");
      setKeys(keysResponse.data);
    }
  }, [canManage]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load()
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : t("Could not load settings"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, t]);

  const openPortal = async () => {
    setBusy("portal");
    setError("");
    try {
      const { data } = await apiRequest<{ data: { portalUrl: string } }>("/api/billing/portal", {
        method: "POST",
      });
      window.location.assign(data.portalUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Billing portal is unavailable"));
      setBusy("");
    }
  };

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!newKeyName.trim()) return;
    setBusy("key");
    setError("");
    try {
      const { data } = await apiRequest<{ data: ApiKeyItem & { secret: string } }>(
        "/api/api-keys",
        {
          method: "POST",
          body: JSON.stringify({
            name: newKeyName.trim(),
            scopes: ["agents:read", "agents:run", "files:read"],
          }),
        },
      );
      setRevealedSecret(data.secret);
      setNewKeyName("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not create API key"));
    } finally {
      setBusy("");
    }
  };

  const revokeKey = async (keyId: string) => {
    if (!window.confirm(t("Revoke this API key? Existing integrations will stop working."))) return;
    setBusy(keyId);
    try {
      await apiRequest(`/api/api-keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not revoke API key"));
    } finally {
      setBusy("");
    }
  };

  const uploadFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("file");
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.[0]) return;
    const body = new FormData();
    body.set("file", fileInput.files[0]);
    setBusy("upload");
    setError("");
    try {
      await apiRequest("/api/files", { method: "POST", body });
      form.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not upload file"));
    } finally {
      setBusy("");
    }
  };

  const deleteFile = async (fileId: string) => {
    if (!window.confirm(t("Delete this file from the workspace?"))) return;
    setBusy(fileId);
    try {
      await apiRequest(`/api/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not delete file"));
    } finally {
      setBusy("");
    }
  };

  if (loading) {
    return (
      <div className="route-state">
        <span className="route-loader" />
        <strong>{t("Loading workspace settings")}</strong>
      </div>
    );
  }

  return (
    <div className="dashboard-page settings-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">{t("WORKSPACE CONTROL PLANE")}</span>
          <h1>{t("Settings")}</h1>
          <p className="page-intro">
            {t("Manage revenue, integrations, and reusable agent context.")}
          </p>
        </div>
        <LanguageSwitcher />
      </header>

      {error && <div className="settings-error">{error}</div>}

      <section className="settings-grid">
        <article className="panel settings-card billing-card">
          <div className="settings-card-heading">
            <span className="section-icon violet">
              <CreditCard size={17} />
            </span>
            <div>
              <h2>{t("Billing")}</h2>
              <p>{t("Subscription and recurring credit grants")}</p>
            </div>
          </div>
          {subscription ? (
            <div className="subscription-summary">
              <div>
                <span>{t("Current plan")}</span>
                <strong>{t(subscription.planId)}</strong>
              </div>
              <div>
                <span>{t("Status")}</span>
                <strong className="capitalize">{t(subscription.status)}</strong>
              </div>
              <div>
                <span>{subscription.cancelAtPeriodEnd ? t("Ends") : t("Renews")}</span>
                <strong>{formatDate(subscription.currentPeriodEnd)}</strong>
              </div>
            </div>
          ) : (
            <div className="subscription-empty">
              <Coins size={19} />
              <div>
                <strong>{t("Builder plan")}</strong>
                <p>{t("Upgrade to grant monthly credits automatically.")}</p>
              </div>
            </div>
          )}
          <div className="settings-actions">
            {subscription ? (
              <button
                className="button button-light"
                disabled={!canManage || busy === "portal"}
                onClick={() => void openPortal()}
                type="button"
              >
                {busy === "portal" && <LoaderCircle className="spin" size={14} />}
                {t("Manage in Stripe")}
              </button>
            ) : (
              <Link className="button button-light" to="/pricing">
                {t("View plans")}
              </Link>
            )}
          </div>
        </article>

        <article className="panel settings-card api-card">
          <div className="settings-card-heading">
            <span className="section-icon lime">
              <KeyRound size={17} />
            </span>
            <div>
              <h2>{t("API keys")}</h2>
              <p>{t("Server-to-server access to published agents")}</p>
            </div>
          </div>
          {canManage ? (
            <>
              <form className="inline-create" onSubmit={createKey}>
                <input
                  aria-label={t("API key name")}
                  maxLength={80}
                  onChange={(event) => setNewKeyName(event.target.value)}
                  placeholder={t("Production integration")}
                  value={newKeyName}
                />
                <button className="button button-dark" disabled={busy === "key"} type="submit">
                  <Plus size={14} /> {t("Create")}
                </button>
              </form>
              <div className="resource-list">
                {keys.map((item) => (
                  <div key={item.id}>
                    <span className="resource-icon">
                      <KeyRound size={15} />
                    </span>
                    <p>
                      <strong>{item.name}</strong>
                      <small>
                        {item.keyPrefix} ·{" "}
                        {t("last used {{date}}", { date: formatDate(item.lastUsedAt) })}
                      </small>
                    </p>
                    <button
                      aria-label={t("Revoke {{name}}", { name: item.name })}
                      disabled={busy === item.id}
                      onClick={() => void revokeKey(item.id)}
                      type="button"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {keys.length === 0 && <p className="resource-empty">{t("No active API keys.")}</p>}
              </div>
            </>
          ) : (
            <p className="permission-note">
              {t("Only owners and admins can view or create API keys.")}
            </p>
          )}
        </article>

        <article className="panel settings-card files-card">
          <div className="settings-card-heading">
            <span className="section-icon sky">
              <Cloud size={17} />
            </span>
            <div>
              <h2>{t("Knowledge files")}</h2>
              <p>{t("R2-backed assets, isolated by workspace")}</p>
            </div>
          </div>
          <form className="upload-form" onSubmit={uploadFile}>
            <input
              accept=".txt,.md,.csv,.json,.pdf,image/png,image/jpeg,image/webp"
              name="file"
              required
              type="file"
            />
            <button className="button button-dark" disabled={busy === "upload"} type="submit">
              {busy === "upload" ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
              {t("Upload")}
            </button>
          </form>
          <div className="resource-list file-list">
            {files.map((item) => (
              <div key={item.id}>
                <span className="resource-icon">
                  <FileText size={15} />
                </span>
                <p>
                  <a href={`/api/files/${item.id}`} rel="noreferrer" target="_blank">
                    {item.name}
                  </a>
                  <small>
                    {formatBytes(item.size)} · {formatDate(item.createdAt)}
                  </small>
                </p>
                <button
                  aria-label={t("Delete {{name}}", { name: item.name })}
                  disabled={busy === item.id}
                  onClick={() => void deleteFile(item.id)}
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {files.length === 0 && <p className="resource-empty">{t("No files uploaded yet.")}</p>}
          </div>
        </article>
      </section>

      {revealedSecret && (
        <div className="secret-backdrop" role="presentation">
          <section aria-modal="true" className="secret-dialog" role="dialog">
            <span className="section-icon lime">
              <KeyRound size={18} />
            </span>
            <h2>{t("Copy your API key now")}</h2>
            <p>
              {t(
                "For security, AgentFlowing stores only its SHA-256 hash. This secret is shown once.",
              )}
            </p>
            <code>{revealedSecret}</code>
            <button
              className="button button-dark"
              onClick={() => {
                void navigator.clipboard.writeText(revealedSecret).then(() => setCopied(true));
              }}
              type="button"
            >
              {copied ? <Check size={15} /> : <Clipboard size={15} />}
              {copied ? t("Copied") : t("Copy key")}
            </button>
            <button
              className="dialog-dismiss"
              onClick={() => {
                setRevealedSecret("");
                setCopied(false);
              }}
              type="button"
            >
              {t("I saved it securely")}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
