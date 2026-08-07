import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("createdAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date())
    .notNull(),
};

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  ...timestamps,
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    ...timestamps,
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("activeOrganizationId"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    uniqueIndex("account_provider_account_uidx").on(table.providerId, table.accountId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
  metadata: text("metadata"),
});

export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    uniqueIndex("member_org_user_uidx").on(table.organizationId, table.userId),
  ],
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    inviterId: text("inviterId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const agent = sqliteTable(
  "agent",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    systemPrompt: text("system_prompt").notNull(),
    model: text("model").notNull(),
    creditCost: integer("credit_cost").notNull().default(1),
    status: text("status", { enum: ["draft", "live", "archived"] })
      .notNull()
      .default("draft"),
    visibility: text("visibility", { enum: ["private", "workspace", "public"] })
      .notNull()
      .default("workspace"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agent_org_slug_uidx").on(table.organizationId, table.slug),
    index("agent_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const chat = sqliteTable(
  "chat",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [
    index("chat_org_updated_idx").on(table.organizationId, table.updatedAt),
    index("chat_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export const creditAccount = sqliteTable("credit_account", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  lifetimeGranted: integer("lifetime_granted").notNull().default(0),
  lifetimeSpent: integer("lifetime_spent").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    type: text("type", {
      enum: ["grant", "spend", "refund", "adjustment", "expiration"],
    }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    description: text("description").notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("credit_ledger_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("credit_ledger_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export const subscription = sqliteTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    providerPriceId: text("provider_price_id"),
    planId: text("plan_id").notNull(),
    status: text("status").notNull(),
    currentPeriodStart: integer("current_period_start", { mode: "timestamp" }),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    canceledAt: integer("canceled_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("subscription_provider_id_uidx").on(table.provider, table.providerSubscriptionId),
    index("subscription_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const order = sqliteTable(
  "order",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSessionId: text("provider_session_id"),
    kind: text("kind", { enum: ["subscription", "credit_pack"] }).notNull(),
    planId: text("plan_id").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    credits: integer("credits").notNull().default(0),
    status: text("status", {
      enum: ["created", "processing", "paid", "failed", "refunded"],
    })
      .notNull()
      .default("created"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("order_provider_session_uidx").on(table.provider, table.providerSessionId),
    index("order_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export const paymentEvent = sqliteTable(
  "payment_event",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    status: text("status", { enum: ["processing", "completed", "failed"] })
      .notNull()
      .default("processing"),
    payloadHash: text("payload_hash").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("payment_event_provider_event_uidx").on(table.provider, table.providerEventId),
  ],
);

export const apiKey = sqliteTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("api_key_hash_uidx").on(table.keyHash),
    index("api_key_org_idx").on(table.organizationId),
  ],
);

export const fileAsset = sqliteTable(
  "file_asset",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    status: text("status", { enum: ["active", "deleted"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    index("file_asset_org_created_idx").on(table.organizationId, table.createdAt),
    index("file_asset_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const agentRun = sqliteTable(
  "agent_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id),
    chatId: text("chat_id").references(() => chat.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "canceled"],
    }).notNull(),
    credits: integer("credits").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    output: text("output"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("agent_run_org_idempotency_uidx").on(table.organizationId, table.idempotencyKey),
    index("agent_run_org_started_idx").on(table.organizationId, table.startedAt),
    index("agent_run_status_started_idx").on(table.status, table.startedAt),
  ],
);

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  agents: many(agent),
  chats: many(chat),
}));

export const agentRelations = relations(agent, ({ one, many }) => ({
  organization: one(organization, {
    fields: [agent.organizationId],
    references: [organization.id],
  }),
  chats: many(chat),
}));

export const chatRelations = relations(chat, ({ one }) => ({
  organization: one(organization, {
    fields: [chat.organizationId],
    references: [organization.id],
  }),
  agent: one(agent, { fields: [chat.agentId], references: [agent.id] }),
  user: one(user, { fields: [chat.userId], references: [user.id] }),
}));

export const schema = {
  account,
  agent,
  agentRun,
  apiKey,
  chat,
  creditAccount,
  creditLedger,
  fileAsset,
  invitation,
  member,
  organization,
  paymentEvent,
  order,
  session,
  subscription,
  user,
  verification,
  memberRelations,
  organizationRelations,
  agentRelations,
  chatRelations,
};

export type User = typeof user.$inferSelect;
export type Organization = typeof organization.$inferSelect;
export type Agent = typeof agent.$inferSelect;
export type Chat = typeof chat.$inferSelect;
export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type FileAsset = typeof fileAsset.$inferSelect;
export type Subscription = typeof subscription.$inferSelect;
