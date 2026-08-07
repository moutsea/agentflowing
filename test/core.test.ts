import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { MessageType } from "@cloudflare/ai-chat/types";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, getAuthCapabilities } from "../src/server/auth";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,
} from "../src/server/modules/api-keys/service";
import { createAgentSchema, updateAgentSchema } from "../src/server/modules/agents/routes";
import {
  AgentConfigurationError,
  AgentPermissionError,
  createAgent,
  getAccessibleAgent,
  getManagedAgent,
  listAgents,
  updateAgent,
} from "../src/server/modules/agents/service";
import {
  BillableAgentUnavailableError,
  billableAgentErrorResponse,
  loadBillableChat,
} from "../src/server/agents/monetized-agent";
import {
  cancelAndRefundAgentRun,
  completeAgentRun,
  DuplicateAgentRunError,
  failAndRefundAgentRun,
  reapStaleAgentRuns,
  startAgentRun,
} from "../src/server/modules/billing/service";
import {
  processStripeEvent,
  STRIPE_WEBHOOK_LEASE_SECONDS,
  StripeWebhookInProgressError,
} from "../src/server/modules/billing/stripe";
import { createChat, getChat, listChats } from "../src/server/modules/chats/service";
import {
  AttachmentValidationError,
  deleteAsset,
  getAsset,
  loadAttachmentContext,
  listAssets,
  uploadAsset,
} from "../src/server/modules/files/service";
import {
  ExternalAgentNotFoundError,
  listExternalAgents,
  runExternalAgent,
} from "../src/server/modules/external-api/service";
import { enforceRateLimit, RateLimitExceededError } from "../src/server/middleware/rate-limit";
import { listWorkspaces, resolveWorkspace } from "../src/server/modules/workspaces/service";

const migrationFiles = import.meta.glob("../migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const migrations = Object.entries(migrationFiles)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, sql]) => ({
    name: path.split("/").at(-1) ?? path,
    queries: sql
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter(Boolean),
  }));

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
});

async function seedWorkspace(credits = 0) {
  const suffix = crypto.randomUUID();
  const userId = `user_${suffix}`;
  const organizationId = `org_${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, 'Test Builder', ?, 1, unixepoch(), unixepoch())`,
    ).bind(userId, `builder-${suffix}@example.com`),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, 'Test Workspace', ?, unixepoch())`,
    ).bind(organizationId, `test-workspace-${suffix}`),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'owner', unixepoch())`,
    ).bind(`member_${suffix}`, organizationId, userId),
  ]);
  if (credits > 0) {
    await env.DB.prepare(
      `INSERT INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description, created_at)
       VALUES (?, ?, ?, 'grant', 'seed-grant', 'Seed credits', unixepoch())`,
    )
      .bind(`grant_${suffix}`, organizationId, credits)
      .run();
  }
  return { suffix, userId, organizationId };
}

async function seedRunnableAgent(
  workspace: Awaited<ReturnType<typeof seedWorkspace>>,
  creditCost = 1,
) {
  const agentId = `agent_${workspace.suffix}`;
  const chatId = `chat_${workspace.suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent
       (id, organization_id, slug, name, description, system_prompt, model,
        credit_cost, status, visibility, created_by, createdAt, updatedAt)
       VALUES (?, ?, 'tester', 'Tester', '', 'Be useful', 'test-model',
               ?, 'live', 'workspace', ?, unixepoch(), unixepoch())`,
    ).bind(agentId, workspace.organizationId, creditCost, workspace.userId),
    env.DB.prepare(
      `INSERT INTO chat
       (id, organization_id, agent_id, user_id, title, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'Test', 'active', unixepoch(), unixepoch())`,
    ).bind(chatId, workspace.organizationId, agentId, workspace.userId),
  ]);
  return { agentId, chatId };
}

async function getAccount(organizationId: string) {
  return env.DB.prepare(
    `SELECT balance, lifetime_granted AS lifetimeGranted,
            lifetime_spent AS lifetimeSpent
     FROM credit_account WHERE organization_id = ?`,
  )
    .bind(organizationId)
    .first<{ balance: number; lifetimeGranted: number; lifetimeSpent: number }>();
}

async function waitForAgentSocketError(socket: WebSocket, requestId: string) {
  return new Promise<{ body: string; error: boolean; id: string; type: string }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for Agent error")),
        2_000,
      );
      const handleMessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const data: unknown = JSON.parse(event.data);
        if (
          typeof data !== "object" ||
          data === null ||
          !("type" in data) ||
          data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
          !("id" in data) ||
          data.id !== requestId ||
          !("error" in data) ||
          data.error !== true ||
          !("body" in data) ||
          typeof data.body !== "string"
        ) {
          return;
        }
        clearTimeout(timeout);
        socket.removeEventListener("message", handleMessage);
        resolve({ body: data.body, error: true, id: requestId, type: data.type });
      };
      socket.addEventListener("message", handleMessage);
    },
  );
}

