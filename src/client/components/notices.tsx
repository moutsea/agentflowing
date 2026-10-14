import { Bell, Megaphone, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink } from "react-router-dom";

import { localizeNotice, type NoticeSummary } from "../../shared/notices";
import { apiRequest } from "../lib/api";

const NoticeContext = createContext<{
  summary: NoticeSummary;
  refresh: () => Promise<void>;
  error: boolean;
} | null>(null);

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<NoticeSummary>({ unreadCount: 0, important: null });
  const [error, setError] = useState(false);
  const latestRequest = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++latestRequest.current;
    try {
      const response = await apiRequest<{ data: NoticeSummary }>("/api/notices/summary", {
        signal,
      });
      if (!signal?.aborted && requestId === latestRequest.current) {
        setSummary(response.data);
        setError(false);
      }
    } catch {
      if (!signal?.aborted && requestId === latestRequest.current) setError(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const update = () => {
      if (!document.hidden) void refresh(controller.signal);
    };
    update();
    const interval = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", update);
    };
  }, [refresh]);
  return (
    <NoticeContext.Provider value={{ summary, refresh, error }}>{children}</NoticeContext.Provider>
  );
}

export function useNoticeSummary() {
  return useContext(NoticeContext);
}

export function NoticeNavLink() {
  const { t } = useTranslation();
  const notices = useNoticeSummary();
  const count = notices?.summary.unreadCount ?? 0;
  return (
    <NavLink
      to="/app/notices"
      aria-label={
        count > 0
          ? `${t("Announcements")}, ${t("{{count}} unread announcements", { count })}`
          : t("Announcements")
      }
      className={({ isActive }) => (isActive ? "sidebar-link active" : "sidebar-link")}
    >
      <Bell size={18} strokeWidth={1.8} />
      <span>{t("Announcements")}</span>
      {count > 0 && (
        <span className="notice-count" aria-label={t("{{count}} unread announcements", { count })}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </NavLink>
  );
}

export function NoticeBanner() {
  const { t, i18n } = useTranslation();
  const notices = useNoticeSummary();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notice = notices?.summary.important;
  const record = async (action: "read" | "dismiss") => {
    if (!notice || !notices) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/notices/${notice.id}/${action}`, { method: "POST" });
      await notices.refresh();
    } catch {
      setError(t("Could not update announcement status"));
    } finally {
      setBusy(false);
    }
  };
  if (notices?.error)
    return (
      <div className="notice-banner-error" role="status">
        {t("Could not load announcements")}
        <button className="text-button" type="button" onClick={() => void notices.refresh()}>
          {t("Try again")}
        </button>
      </div>
    );
  if (!notice) return null;
  return (
    <aside className="notice-banner" aria-label={t("Important announcement")}>
      <Megaphone size={19} />
      <div className="notice-banner-body">
        <details key={notice.id}>
          <summary>{localizeNotice(notice.title, i18n.language)}</summary>
          <p className="notice-content">{localizeNotice(notice.content, i18n.language)}</p>
          <button
            className="text-button"
            disabled={busy}
            type="button"
            onClick={() => void record("read")}
          >
            {t("Mark as read")}
          </button>
        </details>
        {error && <p role="alert">{error}</p>}
      </div>
      <Link to="/app/notices" className="text-button">
        {t("View all")}
      </Link>
      <button
        className="notice-icon-button"
        disabled={busy}
        type="button"
        aria-label={t("Dismiss announcement")}
        onClick={() => void record("dismiss")}
      >
        <X size={17} />
      </button>
    </aside>
  );
}
