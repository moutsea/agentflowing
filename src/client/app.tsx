import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/app-shell";
import { AgentLauncherPage } from "./pages/agent-launcher-page";
import { AgentEditorPage } from "./pages/agent-editor-page";
import { AuthPage, ForgotPasswordPage, ResetPasswordPage } from "./pages/auth-page";
import { AgentsPage } from "./pages/agents-page";
import { DashboardPage } from "./pages/dashboard-page";
import { LandingPage } from "./pages/landing-page";
import { PricingPage } from "./pages/pricing-page";
import { SettingsPage } from "./pages/settings-page";

const AgentPage = lazy(async () => ({
  default: (await import("./pages/agent-page")).AgentPage,
}));

export function App() {
  const { t } = useTranslation();

  return (
    <Suspense
      fallback={
        <div className="route-state fullscreen">
          <span className="route-loader" />
          <strong>{t("Loading AgentFlowing")}</strong>
        </div>
      }
    >
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/sign-in" element={<AuthPage mode="sign-in" />} />
        <Route path="/sign-up" element={<AuthPage mode="sign-up" />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<AppShell />}>
          <Route path="/app" element={<DashboardPage />} />
          <Route path="/app/agents" element={<AgentsPage />} />
          <Route path="/app/agents/new" element={<AgentEditorPage create />} />
          <Route path="/app/agents/:agentId" element={<AgentEditorPage />} />
          <Route path="/app/agents/:agentId/run" element={<AgentLauncherPage />} />
          <Route path="/app/chats/:chatId" element={<AgentPage />} />
          <Route path="/app/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