describe("Worker API", () => {
  it("serves health from the configured Worker", async () => {
    const response = await SELF.fetch("https://example.com/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "AgentFlowing",
    });
  });

  it("rejects unsigned Stripe webhooks before reading event data", async () => {
    const response = await SELF.fetch("https://example.com/api/billing/webhooks/stripe", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_signature" });
  });

  it("requires authentication for every Durable Agent instance", async () => {
    const response = await SELF.fetch("https://example.com/agents/monetized-agent/demo");
    expect(response.status).toBe(401);
  });

  it("reuses the Better Auth instance for one Worker environment", () => {
    expect(createAuth(env)).toBe(createAuth(env));
  });

  it("publishes authentication capabilities without exposing provider secrets", async () => {
    const response = await SELF.fetch("https://example.com/api/auth/capabilities");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    await expect(response.json()).resolves.toEqual({
      emailDelivery: false,
      emailPassword: true,
      github: false,
      google: false,
      magicLink: false,
      passwordReset: false,
    });

    const configuredEnv = new Proxy(env, {
      get(target, property) {
        if (property === "EMAIL_FROM") return "login@example.com";
        if (property === "GITHUB_CLIENT_ID") return "github-client";
        if (property === "GITHUB_CLIENT_SECRET") return "github-secret";
        if (property === "GOOGLE_CLIENT_ID") return "google-client";
        if (property === "GOOGLE_CLIENT_SECRET") return "google-secret";
        return Reflect.get(target, property);
      },
    });
    expect(getAuthCapabilities(configuredEnv)).toEqual({
      emailDelivery: true,
      emailPassword: true,
      github: true,
      google: true,
      magicLink: true,
      passwordReset: true,
    });
  });

  it("sends localized HTML and text authentication emails", async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: "test-message" }));
    const emailEnv = new Proxy(env, {
      get(target, property) {
        if (property === "EMAIL") return { send };
        if (property === "EMAIL_FROM") return "login@example.com";
        if (property === "EMAIL_FROM_NAME") return "AgentFlowing Test";
        return Reflect.get(target, property);
      },
    });
    const auth = createAuth(emailEnv);
    const magicLinkResponse = await auth.handler(
      new Request(`${emailEnv.APP_URL}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: emailEnv.APP_URL },
        body: JSON.stringify({
          callbackURL: "/app",
          email: "magic@example.com",
          metadata: { locale: "zh-CN" },
        }),
      }),
    );
    expect(magicLinkResponse.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      from: { email: "login@example.com", name: "AgentFlowing Test" },
      subject: "登录 AgentFlowing",
      to: "magic@example.com",
    });
    expect(send.mock.calls[0]?.[0].html).toContain("登录");
    expect(send.mock.calls[0]?.[0].text).toContain(
      "http://localhost:5173/api/auth/magic-link/verify",
    );

    const suffix = crypto.randomUUID();
    const signUpResponse = await auth.handler(
      new Request(`${emailEnv.APP_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: emailEnv.APP_URL },
        body: JSON.stringify({
          email: `reset-${suffix}@example.com`,
          name: "Reset Tester",
          password: "correct-horse-battery-staple",
        }),
      }),
    );
    expect(signUpResponse.status).toBe(200);
    const resetResponse = await auth.handler(
      new Request(`${emailEnv.APP_URL}/api/auth/request-password-reset`, {
        method: "POST",
        headers: {
          "accept-language": "en-US",
          "content-type": "application/json",
          origin: emailEnv.APP_URL,
        },
        body: JSON.stringify({
          email: `reset-${suffix}@example.com`,
          redirectTo: "/reset-password",
        }),
      }),
    );
    expect(resetResponse.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      subject: "Reset your AgentFlowing password",
      to: `reset-${suffix}@example.com`,
    });
    expect(send.mock.calls[1]?.[0].html).toContain("Reset password");
    expect(send.mock.calls[1]?.[0].text).toContain("/api/auth/reset-password/");
  });

  it("delivers billable Agent failures as WebSocket stream errors", async () => {
    const workspace = await seedWorkspace();
    const { agentId, chatId } = await seedRunnableAgent(workspace);
    await env.DB.prepare("UPDATE agent SET model = '@cf/zai-org/glm-4.7-flash' WHERE id = ?")
      .bind(agentId)
      .run();
    const response = await env.MonetizedAgent.getByName(chatId).fetch(
      new Request(`https://example.com/agents/monetized-agent/${chatId}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Agent WebSocket was not created");
    socket.accept();

    const requestId = `ws-error-${workspace.suffix}`;
    const errorMessage = waitForAgentSocketError(socket, requestId);
    socket.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            trigger: "submit-message",
            messages: [
              {
                id: `message-${workspace.suffix}`,
                role: "user",
                parts: [{ type: "text", text: "Run without credits" }],
              },
            ],
          }),
        },
      }),
    );
    await expect(errorMessage).resolves.toMatchObject({
      body: "Insufficient credits",
      error: true,
      id: requestId,
    });
    socket.close(1000, "test complete");
  });
});

describe("rate limiting", () => {
  it("throws a stable error when Cloudflare rejects a key", async () => {
    const limiter = {
      limit: async () => ({ success: false }),
    } as unknown as RateLimit;

    await expect(
      enforceRateLimit({
        limiter,
        key: "org:user",
        scope: "agent_run",
        requestId: "request-12345678",
      }),
    ).rejects.toMatchObject({
      name: "RateLimitExceededError",
      scope: "agent_run",
      retryAfterSeconds: 60,
    } satisfies Partial<RateLimitExceededError>);
  });

  it("preserves a 429 response inside a Durable Agent", async () => {
    const response = billableAgentErrorResponse(new RateLimitExceededError("chat_agent_run"));
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    expect(response?.headers.get("x-agent-error-code")).toBe("rate_limited");
    await expect(response?.text()).resolves.toContain(
      '"type":"error","errorText":"Too many requests. Try again shortly."',
    );
  });
});

describe("credit ledger invariants", () => {
  it("applies grants and spends to the materialized account", async () => {
    const workspace = await seedWorkspace(10);
    await env.DB.prepare(
      `INSERT INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description, created_at)
       VALUES (?, ?, -3, 'spend', 'message-1', 'Agent message', unixepoch())`,
    )
      .bind(`spend_${workspace.suffix}`, workspace.organizationId)
      .run();

    await expect(getAccount(workspace.organizationId)).resolves.toEqual({
      balance: 7,
      lifetimeGranted: 10,
      lifetimeSpent: 3,
    });
  });

  it("rejects overdrafts without changing the balance", async () => {
    const workspace = await seedWorkspace(5);
    await expect(
      env.DB.prepare(
        `INSERT INTO credit_ledger
         (id, organization_id, delta, type, idempotency_key, description, created_at)
         VALUES (?, ?, -6, 'spend', 'message-overdraft',
                 'Agent message', unixepoch())`,
      )
        .bind(`overdraft_${workspace.suffix}`, workspace.organizationId)
        .run(),
    ).rejects.toThrow("INSUFFICIENT_CREDITS");
    expect((await getAccount(workspace.organizationId))?.balance).toBe(5);
  });

  it("enforces one ledger entry per idempotency key", async () => {
    const workspace = await seedWorkspace(5);
    const statement = (id: string) =>
      env.DB.prepare(
        `INSERT INTO credit_ledger
         (id, organization_id, delta, type, idempotency_key, description, created_at)
         VALUES (?, ?, -1, 'spend', 'same-message', 'Agent message', unixepoch())`,
      ).bind(id, workspace.organizationId);

    await statement("spend_first").run();
    await expect(statement("spend_duplicate").run()).rejects.toThrow("UNIQUE constraint failed");
    expect((await getAccount(workspace.organizationId))?.balance).toBe(4);
  });

  it("blocks updates and deletes from the ledger", async () => {
    const workspace = await seedWorkspace(5);
    await expect(
      env.DB.prepare("UPDATE credit_ledger SET description = 'changed' WHERE organization_id = ?")
        .bind(workspace.organizationId)
        .run(),
    ).rejects.toThrow("CREDIT_LEDGER_IS_IMMUTABLE");
    await expect(
      env.DB.prepare("DELETE FROM credit_ledger WHERE organization_id = ?")
        .bind(workspace.organizationId)
        .run(),
    ).rejects.toThrow("CREDIT_LEDGER_IS_IMMUTABLE");
    expect((await getAccount(workspace.organizationId))?.balance).toBe(5);
  });

  it("counts positive manual adjustments as lifetime grants", async () => {
    const workspace = await seedWorkspace(5);
    await env.DB.prepare(
      `INSERT INTO credit_ledger
       (id, organization_id, delta, type, idempotency_key, description, created_at)
       VALUES (?, ?, 4, 'adjustment', 'manual-credit', 'Support adjustment', unixepoch())`,
    )
      .bind(`adjustment_${workspace.suffix}`, workspace.organizationId)
      .run();
    await expect(getAccount(workspace.organizationId)).resolves.toEqual({
      balance: 9,
      lifetimeGranted: 9,
      lifetimeSpent: 0,
    });
  });
});

describe("workspace bootstrap", () => {
  it("creates a personal workspace and starter grant exactly once", async () => {
    await env.DB.prepare(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('bootstrap_user', 'Ada', 'ada@example.com', 1, unixepoch(), unixepoch())`,
    ).run();

    const first = await resolveWorkspace({
      env,
      userId: "bootstrap_user",
      userName: "Ada",
    });
    const second = await resolveWorkspace({
      env,
      userId: "bootstrap_user",
      userName: "Ada",
    });
    expect(second.organization.id).toBe(first.organization.id);

    const account = await env.DB.prepare(
      "SELECT balance FROM credit_account WHERE organization_id = ?",
    )
      .bind(first.organization.id)
      .first<{ balance: number }>();
    const ledgerCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM credit_ledger WHERE organization_id = ?",
    )
      .bind(first.organization.id)
      .first<{ count: number }>();
    const agentCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM agent WHERE organization_id = ?",
    )
      .bind(first.organization.id)
      .first<{ count: number }>();

    expect(account?.balance).toBe(100);
    expect(ledgerCount?.count).toBe(1);
    expect(agentCount?.count).toBe(1);
  });

  it("provisions accounts for Better Auth organizations and prefers owned workspaces", async () => {
    const suffix = crypto.randomUUID();
    const userId = `multi_user_${suffix}`;
    const invitedOrganizationId = `invited_org_${suffix}`;
    const ownedOrganizationId = `owned_org_${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, 'Multi Org', ?, 1, unixepoch(), unixepoch())`,
      ).bind(userId, `multi-${suffix}@example.com`),
      env.DB.prepare(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, 'Invited Workspace', ?, unixepoch())`,
      ).bind(invitedOrganizationId, `invited-${suffix}`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'member', 1)`,
      ).bind(`invited_member_${suffix}`, invitedOrganizationId, userId),
      env.DB.prepare(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, 'Owned Workspace', ?, unixepoch())`,
      ).bind(ownedOrganizationId, `owned-${suffix}`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'owner', 2)`,
      ).bind(`owned_member_${suffix}`, ownedOrganizationId, userId),
    ]);

    const accounts = await env.DB.prepare(
      `SELECT organization_id AS organizationId FROM credit_account
       WHERE organization_id IN (?, ?) ORDER BY organization_id`,
    )
      .bind(invitedOrganizationId, ownedOrganizationId)
      .all<{ organizationId: string }>();
    expect(accounts.results).toHaveLength(2);
    await expect(resolveWorkspace({ env, userId, userName: "Multi Org" })).resolves.toMatchObject({
      organization: { id: ownedOrganizationId },
      role: "owner",
    });
    await expect(listWorkspaces(env, userId)).resolves.toHaveLength(2);
  });

  it("rejects switching to an organization the user has not joined", async () => {
    const suffix = crypto.randomUUID();
    const signUp = await SELF.fetch(`${env.APP_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.APP_URL },
      body: JSON.stringify({
        name: "Workspace Switcher",
        email: `switcher-${suffix}@example.com`,
        password: "correct-horse-battery-staple",
      }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).not.toBe("");

    const response = await SELF.fetch(`${env.APP_URL}/api/organizations/active`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: env.APP_URL },
      body: JSON.stringify({ organizationId: `org_not_joined_${suffix}` }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
  });
});

describe("workspace agents", () => {
  const input = {
    slug: "launch-analyst",
    name: "Launch Analyst",
    description: "Reviews launch plans.",
    systemPrompt: "Review the launch plan and return prioritized actions.",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    creditCost: 2,
    status: "draft" as const,
    visibility: "workspace" as const,
  };

  it("creates and updates agents inside one organization", async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const created = await createAgent({
      env,
      organizationId: first.organizationId,
      userId: first.userId,
      role: "owner",
      input,
    });

    await expect(getManagedAgent(env, first.organizationId, created.id)).resolves.toMatchObject({
      name: "Launch Analyst",
      status: "draft",
    });
    await expect(getManagedAgent(env, second.organizationId, created.id)).resolves.toBeNull();
    await expect(
      updateAgent({
        env,
        organizationId: second.organizationId,
        agentId: created.id,
        role: "owner",
        input: { name: "Stolen Agent" },
      }),
    ).resolves.toBeNull();

    await expect(
      updateAgent({
        env,
        organizationId: first.organizationId,
        agentId: created.id,
        role: "admin",
        input: { status: "live", creditCost: 3 },
      }),
    ).resolves.toMatchObject({ status: "live", creditCost: 3 });
  });

  it("requires manager roles and validates public input", async () => {
    const workspace = await seedWorkspace();
    await expect(
      createAgent({
        env,
        organizationId: workspace.organizationId,
        userId: workspace.userId,
        role: "member",
        input,
      }),
    ).rejects.toBeInstanceOf(AgentPermissionError);

    expect(createAgentSchema.safeParse({ ...input, slug: "Not Valid" }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...input, creditCost: 0 }).success).toBe(false);
    expect(
      createAgentSchema.safeParse({ ...input, model: "@cf/customer/expensive-model" }).success,
    ).toBe(false);
    expect(createAgentSchema.safeParse({ ...input, creditCost: 1 }).success).toBe(false);
    expect(updateAgentSchema.safeParse({}).success).toBe(false);
    expect(updateAgentSchema.safeParse({ status: "live" }).success).toBe(true);

    await expect(
      createAgent({
        env,
        organizationId: workspace.organizationId,
        userId: workspace.userId,
        role: "owner",
        input: { ...input, model: "@cf/customer/expensive-model" },
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    const created = await createAgent({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      role: "owner",
      input,
    });
    await expect(
      updateAgent({
        env,
        organizationId: workspace.organizationId,
        agentId: created.id,
        role: "owner",
        input: { creditCost: 1 },
      }),
    ).rejects.toMatchObject({ code: "credit_cost_too_low" });
  });

  it("stops existing chats when their Agent is no longer live", async () => {
    const workspace = await seedWorkspace();
    const created = await createAgent({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      role: "owner",
      input: { ...input, status: "live" },
    });
    const chatId = `chat_${workspace.suffix}`;
    await env.DB.prepare(
      `INSERT INTO chat
       (id, organization_id, agent_id, user_id, title, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'Policy test', 'active', unixepoch(), unixepoch())`,
    )
      .bind(chatId, workspace.organizationId, created.id, workspace.userId)
      .run();

    await expect(loadBillableChat(env, chatId)).resolves.toMatchObject({
      agentId: created.id,
      agentStatus: "live",
    });
    await updateAgent({
      env,
      organizationId: workspace.organizationId,
      agentId: created.id,
      role: "owner",
      input: { status: "archived" },
    });
    await expect(loadBillableChat(env, chatId)).rejects.toBeInstanceOf(
      BillableAgentUnavailableError,
    );
  });

  it("rejects unsupported legacy models when a stored chat runs", async () => {
    const workspace = await seedWorkspace();
    const agentId = `agent_${workspace.suffix}`;
    const chatId = `chat_${workspace.suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent
         (id, organization_id, slug, name, description, system_prompt, model,
          credit_cost, status, visibility, created_by, createdAt, updatedAt)
         VALUES (?, ?, 'legacy-agent', 'Legacy Agent', '', 'Return a concise answer.',
                 '@cf/moonshotai/kimi-k2.5', 8, 'live', 'workspace', ?, unixepoch(), unixepoch())`,
      ).bind(agentId, workspace.organizationId, workspace.userId),
      env.DB.prepare(
        `INSERT INTO chat
         (id, organization_id, agent_id, user_id, title, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'Legacy model', 'active', unixepoch(), unixepoch())`,
      ).bind(chatId, workspace.organizationId, agentId, workspace.userId),
    ]);

    await expect(loadBillableChat(env, chatId)).rejects.toMatchObject({
      code: "unsupported_model",
    });
  });

  it("enforces private visibility for lists, chats, and existing runs", async () => {
    const workspace = await seedWorkspace();
    const secondUserId = `private_viewer_${workspace.suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, 'Private Viewer', ?, 1, unixepoch(), unixepoch())`,
      ).bind(secondUserId, `private-viewer-${workspace.suffix}@example.com`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'member', unixepoch())`,
      ).bind(`private_member_${workspace.suffix}`, workspace.organizationId, secondUserId),
    ]);
    const privateAgent = await createAgent({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      role: "owner",
      input: { ...input, slug: "owner-private", visibility: "private", status: "live" },
    });

    await expect(listAgents(env, workspace.organizationId, workspace.userId)).resolves.toEqual([
      expect.objectContaining({ id: privateAgent.id }),
    ]);
    await expect(listAgents(env, workspace.organizationId, secondUserId)).resolves.toEqual([]);
    await expect(
      listExternalAgents(env, workspace.organizationId, workspace.userId),
    ).resolves.toEqual([]);
    await expect(
      getAccessibleAgent(env, workspace.organizationId, privateAgent.id, secondUserId),
    ).resolves.toBeNull();
    await expect(
      createChat({
        env,
        organizationId: workspace.organizationId,
        userId: secondUserId,
        agentId: privateAgent.id,
      }),
    ).rejects.toMatchObject({ name: "ChatAgentNotFoundError" });
    await expect(
      runExternalAgent({
        env,
        organizationId: workspace.organizationId,
        userId: workspace.userId,
        agentId: privateAgent.id,
        message: "Do not run",
        idempotencyKey: `private-${workspace.suffix}`,
      }),
    ).rejects.toBeInstanceOf(ExternalAgentNotFoundError);

    const leakedChatId = `private_chat_${workspace.suffix}`;
    await env.DB.prepare(
      `INSERT INTO chat
       (id, organization_id, agent_id, user_id, title, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'Private leak', 'active', unixepoch(), unixepoch())`,
    )
      .bind(leakedChatId, workspace.organizationId, privateAgent.id, secondUserId)
      .run();
    await expect(loadBillableChat(env, leakedChatId)).rejects.toMatchObject({
      message: "Agent is private",
    });
  });
});

