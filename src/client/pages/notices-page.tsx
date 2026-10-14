import { Bell, Check, Megaphone } from "lucide-react";
import { useCallback, useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { localizeNotice, type NoticeList } from "../../shared/notices";
import { authClient } from "../auth-client";
import { Brand } from "../components/brand";
import { LanguageSwitcher } from "../components/language-switcher";
import { useNoticeSummary } from "../components/notices";
import { localeFor } from "../i18n";
import { apiRequest } from "../lib/api";

export function NoticePagination({
  page,
  total,
  pageSize,
  onChange,
  disabled,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages === 1 && page === 1) return null;
  return (
    <nav className="notice-pagination" aria-label={t("Announcement pages")}>
      <button
        className="button button-light"
        type="button"
        disabled={disabled || page <= 1}
        onClick={() => onChange(page - 1)}
      >
        {t("Previous")}
      </button>
      <span>{t("Page {{page}} of {{pages}}", { page, pages })}</span>
      <button
        className="button button-light"
        type="button"
        disabled={disabled || page >= pages}
        onClick={() => onChange(page + 1)}
      >
        {t("Next")}
      </button>
    </nav>
  );
}

export function NoticesPage({ publicView = false }: { publicView?: boolean }) {
  const { t, i18n } = useTranslation();
  const { data: session } = authClient.useSession();
  const summary = useNoticeSummary();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<NoticeList>({ data: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const latestRequest = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++latestRequest.current;
      setLoading(true);
      setError("");
      try {
        const response = await apiRequest<NoticeList>(`/api/notices?page=${page}`, { signal });
        if (!signal?.aborted && requestId === latestRequest.current) {
          const lastPage = Math.max(1, Math.ceil(response.total / response.pageSize));
          if (page > lastPage) setPage(lastPage);
          else {
            setResult(response);
            setHasLoaded(true);
          }
        }
      } catch {
        if (!signal?.aborted && requestId === latestRequest.current)
          setError(t("Could not load announcements"));
      } finally {
        if (!signal?.aborted && requestId === latestRequest.current) setLoading(false);
      }
    },
    [page, t, session?.user.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, summary?.summary]);
  const markRead = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await apiRequest(`/api/notices/${id}/read`, { method: "POST" });
      ++latestRequest.current;
      setLoading(false);
      setResult((current) => ({
        ...current,
        data: current.data.map((item) => (item.id === id ? { ...item, isRead: true } : item)),
      }));
      await summary?.refresh();
    } catch {
      setError(t("Could not update announcement status"));
    } finally {
      setBusy("");
    }
  };
  return (
    <div className={publicView ? "marketing-page" : undefined}>
      {publicView && (
        <header className="marketing-nav shell-width">
          <Brand />
          <Link className="button button-light" to="/app">
            {t("Open dashboard")}
          </Link>
        </header>
      )}
      <div className={`dashboard-page notices-page${publicView ? " shell-width" : ""}`}>
        <header className="dashboard-header">
          <div>
            <span className="eyebrow">{t("What's new")}</span>
            <h1>{t("Announcements")}</h1>
            <p className="page-intro">{t("Product updates and important news for everyone.")}</p>
          </div>
          <LanguageSwitcher />
        </header>
        {error && (
          <div className="settings-error" role="alert">
            {error}{" "}
            <button className="text-button" type="button" onClick={() => void load()}>
              {t("Try again")}
            </button>
          </div>
        )}
        {loading && (!hasLoaded || result.page !== page) ? (
          <p className="notice-empty" role="status">
            {t("Loading announcements…")}
          </p>
        ) : (
          <div className="notice-list">
            {result.data.length === 0 && !error && (
              <div className="panel notice-empty">
                <Bell size={28} />
                <h2>{t("No announcements yet")}</h2>
                <p>{t("News from the team will appear here.")}</p>
              </div>
            )}
            {result.data.map((notice) => (
              <article
                key={notice.id}
                className={`panel notice-card${notice.priority === "important" ? " notice-important" : ""}`}
              >
                <div className="notice-meta">
                  <span className={`notice-tag ${notice.priority}`}>
                    <Megaphone size={13} />
                    {t(notice.priority === "important" ? "Important" : "Update")}
                  </span>
                  <time dateTime={notice.createdAt}>
                    {new Date(notice.createdAt).toLocaleDateString(localeFor(i18n.language))}
                  </time>
                  {session && (
                    <span className="notice-read-state">
                      {t(notice.isRead ? "Read" : "Unread")}
                    </span>
                  )}
                </div>
                <h2>{localizeNotice(notice.title, i18n.language)}</h2>
                <p className="notice-content">{localizeNotice(notice.content, i18n.language)}</p>
                {session && !notice.isRead && (
                  <button
                    className="button button-light"
                    disabled={Boolean(busy)}
                    type="button"
                    onClick={() => void markRead(notice.id)}
                  >
                    <Check size={14} />
                    {t("Mark as read")}
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
        <NoticePagination
          page={page}
          total={result.total}
          pageSize={result.pageSize}
          disabled={loading || Boolean(busy)}
          onChange={setPage}
        />
      </div>
    </div>
  );
}
