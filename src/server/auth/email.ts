import { readRuntimeString } from "../env";

export type AuthEmailKind = "magic-link" | "password-reset";

type AuthEmailInput = {
  kind: AuthEmailKind;
  locale?: string;
  to: string;
  url: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isChinese(locale?: string) {
  return locale?.toLowerCase().startsWith("zh") ?? false;
}

function buildAuthEmail(appName: string, input: AuthEmailInput) {
  const chinese = isChinese(input.locale);
  const isMagicLink = input.kind === "magic-link";
  const subject = chinese
    ? isMagicLink
      ? `登录 ${appName}`
      : `重置你的 ${appName} 密码`
    : isMagicLink
      ? `Sign in to ${appName}`
      : `Reset your ${appName} password`;
  const heading = chinese
    ? isMagicLink
      ? "点击下方按钮登录"
      : "重置你的密码"
    : isMagicLink
      ? "Use the button below to sign in"
      : "Reset your password";
  const action = chinese
    ? isMagicLink
      ? "登录"
      : "重置密码"
    : isMagicLink
      ? "Sign in"
      : "Reset password";
  const expiry = chinese
    ? isMagicLink
      ? "此链接将在 15 分钟后失效，并且只能使用一次。"
      : "此链接将在 1 小时后失效，并且只能使用一次。"
    : isMagicLink
      ? "This link expires in 15 minutes and can only be used once."
      : "This link expires in 1 hour and can only be used once.";
  const ignore = chinese
    ? "如果这不是你的操作，可以忽略这封邮件。"
    : "If you did not request this, you can safely ignore this email.";
  const safeAppName = escapeHtml(appName);
  const safeUrl = escapeHtml(input.url);

  return {
    subject,
    text: `${heading}\n\n${input.url}\n\n${expiry}\n${ignore}`,
    html: `<!doctype html>
<html lang="${chinese ? "zh-CN" : "en"}">
  <body style="margin:0;background:#f5f3ed;color:#202226;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:48px 24px">
      <div style="background:#fffefa;border:1px solid #ddd9cf;border-radius:18px;padding:36px">
        <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#6c5ce7">${safeAppName}</div>
        <h1 style="margin:20px 0 12px;font-size:26px;line-height:1.2">${heading}</h1>
        <p style="margin:0 0 26px;color:#666970;font-size:14px;line-height:1.7">${expiry}</p>
        <a href="${safeUrl}" style="display:inline-block;border-radius:10px;padding:13px 22px;background:#202226;color:#fff;text-decoration:none;font-size:14px;font-weight:700">${action}</a>
        <p style="margin:28px 0 0;color:#8b8d92;font-size:12px;line-height:1.6">${ignore}</p>
      </div>
    </div>
  </body>
</html>`,
  };
}

export function hasEmailDelivery(env: Env) {
  const binding = Reflect.get(env, "EMAIL");
  return Boolean(
    readRuntimeString(env, "EMAIL_FROM") &&
    binding &&
    typeof binding === "object" &&
    typeof Reflect.get(binding, "send") === "function",
  );
}

export async function sendAuthEmail(env: Env, input: AuthEmailInput) {
  const from = readRuntimeString(env, "EMAIL_FROM", { required: true });
  if (!from) {
    throw new Error("Authentication email sender is not configured");
  }
  const fromName = readRuntimeString(env, "EMAIL_FROM_NAME");
  const binding = Reflect.get(env, "EMAIL") as SendEmail | undefined;
  if (!binding) {
    throw new Error("Cloudflare Email Sending binding is not configured");
  }
  const content = buildAuthEmail(env.APP_NAME, input);
  await binding.send({
    from: fromName ? { email: from, name: fromName } : from,
    to: input.to,
    ...content,
  });
}

export function requestLocale(request?: Request) {
  return request?.headers.get("accept-language")?.split(",", 1)[0]?.trim();
}
