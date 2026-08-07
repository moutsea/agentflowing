import {
  ArrowRight,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Send,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { authClient } from "../auth-client";
import { Brand } from "../components/brand";
import { LanguageSwitcher } from "../components/language-switcher";
import i18n from "../i18n";
import { apiRequest } from "../lib/api";

type AuthMode = "sign-in" | "sign-up";
type AuthMethod = "magic-link" | "password";
type AuthCapabilities = {
  emailDelivery: boolean;
  emailPassword: boolean;
  github: boolean;
  google: boolean;
  magicLink: boolean;
  passwordReset: boolean;
};
type AuthCapabilityState = AuthCapabilities & { loaded: boolean };

const defaultCapabilities: AuthCapabilityState = {
  emailDelivery: false,
  emailPassword: true,
  github: false,
  google: false,
  loaded: false,
  magicLink: false,
  passwordReset: false,
};

function safeRedirect(search: string) {
  const candidate = new URLSearchParams(search).get("redirect");
  return candidate?.startsWith("/") && !candidate.startsWith("//") ? candidate : "/app";
}

function authRoute(path: string, redirectTo: string) {
  return `${path}?redirect=${encodeURIComponent(redirectTo)}`;
}

function useAuthCapabilities() {
  const [capabilities, setCapabilities] = useState(defaultCapabilities);

  useEffect(() => {
    let active = true;
    void apiRequest<AuthCapabilities>("/api/auth/capabilities")
      .then((result) => {
        if (active) setCapabilities({ ...result, loaded: true });
      })
      .catch(() => {
        if (active) setCapabilities({ ...defaultCapabilities, loaded: true });
      });
    return () => {
      active = false;
    };
  }, []);

  return capabilities;
}

function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="auth-brand-row">
          <Brand />
          <LanguageSwitcher />
        </div>
        <div className="auth-story-copy">
          <span className="eyebrow">{t("BUILD ON THE EDGE")}</span>
          <h1>{t("Agents that are ready to earn.")}</h1>
          <p>
            {t(
              "Authentication, workspaces, durable conversations, usage credits, and billing foundations—all in one Worker.",
            )}
          </p>
        </div>
        <div className="auth-proof">
          <span>{t("Cloudflare native")}</span>
          <span>{t("MIT licensed")}</span>
          <span>{t("Deploy in minutes")}</span>
        </div>
      </section>
      <section className="auth-form-panel">{children}</section>
    </main>
  );
}