describe("private workspace chats", () => {
  it("isolates chat lists and reads between users in one organization", async () => {
    const workspace = await seedWorkspace();
    const secondUserId = `user_second_${workspace.suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, 'Second Builder', ?, 1, unixepoch(), unixepoch())`,
      ).bind(secondUserId, `second-${workspace.suffix}@example.com`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'member', unixepoch())`,
      ).bind(`member_second_${workspace.suffix}`, workspace.organizationId, secondUserId),
    ]);
    const createdAgent = await createAgent({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      role: "owner",
      input: {
        slug: "private-chat-agent",
        name: "Private Chat Agent",
        description: "Tests private conversations.",
        systemPrompt: "Return a concise answer for every request.",
        model: "@cf/zai-org/glm-4.7-flash",
        creditCost: 1,
        status: "live",
        visibility: "workspace",
      },
    });
    const ownerChat = await createChat({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      agentId: createdAgent.id,
    });
    const memberChat = await createChat({
      env,
      organizationId: workspace.organizationId,
      userId: secondUserId,
      agentId: createdAgent.id,
    });

    await expect(listChats(env, workspace.organizationId, workspace.userId)).resolves.toEqual([
      expect.objectContaining({ id: ownerChat.id }),
    ]);
    await expect(listChats(env, workspace.organizationId, secondUserId)).resolves.toEqual([
      expect.objectContaining({ id: memberChat.id }),
    ]);
    await expect(
      getChat(env, workspace.organizationId, secondUserId, ownerChat.id),
    ).resolves.toBeNull();
    await expect(
      getChat(env, workspace.organizationId, workspace.userId, memberChat.id),
    ).resolves.toBeNull();
  });
});

describe("agent run billing", () => {
  it("spends and refunds idempotently", async () => {
    const workspace = await seedWorkspace(2);
    const agentId = `agent_${workspace.suffix}`;
    const chatId = `chat_${workspace.suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent
         (id, organization_id, slug, name, description, system_prompt, model,
          credit_cost, status, visibility, created_by, createdAt, updatedAt)
         VALUES (?, ?, 'tester', 'Tester', '', 'Be useful', 'test-model',
                 1, 'live', 'workspace', ?, unixepoch(), unixepoch())`,
      ).bind(agentId, workspace.organizationId, workspace.userId),
      env.DB.prepare(
        `INSERT INTO chat
         (id, organization_id, agent_id, user_id, title, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'Test', 'active', unixepoch(), unixepoch())`,
      ).bind(chatId, workspace.organizationId, agentId, workspace.userId),
    ]);

    const params = {
      env,
      organizationId: workspace.organizationId,
      agentId,
      chatId,
      userId: workspace.userId,
      idempotencyKey: `chat:${chatId}:message:message-1`,
      credits: 1,
    };
    const first = await startAgentRun(params);
    const duplicate = await startAgentRun(params);
    expect(duplicate.id).toBe(first.id);
    await expect(startAgentRun({ ...params, duplicateBehavior: "reject" })).rejects.toBeInstanceOf(
      DuplicateAgentRunError,
    );
    expect((await getAccount(workspace.organizationId))?.balance).toBe(1);

    await failAndRefundAgentRun({
      env,
      runId: first.id,
      error: "Model unavailable",
    });
    await failAndRefundAgentRun({
      env,
      runId: first.id,
      error: "Repeated callback",
    });
    expect(await getAccount(workspace.organizationId)).toEqual({
      balance: 2,
      lifetimeGranted: 2,
      lifetimeSpent: 0,
    });

    const spendCount = await env.DB.prepare(
      `SELECT count(*) AS count FROM credit_ledger
       WHERE organization_id = ? AND type = 'spend'`,
    )
      .bind(workspace.organizationId)
      .first<{ count: number }>();
    const refundCount = await env.DB.prepare(
      `SELECT count(*) AS count FROM credit_ledger
       WHERE organization_id = ? AND type = 'refund'`,
    )
      .bind(workspace.organizationId)
      .first<{ count: number }>();
    expect(spendCount?.count).toBe(1);
    expect(refundCount?.count).toBe(1);
  });

  it("never refunds a completed run after a late error", async () => {
    const workspace = await seedWorkspace(2);
    const { agentId, chatId } = await seedRunnableAgent(workspace);
    const run = await startAgentRun({
      env,
      organizationId: workspace.organizationId,
      agentId,
      chatId,
      userId: workspace.userId,
      idempotencyKey: `chat:${chatId}:request:completed`,
      credits: 1,
    });
    await completeAgentRun({ env, runId: run.id, output: "done" });
    await failAndRefundAgentRun({ env, runId: run.id, error: "Late stream error" });

    expect((await getAccount(workspace.organizationId))?.balance).toBe(1);
    const stored = await env.DB.prepare("SELECT status FROM agent_run WHERE id = ?")
      .bind(run.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe("completed");
  });

  it("refunds the captured run price after Agent pricing changes", async () => {
    const workspace = await seedWorkspace(2);
    const { agentId, chatId } = await seedRunnableAgent(workspace);
    const run = await startAgentRun({
      env,
      organizationId: workspace.organizationId,
      agentId,
      chatId,
      userId: workspace.userId,
      idempotencyKey: `chat:${chatId}:request:repriced`,
      credits: 1,
    });
    await env.DB.prepare("UPDATE agent SET credit_cost = 500 WHERE id = ?").bind(agentId).run();
    await failAndRefundAgentRun({ env, runId: run.id, error: "Model unavailable" });
    expect((await getAccount(workspace.organizationId))?.balance).toBe(2);
  });

  it("marks aborted runs canceled and refunds once", async () => {
    const workspace = await seedWorkspace(2);
    const { agentId, chatId } = await seedRunnableAgent(workspace);
    const run = await startAgentRun({
      env,
      organizationId: workspace.organizationId,
      agentId,
      chatId,
      userId: workspace.userId,
      idempotencyKey: `chat:${chatId}:request:canceled`,
      credits: 1,
    });
    await cancelAndRefundAgentRun({ env, runId: run.id });
    await cancelAndRefundAgentRun({ env, runId: run.id });
    expect(await getAccount(workspace.organizationId)).toEqual({
      balance: 2,
      lifetimeGranted: 2,
      lifetimeSpent: 0,
    });
    const stored = await env.DB.prepare("SELECT status FROM agent_run WHERE id = ?")
      .bind(run.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe("canceled");
  });

  it("reaps stale running attempts and refunds them once", async () => {
    const workspace = await seedWorkspace(2);
    const { agentId, chatId } = await seedRunnableAgent(workspace);
    const run = await startAgentRun({
      env,
      organizationId: workspace.organizationId,
      agentId,
      chatId,
      userId: workspace.userId,
      idempotencyKey: `chat:${chatId}:request:stale`,
      credits: 1,
    });
    await env.DB.prepare("UPDATE agent_run SET started_at = unixepoch() - 301 WHERE id = ?")
      .bind(run.id)
      .run();

    await expect(reapStaleAgentRuns({ env, staleAfterSeconds: 300 })).resolves.toMatchObject({
      scanned: 1,
      reaped: 1,
      staleAfterSeconds: 300,
    });
    await expect(reapStaleAgentRuns({ env, staleAfterSeconds: 300 })).resolves.toMatchObject({
      scanned: 0,
      reaped: 0,
    });
    expect(await getAccount(workspace.organizationId)).toEqual({
      balance: 2,
      lifetimeGranted: 2,
      lifetimeSpent: 0,
    });
    const stored = await env.DB.prepare("SELECT status, error FROM agent_run WHERE id = ?")
      .bind(run.id)
      .first<{ status: string; error: string }>();
    expect(stored).toEqual({
      status: "canceled",
      error: "Canceled after the Agent run recovery timeout",
    });
  });
});

describe("Stripe fulfillment", () => {
  it("grants checkout and renewal credits exactly once", async () => {
    const workspace = await seedWorkspace();
    const orderId = `order_${workspace.suffix}`;
    const checkoutId = `cs_${workspace.suffix}`;
    const subscriptionId = `sub_${workspace.suffix}`;
    await env.DB.prepare(
      `INSERT INTO "order"
       (id, organization_id, provider, provider_session_id, kind, plan_id, amount,
        currency, credits, status, createdAt, updatedAt)
       VALUES (?, ?, 'stripe', ?, 'subscription', 'pro', 2900, 'usd', 5000,
               'created', unixepoch(), unixepoch())`,
    )
      .bind(orderId, workspace.organizationId, checkoutId)
      .run();

    const checkoutEvent = {
      id: `evt_checkout_${workspace.suffix}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: checkoutId,
          object: "checkout.session",
          payment_status: "paid",
          amount_total: 2900,
          customer: `cus_${workspace.suffix}`,
          subscription: subscriptionId,
          metadata: {
            orderId,
            organizationId: workspace.organizationId,
            userId: workspace.userId,
            planId: "pro",
          },
        },
      },
    } as unknown as Stripe.Event;

    const first = await processStripeEvent(env, checkoutEvent, "checkout-payload-hash");
    const duplicate = await processStripeEvent(env, checkoutEvent, "checkout-payload-hash");
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect((await getAccount(workspace.organizationId))?.balance).toBe(5_000);

    const renewalEvent = {
      id: `evt_renewal_${workspace.suffix}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${workspace.suffix}`,
          object: "invoice",
          billing_reason: "subscription_cycle",
          period_start: 1_787_000_000,
          period_end: 1_789_592_000,
          parent: {
            type: "subscription_details",
            quote_details: null,
            subscription_details: {
              subscription: subscriptionId,
              metadata: {
                organizationId: workspace.organizationId,
                planId: "pro",
              },
            },
          },
        },
      },
    } as unknown as Stripe.Event;

    await processStripeEvent(env, renewalEvent, "renewal-payload-hash");
    await processStripeEvent(env, renewalEvent, "renewal-payload-hash");
    const account = await getAccount(workspace.organizationId);
    expect(account).toEqual({ balance: 10_000, lifetimeGranted: 10_000, lifetimeSpent: 0 });

    const storedSubscription = await env.DB.prepare(
      `SELECT status, current_period_start AS periodStart, current_period_end AS periodEnd
       FROM subscription WHERE provider = 'stripe' AND provider_subscription_id = ?`,
    )
      .bind(subscriptionId)
      .first<{ status: string; periodStart: number; periodEnd: number }>();
    expect(storedSubscription).toEqual({
      status: "active",
      periodStart: 1_787_000_000,
      periodEnd: 1_789_592_000,
    });

    const paidOrder = await env.DB.prepare(`SELECT status FROM "order" WHERE id = ?`)
      .bind(orderId)
      .first<{ status: string }>();
    expect(paidOrder?.status).toBe("paid");
  });

  it("reclaims stale processing events but rejects an active lease", async () => {
    const suffix = crypto.randomUUID();
    const staleEvent = {
      id: `evt_stale_${suffix}`,
      type: "unhandled.event",
      data: { object: {} },
    } as unknown as Stripe.Event;
    await env.DB.prepare(
      `INSERT INTO payment_event
       (id, provider, provider_event_id, type, status, payload_hash, createdAt, updatedAt)
       VALUES (?, 'stripe', ?, ?, 'processing', 'stale-hash', unixepoch(),
               unixepoch() - ? - 1)`,
    )
      .bind(crypto.randomUUID(), staleEvent.id, staleEvent.type, STRIPE_WEBHOOK_LEASE_SECONDS)
      .run();
    await expect(processStripeEvent(env, staleEvent, "stale-hash")).resolves.toEqual({
      duplicate: false,
    });

    const activeEvent = {
      id: `evt_active_${suffix}`,
      type: "unhandled.event",
      data: { object: {} },
    } as unknown as Stripe.Event;
    await env.DB.prepare(
      `INSERT INTO payment_event
       (id, provider, provider_event_id, type, status, payload_hash, createdAt, updatedAt)
       VALUES (?, 'stripe', ?, ?, 'processing', 'active-hash', unixepoch(), unixepoch())`,
    )
      .bind(crypto.randomUUID(), activeEvent.id, activeEvent.type)
      .run();
    await expect(processStripeEvent(env, activeEvent, "active-hash")).rejects.toBeInstanceOf(
      StripeWebhookInProgressError,
    );
  });
});

