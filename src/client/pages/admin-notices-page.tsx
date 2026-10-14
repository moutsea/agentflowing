import { Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useRef, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  emptyNotice,
  localizeNotice,
  type Notice,
  type NoticeInput,
  type NoticeList,
} from "../../shared/notices";
import { LanguageSwitcher } from "../components/language-switcher";
import { useNoticeSummary } from "../components/notices";
import { localeFor } from "../i18n";
import { ApiError, apiRequest } from "../lib/api";
import { useWorkspace } from "../workspace";
import { NoticePagination } from "./notices-page";

function inputFor(notice: Notice): NoticeInput {
  return {
    title: { ...notice.title },
    content: { ...notice.content },
    priority: notice.priority,
    isActive: notice.isActive,
  };
}

export function AdminNoticesPage() {
  const { session } = useWorkspace();
  const { t } = useTranslation();
  if (!session.isPlatformAdmin)
    return (
      <div className="route-state">
        <strong>{t("Platform administrator access is required")}</strong>
      </div>
    );
  return <NoticeManager />;
}

function NoticeManager() {
  const { t, i18n } = useTranslation();
  const summary = useNoticeSummary();
  const [result, setResult] = useState<NoticeList>({ data: [], total: 0, page: 1, pageSize: 20 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editor, setEditor] = useState<{ id?: string; draft: NoticeInput } | null>(null);
  const latestRequest = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++latestRequest.current;
      setLoading(true);
      try {
        const data = await apiRequest<NoticeList>(`/api/admin/notices?page=${page}`, { signal });
        if (!signal?.aborted && requestId === latestRequest.current) {
          const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
          if (page > lastPage) setPage(lastPage);
          else setResult(data);
        }
      } catch {
        if (!signal?.aborted && requestId === latestRequest.current)
          setError(t("Could not load announcements"));
      } finally {
        if (!signal?.aborted && requestId === latestRequest.current) setLoading(false);
      }
    },
    [page, t],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const mutate = async (
    path: string,
    method: string,
    input?: NoticeInput | Pick<NoticeInput, "isActive">,
  ) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await apiRequest(path, { method, body: input ? JSON.stringify(input) : undefined });
      setEditor(null);
      setSuccess(t(method === "DELETE" ? "Announcement deleted" : "Announcement saved"));
      await Promise.all([load(), summary?.refresh()]);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "invalid_notice"
          ? t("Add a title and content together in at least one language.")
          : t("Could not save announcement. Your draft has been kept."),
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const draft: NoticeInput = {
      ...editor.draft,
      title: { en: editor.draft.title.en.trim(), zh: editor.draft.title.zh.trim() },
      content: { en: editor.draft.content.en.trim(), zh: editor.draft.content.zh.trim() },
    };
    if (
      (!draft.title.en && !draft.title.zh) ||
      (["en", "zh"] as const).some(
        (language) => Boolean(draft.title[language]) !== Boolean(draft.content[language]),
      )
    ) {
      setError(t("Add a title and content together in at least one language."));
      return;
    }
    void mutate(
      `/api/admin/notices${editor.id ? `/${editor.id}` : ""}`,
      editor.id ? "PUT" : "POST",
      draft,
    );
  };

  return (
    <div className="dashboard-page notices-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">{t("Platform administration")}</span>
          <h1>{t("Manage announcements")}</h1>
          <p className="page-intro">
            {t("Publish updates for every user, across all workspaces.")}
          </p>
        </div>
        <div className="header-actions">
          <LanguageSwitcher />
          <button
            className="button button-dark"
            type="button"
            disabled={Boolean(editor) || busy}
            onClick={() => {
              setEditor({ draft: emptyNotice() });
              setError("");
              setSuccess("");
            }}
          >
            <Plus size={16} />
            {t("New announcement")}
          </button>
        </div>
      </header>
      {error && (
        <div className="settings-error" role="alert">
          {error}
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setError("");
              void load();
            }}
          >
            {t("Try again")}
          </button>
        </div>
      )}
      {success && (
        <p className="notice-success" role="status">
          {success}
        </p>
      )}
      {editor && (
        <form className="panel form-section notice-editor" onSubmit={submit}>
          <h2>{t(editor.id ? "Edit announcement" : "New announcement")}</h2>
          <p className="page-intro">
            {t("Fill in one or both languages. Missing translations use the available language.")}
          </p>
          <fieldset disabled={busy}>
            <div className="field-grid two-columns">
              {(["en", "zh"] as const).map((language) => (
                <div key={language} className="notice-language-fields">
                  <h3>{t(language === "en" ? "English" : "Chinese")}</h3>
                  <label>
                    <span>
                      {t("Announcement title")} ({language === "en" ? "EN" : "中文"})
                    </span>
                    <input
                      maxLength={160}
                      value={editor.draft.title[language]}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          draft: {
                            ...editor.draft,
                            title: { ...editor.draft.title, [language]: event.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>
                      {t("Announcement content")} ({language === "en" ? "EN" : "中文"})
                    </span>
                    <textarea
                      rows={6}
                      maxLength={8000}
                      value={editor.draft.content[language]}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          draft: {
                            ...editor.draft,
                            content: { ...editor.draft.content, [language]: event.target.value },
                          },
                        })
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
            <div className="notice-editor-options">
              <label>
                <span>{t("Priority")}</span>
                <select
                  value={editor.draft.priority}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      draft: {
                        ...editor.draft,
                        priority: event.target.value as NoticeInput["priority"],
                      },
                    })
                  }
                >
                  <option value="normal">{t("Normal")}</option>
                  <option value="important">{t("Important")}</option>
                </select>
              </label>
              <label className="notice-checkbox">
                <input
                  type="checkbox"
                  checked={editor.draft.isActive}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      draft: { ...editor.draft, isActive: event.target.checked },
                    })
                  }
                />
                <span>{t("Published — visible to everyone")}</span>
              </label>
            </div>
            <div className="notice-preview">
              <span className="eyebrow">{t("Preview")}</span>
              <h3>
                {localizeNotice(editor.draft.title, i18n.language) || t("Announcement title")}
              </h3>
              <p className="notice-content">
                {localizeNotice(editor.draft.content, i18n.language) || t("Announcement content")}
              </p>
            </div>
            <div className="notice-actions">
              <button className="button button-dark" type="submit">
                {busy ? t("Saving…") : t(editor.draft.isActive ? "Save and publish" : "Save draft")}
              </button>
              <button className="button button-light" type="button" onClick={() => setEditor(null)}>
                {t("Cancel")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {loading ? (
        <p className="notice-empty" role="status">
          {t("Loading announcements…")}
        </p>
      ) : (
        <div className="notice-list">
          {result.data.length === 0 && !error && (
            <div className="panel notice-empty">
              <Megaphone size={28} />
              <h2>{t("No announcements yet")}</h2>
              <p>{t("Create your first announcement to keep everyone informed.")}</p>
            </div>
          )}
          {result.data.map((notice) => (
            <article className="panel notice-card" key={notice.id}>
              <div className="notice-meta">
                <span className={`notice-tag ${notice.isActive ? "published" : ""}`}>
                  {t(notice.isActive ? "Published" : "Draft / offline")}
                </span>
                <span>{t(notice.priority === "important" ? "Important" : "Normal")}</span>
                <time dateTime={notice.createdAt}>
                  {new Date(notice.createdAt).toLocaleDateString(localeFor(i18n.language))}
                </time>
              </div>
              <h2>{localizeNotice(notice.title, i18n.language)}</h2>
              <p className="notice-excerpt">{localizeNotice(notice.content, i18n.language)}</p>
              <div className="notice-actions">
                <button
                  className="button button-light"
                  type="button"
                  disabled={busy || Boolean(editor)}
                  onClick={() => {
                    setEditor({ id: notice.id, draft: inputFor(notice) });
                    setError("");
                    setSuccess("");
                    window.scrollTo({ top: 0, behavior: "instant" });
                  }}
                >
                  <Pencil size={14} />
                  {t("Edit")}
                </button>
                <button
                  className="button button-light"
                  type="button"
                  disabled={busy || Boolean(editor)}
                  onClick={() =>
                    void mutate(`/api/admin/notices/${notice.id}`, "PATCH", {
                      isActive: !notice.isActive,
                    })
                  }
                >
                  {t(notice.isActive ? "Take offline" : "Publish")}
                </button>
                <button
                  className="button button-light notice-delete"
                  type="button"
                  disabled={busy || Boolean(editor)}
                  onClick={() => {
                    if (
                      window.confirm(
                        t("Delete this announcement? It will no longer be visible to anyone."),
                      )
                    )
                      void mutate(`/api/admin/notices/${notice.id}`, "DELETE");
                  }}
                >
                  <Trash2 size={14} />
                  {t("Delete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <NoticePagination
        page={page}
        total={result.total}
        pageSize={result.pageSize}
        disabled={loading || busy || Boolean(editor)}
        onChange={setPage}
      />
    </div>
  );
}
