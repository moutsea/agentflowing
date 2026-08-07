# Architecture

AgentFlowing is a clean-room, MIT-licensed implementation inspired by the
separation of concerns found in mature SaaS products. No ShipAny source code or
frontend assets are included.

## Runtime boundaries

```text
React SPA
  -> Hono API on Cloudflare Workers
     -> Better Auth + organization workspaces
     -> D1 business database and immutable credit ledger
     -> Stripe checkout and verified webhooks
     -> R2 user files
     -> scoped external API keys
     -> Cloudflare Rate Limiting bindings
     -> structured logs, request IDs, and sampled traces
  -> Cloudflare Agents SDK
     -> one Durable Object per conversation
     -> persisted messages, streaming, tools, schedules
     -> optional Workflows adapter for long-running jobs (not included)
```

## Design rules

1. D1 owns globally queryable SaaS data: users, workspaces, subscriptions,
   chats, payments, and the credit ledger.
2. A Durable Object owns the strongly consistent state of one agent session.
3. Credit mutations are immutable ledger entries with database-enforced
   idempotency keys. Application-level preflight checks are never treated as
   concurrency control.
4. Payment webhooks are verified before parsing and stored by provider event ID
   before fulfillment.
5. API routes return real HTTP status codes and a stable JSON error shape.
6. The frontend talks only to public API contracts; it never imports server
   services or database code.
7. Domain modules contain business logic. Hono routes authenticate, validate,
   call one service, and serialize the result.
8. Model IDs and their minimum credit costs, output caps, and tool-step caps come
   from one shared server-authoritative catalog.
9. Rate limiting reduces abuse; database constraints, not the limiter, protect
   money and credits.

## Commercial request flow

```text
Browser chat or API key request
  -> resolve organization and Agent
  -> enforce the appropriate abuse limit
  -> validate model and execution policy
  -> reject replayed browser request IDs or replay stored external API results
  -> append idempotent credit spend
  -> create agent_run
  -> load organization-owned text attachments
  -> call Workers AI
  -> persist usage and API output
  -> atomically fail/cancel and refund the captured run price exactly once
  -> recovery hook refunds an interrupted attempt before a continuation starts
  -> Worker cron refunds stale attempts whose Durable Object never wakes again
```

The D1 ledger triggers update the materialized credit account in the same
transaction as each append. An application-side balance check is deliberately
not used as a concurrency guard.

Every organization row creates its `credit_account` through a D1 trigger. This
covers personal workspaces, Better Auth organization creation, and future
administrative imports without adding writes to authenticated GET requests.
Refund entries are derived from the immutable `agent_run.credits` value rather
than the Agent's current price and reduce net `lifetime_spent`. Positive grants
and administrative adjustments increase `lifetime_granted`; refunds do not.

Browser billing is per model run rather than per user message. A continuation
after a client-side tool result is another model call and is charged separately.
If Durable Object eviction interrupts a run, the recovery hook refunds that
attempt before the SDK starts its continuation. A global Worker cron scans D1
every five minutes and idempotently cancels/refunds older `running` rows as a
fallback for Durable Objects that never reactivate. `AGENT_RUN_STALE_SECONDS`
defaults to 30 minutes and should exceed the longest healthy product run.

Cloudflare Rate Limiting is intentionally not part of the accounting boundary.
It is permissive, scoped by Cloudflare location, and suitable for controlling
abuse rather than guaranteeing an exact global request count.

## Module boundary

`src/server/modules/*` follows the service-and-route split used by mature SaaS
codebases. Services own queries and domain invariants. Routes remain small and
own HTTP concerns such as authentication, Zod validation, status codes, and
error envelopes. The payment module is allowed to coordinate subscriptions and
credits because successful payment is the transaction boundary between them.

This template is Cloudflare-first rather than multi-database. It does not hide
D1 behavior behind compatibility proxies or pretend unsupported row locks and
interactive transactions exist. Portability is a future adapter concern;
correct credit and webhook semantics are the current boundary.

## Storage ownership

- D1 stores globally queryable identity, billing, Agent metadata, chats, and runs.
- A Durable Object stores the ordered message state for one conversation.
- R2 stores uploaded bytes; D1 stores tenant-scoped file metadata.
- Stripe remains the source of truth for payment collection while D1 stores the
  local subscription projection needed for product access.

Chat metadata is scoped by both `organizationId` and `userId`. Organization
members can share Agents, but they cannot list, fetch, or route requests to one
another's conversations.

Agent visibility is an authorization rule, not display metadata. Private Agents
are restricted to their creator and excluded from the external API; workspace
and public Agents remain available to members of their owning organization.
Management is a separate capability: workspace owners and admins may update or
archive every Agent, including private Agents they cannot invoke themselves.

## Model policy

`src/shared/ai-models.ts` is the only supported model catalog. Each entry binds
a Workers AI model ID to a minimum per-run credit charge, maximum output tokens,
and maximum tool steps. The Agent editor consumes the same catalog, but runtime
validation remains authoritative in case a client is bypassed or an old row
contains a retired model. `DEFAULT_AI_MODEL` must name a catalog entry.

Operators should recalibrate catalog economics whenever model pricing, plan
credits, typical context size, or tool behavior changes. A model is not enabled
for tenants merely because Workers AI can resolve its string ID.

## Observability

The request middleware accepts a safe caller-provided `x-request-id` or creates
a UUID, returns it in the response, and writes a structured completion event.
Agent run lifecycle, refunds, Stripe webhook failures, and rate-limit decisions
also emit structured JSON. Wrangler enables full log ingestion and 5% trace
sampling by default; tune sampling for traffic volume and retention cost.

Stripe events use a five-minute processing lease. Retries can atomically reclaim
stale events, while recent concurrent deliveries receive a retryable conflict.
Static asset responses receive their security policy from `public/_headers`;
API and Durable Agent responses are handled by Worker code.

## Why not Next.js

Next.js is a good SaaS UI framework, but it adds an adapter and server-runtime
surface that is unnecessary for this starter. Vite, React, Hono, and the
Cloudflare Vite plugin produce one deployable Worker while keeping the client
and server module boundaries explicit.
