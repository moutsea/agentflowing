import { and, desc, eq, isNull } from "drizzle-orm";

import { createDatabase } from "../../db";
import { apiKey } from "../../db/schema";

const KEY_PREFIX = "af_live_";

function base64Url(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hashSecret(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createApiKey(params: {
  env: Env;
  organizationId: string;
  userId: string;
  name: string;
  scopes: string[];
}) {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const secret = `${KEY_PREFIX}${base64Url(random)}`;
  const id = crypto.randomUUID();
  const [created] = await createDatabase(params.env)
    .insert(apiKey)
    .values({
      id,
      organizationId: params.organizationId,
      name: params.name,
      keyHash: await hashSecret(secret),
      keyPrefix: `${secret.slice(0, KEY_PREFIX.length + 8)}…`,
      scopes: JSON.stringify(params.scopes),
      createdBy: params.userId,
    })
    .returning({
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      createdAt: apiKey.createdAt,
    });
  if (!created) throw new Error("API key was not created");
  return { ...created, secret };
}

export function listApiKeys(env: Env, organizationId: string) {
  return createDatabase(env)
    .select({
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(and(eq(apiKey.organizationId, organizationId), isNull(apiKey.revokedAt)))
    .orderBy(desc(apiKey.createdAt));
}

export async function revokeApiKey(env: Env, organizationId: string, keyId: string) {
  const result = await createDatabase(env)
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKey.id, keyId),
        eq(apiKey.organizationId, organizationId),
        isNull(apiKey.revokedAt),
      ),
    );
  return result.meta.changes > 0;
}

export async function validateApiKey(env: Env, secret: string) {
  if (!secret.startsWith(KEY_PREFIX)) return null;
  const [stored] = await createDatabase(env)
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.keyHash, await hashSecret(secret)), isNull(apiKey.revokedAt)))
    .limit(1);
  if (!stored || (stored.expiresAt && stored.expiresAt <= new Date())) return null;
  await createDatabase(env)
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, stored.id));
  return {
    id: stored.id,
    organizationId: stored.organizationId,
    userId: stored.createdBy,
    scopes: JSON.parse(stored.scopes) as string[],
  };
}
