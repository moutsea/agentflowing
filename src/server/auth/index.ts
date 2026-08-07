import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink, organization as organizationPlugin } from "better-auth/plugins";

import { createDatabase } from "../db";
import { schema } from "../db/schema";
import { readRuntimeNumber, readRuntimeString } from "../env";
import { hasEmailDelivery, requestLocale, sendAuthEmail } from "./email";

export type AuthCapabilities = {
  emailDelivery: boolean;
  emailPassword: true;
  github: boolean;
  google: boolean;
  magicLink: boolean;
  passwordReset: boolean;
};

export function getAuthCapabilities(env: Env): AuthCapabilities {
  const emailDelivery = hasEmailDelivery(env);
  return {
    emailDelivery,
    emailPassword: true,
    github: Boolean(
      readRuntimeString(env, "GITHUB_CLIENT_ID") && readRuntimeString(env, "GITHUB_CLIENT_SECRET"),
    ),
    google: Boolean(
      readRuntimeString(env, "GOOGLE_CLIENT_ID") && readRuntimeString(env, "GOOGLE_CLIENT_SECRET"),
    ),
    magicLink: emailDelivery,
    passwordReset: emailDelivery,
  };
}

function buildAuth(env: Env) {
  const githubClientId = readRuntimeString(env, "GITHUB_CLIENT_ID");
  const githubClientSecret = readRuntimeString(env, "GITHUB_CLIENT_SECRET");
  const googleClientId = readRuntimeString(env, "GOOGLE_CLIENT_ID");
  const googleClientSecret = readRuntimeString(env, "GOOGLE_CLIENT_SECRET");
  const capabilities = getAuthCapabilities(env);
  const magicLinkExpiresIn = Math.min(
    86_400,
    Math.max(60, readRuntimeNumber(env, "MAGIC_LINK_EXPIRES_SECONDS", 900)),
  );
  const socialProviders = {
    ...(capabilities.github && githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
          },
        }
      : {}),
    ...(capabilities.google && googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          },
        }
      : {}),
  };

  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    database: drizzleAdapter(createDatabase(env), {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      ...(capabilities.passwordReset
        ? {
            resetPasswordTokenExpiresIn: 3_600,
            sendResetPassword: async (
              { user, url }: { user: { email: string }; url: string },
              request?: Request,
            ) => {
              await sendAuthEmail(env, {
                kind: "password-reset",
                locale: requestLocale(request),
                to: user.email,
                url,
              });
            },
          }
        : {}),
    },
    plugins: [
      organizationPlugin({
        allowUserToCreateOrganization: true,
        creatorRole: "owner",
      }),
      ...(capabilities.magicLink
        ? [
            magicLink({
              expiresIn: magicLinkExpiresIn,
              rateLimit: { max: 5, window: 60 },
              sendMagicLink: async ({ email, metadata, url }) => {
                await sendAuthEmail(env, {
                  kind: "magic-link",
                  locale: typeof metadata?.locale === "string" ? metadata.locale : undefined,
                  to: email,
                  url,
                });
              },
              storeToken: "hashed",
            }),
          ]
        : []),
    ],
    secret: readRuntimeString(env, "BETTER_AUTH_SECRET", { required: true }),
    socialProviders: Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
    trustedOrigins: [env.APP_URL],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

const authByEnvironment = new WeakMap<Env, Auth>();

export function createAuth(env: Env) {
  const cached = authByEnvironment.get(env);
  if (cached) return cached;
  const auth = buildAuth(env);
  authByEnvironment.set(env, auth);
  return auth;
}
