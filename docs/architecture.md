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

## Direct QR payments

WeChat Pay and Alipay settle in mainland China, but Stripe's hosted checkout is
slow or unreachable there. The pricing page therefore offers a second path for
one-time credit packs that keeps the customer in the app:

The pricing cards label these packs separately from monthly subscriptions:
wallet payments grant credits once and do not upgrade the subscription. The
dialog explicitly offers switching to a monthly, automatically renewing card
subscription; this is a change of product, not just a different payment method.

```text
POST /api/billing/qr  { planId, method }
  -> requireWorkspaceManager + rate limit
  -> insert a local `order` row (kind = credit_pack)
  -> create a PaymentIntent with confirm=true and payment_method_types=[method]
  -> read the confirmed intent's next_action
  -> return one of:
       { kind: "qr",       qrImage }     data: URL drawn by this app
       { kind: "redirect", fallbackUrl } Stripe's hosted instructions page
Browser polls GET /api/billing/qr/:id every 3s
  -> succeeded         grant credits, then report paid
  -> failed/canceled   report expired
DELETE /api/billing/qr/:id cancels an intent nobody is looking at any more
```

Three properties matter here.

The QR is rendered server-side as an SVG `data:` URL, so the browser draws the
code without a second network round trip and without ever loading a Stripe
page. Stripe's own `image_data_url` is used when it provides one (WeChat Pay
usually does); otherwise the payload is encoded locally, including Alipay's
`native_url` deep link, which is what makes the code scannable from a desktop
browser. `src/shared/direct-qr.ts` holds the contract both bundles import, so the
Worker and the browser cannot disagree about which wallets exist.

Credits are granted through the same `credit_ledger` idempotency key whether the
poll or the `payment_intent.succeeded` webhook arrives first, so a customer who
closes the dialog after paying is still credited and nobody is credited twice.
The webhook remains the source of truth; the poll is a fast path.
The `/pricing?checkout=qr-return&payment_intent=...` return page also checks the
authenticated status endpoint, even in a new tab with no dialog state. It waits
for sign-in when needed, polls pending payments, and shows terminal outcomes
without opening another checkout. Status errors can be retried without creating
or canceling a payment. A 401 revalidates Better Auth's shared session before
offering sign-in, so the login page cannot redirect using a stale cached user.
If that refresh fails, the result page offers a status retry instead.
It ignores `redirect_status` and removes the unused
`payment_intent_client_secret` from the URL; ownership is verified server-side.
The grant uses the credits stored on the order, so changing or retiring a plan
after checkout does not change what an existing customer receives.

Switching wallets or continuing to card checkout waits for the current create
request and a confirmed cancellation. A payment that succeeded finishes the
dialog; a pending or unreadable result keeps the current payment under polling.
Responses are matched by request identity, so returning to the same wallet
cannot revive an older request. Dismissal and unload still cancel best effort.
The pagehide handler retains the payment identity because the browser may
restore the page from its back/forward cache without remounting React. On
pageshow, the dialog immediately checks the original payment and continues
polling if its result is still unknown. Switching payments still requires a
confirmed cancellation. If the cancellation endpoint discovers a successful
payment, it completes the same idempotent credit grant before returning success.

Availability is configuration, not code: `DIRECT_QR_PAYMENT_MODE` selects
`off`, `admins`, or `all`, and each wallet is offered only for a currency Stripe
settles it in. An unusable combination falls back to card checkout instead of
showing a button that cannot work. The same answer carries `canManage`, so a
plain member never sees a button whose submit would be refused.
The pricing page also requires the selected plan's configured Stripe Price ID,
matching the server's plan validation for both payment paths.

The credit pack is charged at `monthlyPrice` in `DIRECT_QR_CURRENCY`, one to
one: there is deliberately no exchange-rate step, because the plan list prices
and the Stripe subscription prices are expected to be denominated in that same
currency. The pricing page prints its prices in that currency too — the catalog
response carries it on every plan, so the label is right on first paint and does
not wait for a second request — which keeps the number on the card, the number
in the dialog, and the amount Stripe charges a single number rather than three.

Two failure modes are handled explicitly, because a PaymentIntent is real money
from the moment it is confirmed. If Stripe returns no code for an intent that has
already settled, the intent is fulfilled and the caller gets `409 already_paid`
rather than a cancellation that would refund a paid order. If confirming fails
for any other reason, the intent is cancelled and the `order` row is failed in
the same request, so nothing payable is left dangling.

PaymentIntents do not expire on their own, so the scheduled handler runs
`expireStaleDirectQrOrders`: after `DIRECT_QR_ORDER_STALE_SECONDS` (thirty minutes
by default, floored at five) an abandoned `credit_pack` order is cancelled, and
if the wallet had settled it in the meantime the credits are granted instead —
the same recovery path that covers a webhook lost in transit. Each candidate is
swept in isolation and an unconfirmable intent keeps its row, so one bad row can
neither starve the batch nor drop a still-payable code out of the sweep.
If cancellation fails while Stripe still reports a nonterminal status, the order
also remains eligible for the next sweep, which can cancel it or grant a later
successful payment.
Each attempt is recorded in `order.last_reconcile_attempt_at` before contacting
Stripe, including attempts that fail or leave the payment unresolved. Batches
prioritize the least recently attempted orders, so 25 stuck payments cannot
prevent later orders from being cancelled or reconciled. This scheduling state
is in D1 and survives Worker restarts; uncertain orders remain eligible to retry.

A webhook whose intent names an order that is gone, or one that disagrees with
it about the payer, can never become grantable. `fulfillDirectQrIntent` reports
those as `DirectQrUnfulfillableError`, which the webhook handler logs and then
marks completed: retrying an event that will fail identically would block every
later event behind Stripe's retry schedule. Transient failures — a database
error, say — are not wrapped, so those still retry.