function AuthHeading({
  eyebrow,
  icon,
  title,
  description,
}: {
  description: string;
  eyebrow: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <>
      <span className="auth-lock">{icon}</span>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </>
  );
}

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const capabilities = useAuthCapabilities();
  const { data: session, isPending } = authClient.useSession();
  const [method, setMethod] = useState<AuthMethod>("password");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [socialProvider, setSocialProvider] = useState<"github" | "google" | null>(null);
  const isSignUp = mode === "sign-up";
  const redirectTo = safeRedirect(location.search);
  const hasSocialProviders = capabilities.github || capabilities.google;

  if (!isPending && session?.user) {
    return <Navigate to={redirectTo} replace />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSent(false);
    setSubmitting(true);
    try {
      if (method === "magic-link") {
        const result = await authClient.signIn.magicLink({
          callbackURL: redirectTo,
          email: email.trim(),
          errorCallbackURL: authRoute("/sign-in", redirectTo),
          metadata: { locale: i18n.resolvedLanguage ?? i18n.language },
          name: isSignUp ? name.trim() : undefined,
          newUserCallbackURL: redirectTo,
        });
        if (result.error) {
          setError(result.error.message || t("Authentication failed"));
          return;
        }
        setSent(true);
        return;
      }

      const result = isSignUp
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(result.error.message || t("Authentication failed"));
        return;
      }
      navigate(redirectTo, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Authentication failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const signInWithSocial = async (provider: "github" | "google") => {
    setError("");
    setSocialProvider(provider);
    try {
      const result = await authClient.signIn.social({
        callbackURL: redirectTo,
        errorCallbackURL: authRoute("/sign-in", redirectTo),
        provider,
      });
      if (result.error) {
        setError(result.error.message || t("Social sign-in failed"));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Social sign-in failed"));
    } finally {
      setSocialProvider(null);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-form-card">
        <AuthHeading
          description={
            isSignUp
              ? t("Your personal workspace and starter credits are created automatically.")
              : t("Sign in to manage agents, conversations, and usage.")
          }
          eyebrow={isSignUp ? t("CREATE A WORKSPACE") : t("WELCOME BACK")}
          icon={<LockKeyhole size={18} />}
          title={isSignUp ? t("Launch your first agent.") : t("Continue building.")}
        />

        {hasSocialProviders && (
          <>
            <div className="auth-provider-grid">
              {capabilities.google && (
                <button
                  className="button button-light auth-provider"
                  disabled={socialProvider !== null}
                  onClick={() => void signInWithSocial("google")}
                  type="button"
                >
                  {socialProvider === "google" ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <span className="auth-provider-letter">G</span>
                  )}
                  Google
                </button>
              )}
              {capabilities.github && (
                <button
                  className="button button-light auth-provider"
                  disabled={socialProvider !== null}
                  onClick={() => void signInWithSocial("github")}
                  type="button"
                >
                  {socialProvider === "github" ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <span className="auth-provider-letter">GH</span>
                  )}
                  GitHub
                </button>
              )}
            </div>
            <div className="auth-divider">
              <span />
              <small>{t("OR USE EMAIL")}</small>
              <span />
            </div>
          </>
        )}

        {capabilities.magicLink && (
          <div className="auth-method-switch" aria-label={t("Email sign-in method")}>
            <button
              className={method === "password" ? "active" : undefined}
              onClick={() => {
                setError("");
                setMethod("password");
                setSent(false);
              }}
              type="button"
            >
              <KeyRound size={14} />
              {t("Password")}
            </button>
            <button
              className={method === "magic-link" ? "active" : undefined}
              onClick={() => {
                setError("");
                setMethod("magic-link");
                setSent(false);
              }}
              type="button"
            >
              <Send size={14} />
              {t("Magic link")}
            </button>
          </div>
        )}

        <form className="auth-form" onSubmit={submit}>
          {isSignUp && (
            <label>
              <span>{t("Name")}</span>
              <div>
                <UserRound size={16} />
                <input
                  autoComplete="name"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ada Lovelace"
                  required
                  value={name}
                />
              </div>
            </label>
          )}
          <label>
            <span>{t("Email")}</span>
            <div>
              <Mail size={16} />
              <input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />
            </div>
          </label>
          {method === "password" && (
            <label>
              <span className="auth-label-row">
                <span>{t("Password")}</span>
                {!isSignUp && capabilities.passwordReset && (
                  <Link to={authRoute("/forgot-password", redirectTo)}>
                    {t("Forgot password?")}
                  </Link>
                )}
              </span>
              <div>
                <LockKeyhole size={16} />
                <input
                  autoComplete={isSignUp ? "new-password" : "current-password"}
                  minLength={8}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("At least 8 characters")}
                  required
                  type="password"
                  value={password}
                />
              </div>
            </label>
          )}
          {error && <div className="auth-error">{error}</div>}
          {sent && (
            <div className="auth-success">{t("Check your email for a secure sign-in link.")}</div>
          )}
          <button className="button button-dark auth-submit" disabled={submitting} type="submit">
            {submitting ? (
              <LoaderCircle className="spin" size={17} />
            ) : method === "magic-link" ? (
              <Send size={17} />
            ) : (
              <ArrowRight size={17} />
            )}
            {method === "magic-link"
              ? t("Email me a sign-in link")
              : isSignUp
                ? t("Create free workspace")
                : t("Sign in")}
          </button>
        </form>

        <small className="auth-switch">
          {isSignUp ? t("Already have an account?") : t("New to AgentFlowing?")}{" "}
          <Link to={authRoute(isSignUp ? "/sign-in" : "/sign-up", redirectTo)}>
            {isSignUp ? t("Sign in") : t("Create an account")}
          </Link>
        </small>
      </div>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const capabilities = useAuthCapabilities();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const redirectTo = safeRedirect(location.search);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: "/reset-password",
      });
      if (result.error) {
        setError(result.error.message || t("Could not send reset email"));
        return;
      }
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not send reset email"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-form-card">
        <AuthHeading
          description={t("Enter your account email and we will send a secure reset link.")}
          eyebrow={t("ACCOUNT RECOVERY")}
          icon={<Mail size={18} />}
          title={t("Reset your password.")}
        />
        {!capabilities.loaded ? (
          <div className="auth-loading auth-notice">
            <LoaderCircle className="spin" size={16} />
            {t("Loading sign-in options")}
          </div>
        ) : !capabilities.passwordReset ? (
          <div className="auth-error auth-notice">
            {t("Password reset email is not configured.")}
          </div>
        ) : sent ? (
          <div className="auth-success auth-notice">
            {t("If an account exists for that email, a reset link is on its way.")}
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label>
              <span>{t("Email")}</span>
              <div>
                <Mail size={16} />
                <input
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  required
                  type="email"
                  value={email}
                />
              </div>
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="button button-dark auth-submit" disabled={submitting} type="submit">
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
              {t("Send reset link")}
            </button>
          </form>
        )}
        <small className="auth-switch">
          <Link to={authRoute("/sign-in", redirectTo)}>{t("Back to sign in")}</Link>
        </small>
      </div>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const parameters = new URLSearchParams(location.search);
  const token = parameters.get("token");
  const invalidToken = !token || parameters.has("error");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError(t("Passwords do not match"));
      return;
    }
    if (!token) return;
    setSubmitting(true);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(result.error.message || t("Could not reset password"));
        return;
      }
      setComplete(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not reset password"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <div className="auth-form-card">
        <AuthHeading
          description={t("Choose a new password with at least 8 characters.")}
          eyebrow={t("ACCOUNT RECOVERY")}
          icon={<KeyRound size={18} />}
          title={t("Choose a new password.")}
        />
        {invalidToken ? (
          <div className="auth-error auth-notice">
            {t("This reset link is invalid or has expired.")}
          </div>
        ) : complete ? (
          <div className="auth-success auth-notice">{t("Your password has been reset.")}</div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label>
              <span>{t("New password")}</span>
              <div>
                <LockKeyhole size={16} />
                <input
                  autoComplete="new-password"
                  minLength={8}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("At least 8 characters")}
                  required
                  type="password"
                  value={password}
                />
              </div>
            </label>
            <label>
              <span>{t("Confirm password")}</span>
              <div>
                <LockKeyhole size={16} />
                <input
                  autoComplete="new-password"
                  minLength={8}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder={t("Repeat your password")}
                  required
                  type="password"
                  value={confirmPassword}
                />
              </div>
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="button button-dark auth-submit" disabled={submitting} type="submit">
              {submitting ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
              {t("Reset password")}
            </button>
          </form>
        )}
        <small className="auth-switch">
          <Link to="/sign-in">
            {complete ? t("Sign in with your new password") : t("Back to sign in")}
          </Link>
        </small>
      </div>
    </AuthLayout>
  );
}
