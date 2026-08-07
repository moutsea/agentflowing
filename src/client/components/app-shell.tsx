import { Bot, ChevronDown, Coins, LayoutDashboard, LogOut, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { authClient } from "../auth-client";
import { apiRequest } from "../lib/api";
import { WorkspaceContext, type WorkspaceAgent, type WorkspaceSession } from "../workspace";
import { Brand } from "./brand";
import { LanguageSwitcher } from "./language-switcher";

function initials(value: string) {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "AF"
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: authSession, isPending } = authClient.useSession();
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [error, setError] = useState("");

  const refreshWorkspace = useCallback(async () => {
    const [sessionResponse, agentsResponse] = await Promise.all([
      apiRequest<{ data: WorkspaceSession }>("/api/session"),
      apiRequest<{ data: WorkspaceAgent[] }>("/api/agents"),
    ]);
    setSession(sessionResponse.data);
    setAgents(agentsResponse.data);
  }, []);

  useEffect(() => {
    if (!authSession?.user) {
      setSession(null);
      setAgents([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    refreshWorkspace()
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : t("Could not load workspace"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authSession?.user, refreshWorkspace, t]);

  const contextValue = useMemo(
    () => (session ? { session, agents, refreshWorkspace } : null),
    [agents, refreshWorkspace, session],
  );

  if (isPending || (authSession?.user && loading)) {
    return (
      <div className="route-state fullscreen">
        <span className="route-loader" />
        <strong>{t("Loading your workspace")}</strong>
        <p>{t("Preparing agents, credits, and secure session data…")}</p>
      </div>
    );
  }

  if (!authSession?.user) {
    const redirect = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/sign-in?redirect=${redirect}`} replace />;
  }

  if (error || !contextValue) {
    return (
      <div className="route-state fullscreen">
        <strong>{t("Workspace unavailable")}</strong>
        <p>{error || t("The workspace could not be initialized.")}</p>
        <button
          className="button button-dark"
          onClick={() => {
            setLoading(true);
            setError("");
            refreshWorkspace()
              .catch((caught) =>
                setError(caught instanceof Error ? caught.message : t("Could not load workspace")),
              )
              .finally(() => setLoading(false));
          }}
          type="button"
        >
          {t("Try again")}
        </button>
      </div>
    );
  }

  const activeSession = contextValue.session;
  const switchWorkspace = async (organizationId: string) => {
    if (organizationId === activeSession.organization.id) return;
    setSwitchingWorkspace(true);
    setError("");
    try {
      await apiRequest("/api/organizations/active", {
        method: "POST",
        body: JSON.stringify({ organizationId }),
      });
      await refreshWorkspace();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not switch workspace"));
    } finally {
      setSwitchingWorkspace(false);
    }
  };
  const navigation = [
    { to: "/app", label: t("Overview"), icon: LayoutDashboard, end: true },
    { to: "/app/agents", label: t("Agents"), icon: Bot, end: false },
    { to: "/app/settings", label: t("Settings"), icon: Settings2, end: false },
  ];
  const credits = activeSession.credits;
  const creditPercent = credits?.lifetimeGranted
    ? Math.min(100, Math.max(0, (credits.balance / credits.lifetimeGranted) * 100))
    : 0;

  return (
    <WorkspaceContext.Provider value={contextValue}>
      <div className="app-frame">
        <aside className="app-sidebar">
          <div className="sidebar-top">
            <Brand />
            <LanguageSwitcher className="sidebar-language" />
            <div className="workspace-switcher">
              <span className="workspace-avatar">{initials(activeSession.organization.name)}</span>
              <span>
                <strong>{activeSession.organization.name}</strong>
                <small>{t("{{role}} workspace", { role: t(activeSession.role) })}</small>
              </span>
              <ChevronDown size={15} />
              <select
                aria-label={t("Active workspace")}
                disabled={switchingWorkspace}
                onChange={(event) => void switchWorkspace(event.target.value)}
                value={activeSession.organization.id}
              >
                {activeSession.organizations.map((item) => (
                  <option key={item.organization.id} value={item.organization.id}>
                    {item.organization.name} ({t(item.role)})
                  </option>
                ))}
              </select>
            </div>
            <nav className="sidebar-nav" aria-label={t("Workspace navigation")}>
              {navigation.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.label}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      isActive ? "sidebar-link active" : "sidebar-link"
                    }
                  >
                    <Icon size={18} strokeWidth={1.8} />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </nav>
          </div>

          <div className="sidebar-bottom">
            <div className="credit-widget">
              <div>
                <span className="eyebrow">
                  <Coins size={13} /> {t("Credits")}
                </span>
                <strong>{t("{{count}} available", { count: credits?.balance ?? 0 })}</strong>
              </div>
              <div className="credit-track">
                <span style={{ width: `${creditPercent}%` }} />
              </div>
              <NavLink to="/pricing">{t("Upgrade plan")}</NavLink>
            </div>
            <NavLink to="/app/settings" className="sidebar-link">
              <Settings2 size={18} strokeWidth={1.8} />
              <span>{t("Settings")}</span>
            </NavLink>
            <button
              className="user-chip"
              onClick={() => {
                void authClient.signOut().then(() => navigate("/", { replace: true }));
              }}
              type="button"
            >
              <span className="user-avatar">{initials(activeSession.user.name)}</span>
              <span>
                <strong>{activeSession.user.name}</strong>
                <small>{activeSession.user.email}</small>
              </span>
              <LogOut size={15} className="user-menu-icon" />
            </button>
          </div>
        </aside>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </WorkspaceContext.Provider>
  );
}