## Traffic analytics

The dashboard at `/app/admin/analytics` answers three questions — how many page
views, how many distinct visitors, and where they came from — and nothing else.
It is a first-party, cookieless counter, not a product-analytics replacement.

```text
browser beacon             Worker                    D1
  POST /api/analytics/collect ──▶ recordAnalyticsVisit ──▶ analytics_visit
  (path, referrer, utm_*)        drop bots / assets / DNT
  GET /api/admin/analytics ────▶ getAnalyticsOverview ──▶ grouped aggregates
  (platform admins)              zero-fill the day series
```

**The browser is the only writer, by necessity.** `wrangler.jsonc` serves the
built SPA through Cloudflare's static assets with
`not_found_handling = "single-page-application"`, and `run_worker_first` only
covers `/api/*` and `/agents/*`. A navigation to `/pricing` is therefore answered
by the asset layer and never reaches the Worker, so server logs, request
middleware, and Durable Object counters cannot see page views at all. The SPA
reports one view per route change from `usePageViewTracking`, which is also the
only participant that knows a page was actually shown rather than prefetched.

Three properties keep the numbers honest:

- **A page view is not a request.** The beacon is fire-and-forget with
  `keepalive`, respects Do Not Track, drops `/api` and `/agents` paths and
  anything with a static-asset extension, and rejects bot user agents (including
  an empty one) server-side. The endpoint needs no session because landing pages
  are anonymous; a 4 KB body limit and a per-IP rate limit bound the cost, and
  everything it decides is best effort. A visitor without JavaScript is simply
  not counted.
- **Visitors are counted, not tracked.** `computeVisitorKey` stores
  `sha256(salt | ip | user-agent | hints)` truncated to 32 hex characters. The
  salt is deliberately stable rather than rotated per calendar month: a rotating
  salt sliced one person into one identity per month, and since a 30-day window
  straddles a month boundary on all but two days of the month, the headline
  unique-visitor number was inflated almost every time it was read. Accuracy of
  that number is the point of the dashboard, so the privacy bound is deletion
  instead — rows are removed after `ANALYTICS_RETENTION_DAYS`, the raw IP is
  never stored, there is no cookie and no client-side id, and an operator who
  wants a hard reset rotates `ANALYTICS_SALT`. `hints` carries only the stable
  client hints (platform and the mobile flag) so two people sharing one address
  and one browser version are not merged into a single visitor; version numbers
  are excluded because they change on every browser update and would break
  continuity for a returning visitor. Falling back to `BETTER_AUTH_SECRET` when
  `ANALYTICS_SALT` is unset is logged once, because rotating that secret — the
  normal response to a leak — would otherwise reset visitor continuity silently.
- **Paths are identities, not URLs.** `normalizeAnalyticsPath` drops query and
  hash, collapses slashes, and rewrites id-looking segments to `:id`, so
  `/chats/42` and `/chats/57` share one "top pages" row. Sources come from
  `utm_source` when present, then from the referrer host, which is matched
  against a search-engine and social-network table and otherwise stored as
  `referral`; the app's own host is `internal`. Only the first view of a document
  carries the external referrer — later in-app navigations report our own origin,
  because `document.referrer` never changes while the SPA stays mounted and using
  it would credit the landing channel with the whole session.

Reads are one round trip of indexed aggregates: totals and the equally long
previous window share a single parameterized statement, and days without traffic
are zero-filled in JavaScript so the chart always receives exactly `days` points.
Campaign rankings group by campaign name, source host (the UTM source when
provided), and medium, preserving separate channels that share a campaign name.
Each aggregate opens the window with `analytics_visit_day_idx` and then sorts the
matching rows for its `GROUP BY`, so a dashboard load reads roughly ten times the
number of rows in the window — fine at a few thousand views a day, and the point
at which a daily rollup table becomes necessary if traffic grows by an order of
magnitude.
Retention is enforced by the cron purge, which floors `ANALYTICS_RETENTION_DAYS`
at seven days — a mistyped operator value must not be able to empty the
dashboard, and there is no backup to restore it from.

Days are bucketed in `ANALYTICS_TIME_ZONE` (UTC by default), so "today" starts
filling at the operator's midnight rather than UTC's — for a UTC+8 audience the
default would otherwise leave the morning's traffic in yesterday's bucket.
`analyticsDay` is the only place a date becomes a day label, and both the write
path and every range bound go through it, which is what keeps the stored labels
and the query window on the same calendar. A zone name `Intl` rejects falls back
to UTC with one warning instead of throwing: a typo in a variable must not stop
page views from being recorded. `shiftDay` stays pure calendar arithmetic on the
label, so it needs no zone at all.

Beacons are also checked against the browser's client hints, not just the user
agent: `HeadlessChrome` in `sec-ch-ua` is generated by the browser and survives a
`--user-agent` override, so an automated browser that bothers to lie is still
dropped. Browsers that send no hints pass untouched.

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

## Site-wide announcements

Announcements are intentionally global editorial content, not tenant-owned data.
Publishing requires an authenticated user whose immutable ID appears in the
server-side `PLATFORM_ADMIN_USER_IDS` allowlist. Organization owner/admin roles
never confer this capability; the allowlist is not returned to the browser.
`/api/session` returns only the current user's `isPlatformAdmin` capability.

D1 stores announcements and per-user read/dismiss preferences. A unique
`(user_id, notice_id)` index and a conditional upsert make retries/concurrent
reads safe without clearing a previous dismissal. Preferences follow the user
across workspaces. Only active, non-deleted notices are public. Soft deletion
is distinct from taking a notice offline and cannot be undone through the API.
Read endpoints return explicit DTOs without author IDs or deletion metadata.
