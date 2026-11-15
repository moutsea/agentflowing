import { Check, Clipboard, KeyRound, RefreshCw, Search, Ticket, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { apiRequest, ApiError } from "../lib/api";
import { useWorkspace } from "../workspace";

type CodeKind = "coupon" | "redemption";
type CodeStatus = "active" | "used" | "expired" | "revoked";

type CodeDetails = {
  id: string;
  code: string;
  status: CodeStatus;
  rate?: number;
  credits?: number;
  expiresAt: string | null;
  revokedAt?: string | null;
  redeemedAt?: string | null;
  note?: string | null;
  source?: string | null;
  usageState?: string;
  internalStatus?: string;
};

type IssuanceStatus = {
  creditsIssued: number;
  creditsRemaining: number;
  dailyCreditsCap: number;
  codeCount: number;
  capReached: boolean;
};

type IssueResponse = {
  data: {
    codes: Array<{ code: string; rate?: number; credits?: number; expiresAt: string | null }>;
    count: number;
    rate?: number;
    credits?: number;
    validDays: number;
    idempotencyKey?: string;
  };
};

const emptyCoupon = { rate: 20, count: 1, validDays: 7, note: "", source: "admin" };
const emptyRedemption = { credits: 5, count: 1, validDays: 30, note: "", source: "admin" };

function storedIssuanceKey(name: string) {
  try {
    return window.sessionStorage.getItem(name);
  } catch {
    return null;
  }
}

function saveIssuanceKey(name: string, key: string | null) {
  try {
    if (key) window.sessionStorage.setItem(name, key);
    else window.sessionStorage.removeItem(name);
  } catch {
    // The in-memory ref still protects double clicks when storage is blocked.
  }
}

function statusKey(status: CodeStatus) {
  return `Code status: ${status}`;
}

const requestErrorTranslations: Record<string, string> = {
  forbidden: "Invalid request origin",
  rate_limited: "Too many requests. Try again shortly.",
  invalid_request: "Check the issuance fields and try again.",
  invalid_code: "Code has an invalid format.",
  invalid_rate: "Check the issuance fields and try again.",
  invalid_valid_days: "Check the issuance fields and try again.",
  invalid_count: "Check the issuance fields and try again.",
  not_found: "Code not found",
  reserved: "Code is reserved for another payment.",
  already_used: "Code has already been used.",
  revoked: "Code has been revoked.",
  expired: "Code has expired.",
  conflict: "Code is temporarily unavailable.",
  daily_cap_reached: "Daily issuance limit reached",
  idempotency_conflict: "The Idempotency-Key was already used with different parameters.",
  idempotency_in_progress: "The Idempotency-Key is still being processed. Retry shortly.",
  internal_error: "The request could not be completed. Try again.",
};

function localizedRequestError(
  error: unknown,
  translate: (key: string) => string,
  language?: string,
) {
  if (error instanceof ApiError) {
    if (language === "zh-CN" && error.messages?.["zh-CN"]) {
      return error.messages["zh-CN"];
    }
    const fallbackKey = error.code ? requestErrorTranslations[error.code] : undefined;
    if (language === "zh-CN" && fallbackKey) return translate(fallbackKey);
    if (error.code === "daily_cap_reached") return translate("Daily issuance limit reached");
    if (error.code === "idempotency_conflict")
      return translate("The Idempotency-Key was already used with different parameters.");
    if (error.code === "invalid_request")
      return translate("Check the issuance fields and try again.");
    if (error.code === "not_found") return translate("Code not found");
    return error.message;
  }
  return translate("Network error. Try again.");
}

export function AdminCodesPage() {
  const { session } = useWorkspace();
  const { t } = useTranslation();
  if (!session.isPlatformAdmin)
    return (
      <div className="route-state">
        <strong>{t("Platform administrator access is required")}</strong>
      </div>
    );
  return <AdminCodesManager />;
}

function AdminCodesManager() {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<CodeKind>("coupon");
  const [couponForm, setCouponForm] = useState(emptyCoupon);
  const [redemptionForm, setRedemptionForm] = useState(emptyRedemption);
  const [issuanceStatus, setIssuanceStatus] = useState<IssuanceStatus | null>(null);
  const [details, setDetails] = useState<CodeDetails | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const couponKeyRef = useRef<string | null>(storedIssuanceKey("admin-coupon-issuance-key"));
  const redemptionKeyRef = useRef<string | null>(
    storedIssuanceKey("admin-redemption-issuance-key"),
  );

  const loadIssuanceStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const response = await apiRequest<IssuanceStatus & { data?: IssuanceStatus }>(
        "/api/admin/redemption-codes/issuance-status",
      );
      setIssuanceStatus(response.data ?? response);
    } catch {
      setError(t("Could not load daily issuance"));
    } finally {
      setLoadingStatus(false);
    }
  }, [t]);

  useEffect(() => {
    void loadIssuanceStatus();
  }, [loadIssuanceStatus]);

  const submitIssue = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy("issue");
    setError("");
    setNotice("");
    setDetails(null);
    try {
      const isCoupon = kind === "coupon";
      const keyRef = isCoupon ? couponKeyRef : redemptionKeyRef;
      const storageKey = isCoupon ? "admin-coupon-issuance-key" : "admin-redemption-issuance-key";
      const key = keyRef.current ?? crypto.randomUUID();
      keyRef.current = key;
      saveIssuanceKey(storageKey, key);
      const payload = isCoupon
        ? {
            ...couponForm,
            note: couponForm.note || undefined,
            source: couponForm.source || undefined,
          }
        : {
            ...redemptionForm,
            note: redemptionForm.note || undefined,
            source: redemptionForm.source || undefined,
            idempotencyKey: key,
          };
      const response = await apiRequest<IssueResponse>(
        `/api/admin/${isCoupon ? "coupons" : "redemption-codes"}`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: JSON.stringify(payload),
        },
      );
      setResult(response.data.codes.map((item) => item.code));
      setNotice(t("Codes issued successfully"));
      keyRef.current = null;
      saveIssuanceKey(storageKey, null);
      if (!isCoupon) await loadIssuanceStatus();
    } catch (caught) {
      setError(localizedRequestError(caught, t, i18n.resolvedLanguage));
    } finally {
      setBusy("");
    }
  };

  const searchCode = async (event: FormEvent) => {
    event.preventDefault();
    const value = search.trim();
    if (!value || busy) return;
    setBusy("search");
    setError("");
    setNotice("");
    setConfirmRevoke(false);
    try {
      const response = await apiRequest<CodeDetails & { data?: CodeDetails }>(
        `/api/admin/${kind === "coupon" ? "coupons" : "redemption-codes"}/${encodeURIComponent(value)}`,
      );
      setDetails(response.data ?? response);
    } catch (caught) {
      setDetails(null);
      setError(localizedRequestError(caught, t, i18n.resolvedLanguage));
    } finally {
      setBusy("");
    }
  };

  const revoke = async () => {
    if (!details || busy) return;
    setBusy("revoke");
    setError("");
    try {
      const response = await apiRequest<CodeDetails & { data?: CodeDetails }>(
        `/api/admin/${kind === "coupon" ? "coupons" : "redemption-codes"}/${encodeURIComponent(details.code)}`,
        { method: "DELETE" },
      );
      setDetails(response.data ?? response);
      setConfirmRevoke(false);
      setNotice(t("Code revoked"));
      if (kind === "redemption") await loadIssuanceStatus();
    } catch (caught) {
      setError(localizedRequestError(caught, t, i18n.resolvedLanguage));
    } finally {
      setBusy("");
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setNotice(t("Code copied"));
    } catch {
      setError(t("Could not copy code"));
    }
  };

  const formatDate = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : t("Not available");

  return (
    <div className="dashboard-page admin-codes-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">{t("Platform administration")}</span>
          <h1>{t("Manage promotional codes")}</h1>
          <p className="page-intro">{t("Issue, search, and revoke platform codes.")}</p>
        </div>
        <button
          className="text-button"
          type="button"
          onClick={() => void loadIssuanceStatus()}
          disabled={loadingStatus}
        >
          <RefreshCw size={14} className={loadingStatus ? "spin" : undefined} /> {t("Refresh")}
        </button>
      </header>

      {error && (
        <div className="settings-error" role="alert">
          {error}
          <button className="text-button" type="button" onClick={() => setError("")}>
            {t("Dismiss")}
          </button>
        </div>
      )}
      {notice && (
        <p className="admin-codes-result" role="status">
          {notice}
        </p>
      )}

      <div className="admin-codes-tabs" role="tablist" aria-label={t("Code type")}>
        <button
          type="button"
          role="tab"
          aria-selected={kind === "coupon"}
          className={kind === "coupon" ? "active" : ""}
          onClick={() => {
            setKind("coupon");
            setDetails(null);
            setResult([]);
          }}
        >
          <Ticket size={15} /> {t("Coupons")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === "redemption"}
          className={kind === "redemption" ? "active" : ""}
          onClick={() => {
            setKind("redemption");
            setDetails(null);
            setResult([]);
          }}
        >
          <KeyRound size={15} /> {t("Redemption codes")}
        </button>
      </div>

      {kind === "redemption" && issuanceStatus && (
        <section className="admin-codes-quota panel" aria-label={t("Daily issuance")}>
          <div>
            <span>{t("Credits issued today")}</span>
            <strong>{issuanceStatus.creditsIssued}</strong>
          </div>
          <div>
            <span>{t("Credits remaining")}</span>
            <strong>{issuanceStatus.creditsRemaining}</strong>
          </div>
          <div>
            <span>{t("Daily credit cap")}</span>
            <strong>{issuanceStatus.dailyCreditsCap}</strong>
          </div>
          <div>
            <span>{t("Codes issued today")}</span>
            <strong>{issuanceStatus.codeCount}</strong>
          </div>
          {issuanceStatus.capReached && (
            <p className="form-error">{t("Daily issuance limit reached")}</p>
          )}
        </section>
      )}

      <div className="admin-codes-grid">
        <form className="panel admin-codes-form" onSubmit={submitIssue}>
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("Batch issuance")}</span>
              <h2>{t(kind === "coupon" ? "Issue coupons" : "Issue redemption codes")}</h2>
            </div>
          </div>
          <fieldset disabled={Boolean(busy)}>
            <div className="field-grid two-columns">
              {kind === "coupon" ? (
                <label>
                  <span>{t("Discount rate (%)")}</span>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    step="1"
                    value={couponForm.rate}
                    onChange={(event) =>
                      setCouponForm({ ...couponForm, rate: Number(event.target.value) })
                    }
                  />
                </label>
              ) : (
                <label>
                  <span>{t("Credits")}</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={redemptionForm.credits}
                    onChange={(event) =>
                      setRedemptionForm({ ...redemptionForm, credits: Number(event.target.value) })
                    }
                  />
                </label>
              )}
              <label>
                <span>{t("Number of codes")}</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={kind === "coupon" ? couponForm.count : redemptionForm.count}
                  onChange={(event) =>
                    kind === "coupon"
                      ? setCouponForm({ ...couponForm, count: Number(event.target.value) })
                      : setRedemptionForm({ ...redemptionForm, count: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                <span>{t("Valid days")}</span>
                <input
                  type="number"
                  min="1"
                  max={kind === "coupon" ? "7" : "365"}
                  step="1"
                  value={kind === "coupon" ? couponForm.validDays : redemptionForm.validDays}
                  onChange={(event) =>
                    kind === "coupon"
                      ? setCouponForm({ ...couponForm, validDays: Number(event.target.value) })
                      : setRedemptionForm({
                          ...redemptionForm,
                          validDays: Number(event.target.value),
                        })
                  }
                />
              </label>
              <label>
                <span>{t("Source")}</span>
                <input
                  maxLength={128}
                  value={kind === "coupon" ? couponForm.source : redemptionForm.source}
                  onChange={(event) =>
                    kind === "coupon"
                      ? setCouponForm({ ...couponForm, source: event.target.value })
                      : setRedemptionForm({ ...redemptionForm, source: event.target.value })
                  }
                />
              </label>
            </div>
            <label>
              <span>{t("Note")}</span>
              <textarea
                rows={3}
                maxLength={1000}
                value={kind === "coupon" ? couponForm.note : redemptionForm.note}
                onChange={(event) =>
                  kind === "coupon"
                    ? setCouponForm({ ...couponForm, note: event.target.value })
                    : setRedemptionForm({ ...redemptionForm, note: event.target.value })
                }
              />
            </label>
            <button
              className="button button-dark admin-codes-submit"
              type="submit"
              disabled={Boolean(busy)}
            >
              {busy === "issue" ? t("Issuing…") : t("Issue codes")}
            </button>
          </fieldset>
        </form>

        <section className="panel admin-codes-search">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("Lookup")}</span>
              <h2>{t("Search a code")}</h2>
            </div>
          </div>
          <form className="admin-codes-search-form" onSubmit={searchCode}>
            <label className="sr-only" htmlFor="admin-code-search">
              {t("Code")}
            </label>
            <input
              id="admin-code-search"
              value={search}
              placeholder={t("Paste a code")}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              className="button button-dark"
              type="submit"
              disabled={Boolean(busy) || !search.trim()}
            >
              <Search size={15} /> {t("Search")}
            </button>
          </form>
          {details ? (
            <div className="admin-code-details">
              <div className="admin-code-detail-code">
                <code>{details.code}</code>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => void copy(details.code)}
                  aria-label={t("Copy code")}
                >
                  <Clipboard size={15} />
                </button>
              </div>
              <dl>
                <div>
                  <dt>{t("Status")}</dt>
                  <dd>{t(statusKey(details.status))}</dd>
                </div>
                {details.usageState && (
                  <div>
                    <dt>{t("Usage state")}</dt>
                    <dd>{t(details.usageState)}</dd>
                  </div>
                )}
                {kind === "coupon" ? (
                  <div>
                    <dt>{t("Discount rate")}</dt>
                    <dd>{details.rate}%</dd>
                  </div>
                ) : (
                  <div>
                    <dt>{t("Credits")}</dt>
                    <dd>{details.credits}</dd>
                  </div>
                )}
                <div>
                  <dt>{t("Expires")}</dt>
                  <dd>{formatDate(details.expiresAt)}</dd>
                </div>
                {details.note && (
                  <div>
                    <dt>{t("Note")}</dt>
                    <dd>{details.note}</dd>
                  </div>
                )}
                {details.source && (
                  <div>
                    <dt>{t("Source")}</dt>
                    <dd>{details.source}</dd>
                  </div>
                )}
              </dl>
              {(details.status === "active" || details.status === "expired") && !confirmRevoke && (
                <button
                  className="danger-action"
                  type="button"
                  onClick={() => setConfirmRevoke(true)}
                >
                  {t("Revoke code")}
                </button>
              )}
              {(details.status === "active" || details.status === "expired") && confirmRevoke && (
                <div className="admin-code-confirm">
                  <span>{t("Revoke this code? This cannot be undone.")}</span>
                  <button
                    className="danger-action"
                    type="button"
                    disabled={busy === "revoke"}
                    onClick={() => void revoke()}
                  >
                    {t("Confirm revoke")}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setConfirmRevoke(false)}
                  >
                    <X size={14} /> {t("Cancel")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="admin-codes-empty">
              {t("Search for a code to view status and revoke it.")}
            </p>
          )}
        </section>
      </div>

      {result.length > 0 && (
        <section className="panel admin-codes-issued">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("Recent operation")}</span>
              <h2>{t("Issued codes")}</h2>
            </div>
            <button className="text-button" type="button" onClick={() => setResult([])}>
              <Check size={14} /> {t("Done")}
            </button>
          </div>
          <p className="page-intro">
            {t("Copy these codes now; they are shown only to platform administrators.")}
          </p>
          <div className="admin-codes-list">
            {result.map((code) => (
              <code key={code}>
                {code}
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => void copy(code)}
                  aria-label={t("Copy code")}
                >
                  <Clipboard size={14} />
                </button>
              </code>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