describe("workspace file assets", () => {
  it("uploads an allowed file with tenant metadata", async () => {
    const workspace = await seedWorkspace();
    const file = new File(["# Agent knowledge"], "Knowledge Base.md", {
      type: "text/markdown",
    });

    const asset = await uploadAsset({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      file,
    });

    expect(asset).toMatchObject({
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      name: "Knowledge-Base.md",
      contentType: "text/markdown",
      size: file.size,
      status: "active",
    });
    const stored = await env.FILES.get(asset.key);
    expect(await stored?.text()).toBe("# Agent knowledge");
    expect(stored?.httpMetadata?.contentType).toBe("text/markdown");
    expect(stored?.customMetadata).toMatchObject({
      assetId: asset.id,
      organizationId: workspace.organizationId,
      uploadedBy: workspace.userId,
      originalName: "Knowledge Base.md",
    });
    await expect(listAssets(env, workspace.organizationId)).resolves.toHaveLength(1);
  });

  it("rejects unsupported MIME types", async () => {
    const workspace = await seedWorkspace();
    const file = new File(["binary"], "payload.exe", {
      type: "application/x-msdownload",
    });

    await expect(
      uploadAsset({
        env,
        organizationId: workspace.organizationId,
        userId: workspace.userId,
        file,
      }),
    ).rejects.toMatchObject({ code: "unsupported_file_type" });
  });

  it("isolates reads and deletes by organization", async () => {
    const owner = await seedWorkspace();
    const outsider = await seedWorkspace();
    const asset = await uploadAsset({
      env,
      organizationId: owner.organizationId,
      userId: owner.userId,
      file: new File(["private"], "private.txt", { type: "text/plain" }),
    });

    await expect(getAsset(env, outsider.organizationId, asset.id)).resolves.toBeNull();
    await expect(deleteAsset(env, outsider.organizationId, asset.id)).resolves.toBe(false);
    expect(await env.FILES.head(asset.key)).not.toBeNull();

    await expect(deleteAsset(env, owner.organizationId, asset.id)).resolves.toBe(true);
    await expect(getAsset(env, owner.organizationId, asset.id)).resolves.toBeNull();
    expect(await env.FILES.head(asset.key)).toBeNull();
  });

  it("loads only text context from the owning workspace", async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const asset = await uploadAsset({
      env,
      organizationId: first.organizationId,
      userId: first.userId,
      file: new File(["ARR is MRR multiplied by twelve."], "metrics.md", {
        type: "text/markdown",
      }),
    });

    await expect(
      loadAttachmentContext({
        env,
        organizationId: first.organizationId,
        assetIds: [asset.id],
      }),
    ).resolves.toContain("ARR is MRR multiplied by twelve.");
    await expect(
      loadAttachmentContext({
        env,
        organizationId: second.organizationId,
        assetIds: [asset.id],
      }),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  it("counts unique attachment IDs before enforcing the limit", async () => {
    const workspace = await seedWorkspace();
    await expect(
      loadAttachmentContext({
        env,
        organizationId: workspace.organizationId,
        assetIds: ["a", "a", "b", "c", "d", "e", "f"],
      }),
    ).rejects.toMatchObject({ code: "attachment_not_found" });
    await expect(
      loadAttachmentContext({
        env,
        organizationId: workspace.organizationId,
        assetIds: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ).rejects.toMatchObject({ code: "invalid_attachments" });
  });
});

describe("workspace API keys", () => {
  it("returns the secret once and stores only its hash and prefix", async () => {
    const workspace = await seedWorkspace();
    const created = await createApiKey({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      name: "Production integration",
      scopes: ["agents:read", "agents:run"],
    });

    expect(created.secret).toMatch(/^af_live_[A-Za-z0-9_-]{43}$/);
    const stored = await env.DB.prepare(
      "SELECT key_hash AS keyHash, key_prefix AS keyPrefix FROM api_key WHERE id = ?",
    )
      .bind(created.id)
      .first<{ keyHash: string; keyPrefix: string }>();
    expect(stored?.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.keyHash).not.toContain(created.secret);
    expect(stored?.keyPrefix).toBe(created.keyPrefix);

    const columns = await env.DB.prepare("PRAGMA table_info(api_key)").all();
    const columnNames = (columns.results as Array<{ name: string }>).map((column) => column.name);
    expect(columnNames).not.toContain("secret");
    const listed = await listApiKeys(env, workspace.organizationId);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it("validates a key until it is revoked", async () => {
    const workspace = await seedWorkspace();
    const created = await createApiKey({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      name: "CLI",
      scopes: ["agents:run"],
    });

    await expect(validateApiKey(env, created.secret)).resolves.toMatchObject({
      id: created.id,
      organizationId: workspace.organizationId,
      scopes: ["agents:run"],
    });
    await expect(revokeApiKey(env, workspace.organizationId, created.id)).resolves.toBe(true);
    await expect(validateApiKey(env, created.secret)).resolves.toBeNull();
  });

  it("authorizes the scoped external agent catalog", async () => {
    const workspace = await seedWorkspace();
    const createdAgent = await createAgent({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      role: "owner",
      input: {
        slug: "catalog-agent",
        name: "Catalog Agent",
        description: "Visible through the API.",
        systemPrompt: "Return a concise answer for every request.",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        creditCost: 2,
        status: "live",
        visibility: "workspace",
      },
    });
    const key = await createApiKey({
      env,
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      name: "Catalog reader",
      scopes: ["agents:read"],
    });

    const response = await SELF.fetch("https://example.com/api/v1/agents", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: Array<{ id: string; name: string; systemPrompt?: string }>;
    };
    expect(payload.data).toContainEqual(
      expect.objectContaining({ id: createdAgent.id, name: "Catalog Agent" }),
    );
    expect(payload.data[0]).not.toHaveProperty("systemPrompt");

    const forbidden = await SELF.fetch(`https://example.com/api/v1/agents/${createdAgent.id}/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Hello", idempotencyKey: "request-123" }),
    });
    expect(forbidden.status).toBe(403);
  });
});
