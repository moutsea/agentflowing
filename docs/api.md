# External API

The external API is intended for trusted server-to-server integrations. Create
and revoke keys in the workspace settings UI.

## Authentication

Send the key as a Bearer token:

```http
Authorization: Bearer af_live_...
```

Available scopes:

| Scope         | Capability                          |
| ------------- | ----------------------------------- |
| `agents:read` | List live Agents in the workspace   |
| `agents:run`  | Run an Agent and consume credits    |
| `files:read`  | Reserved for file retrieval clients |

An invalid or revoked key returns `401`. A valid key without the required scope
returns `403`.

Every response includes `x-request-id`. Clients may send their own ID using the
same header when it is 8–128 characters and contains only letters, numbers,
periods, underscores, colons, or hyphens. Include this value when investigating
a failed request in Worker logs.

## List Agents

`GET /api/v1/agents`

The response omits system prompts and internal tenant identifiers.
Private Agents are omitted even when the API key was created by the Agent owner.

## Run an Agent

`POST /api/v1/agents/:agentId/run`

```json
{
  "message": "Compare the two launch plans",
  "idempotencyKey": "customer-42-launch-comparison-v1",
  "assetIds": ["optional-r2-file-metadata-id"]
}
```

`idempotencyKey` must be 8–128 characters and may contain letters, numbers,
periods, underscores, colons, and hyphens. Up to six text, Markdown, CSV, or JSON
assets can be attached. Assets must belong to the API key's workspace and their
combined stored size must not exceed 300 KB.

Successful response:

```json
{
  "data": {
    "runId": "...",
    "output": "...",
    "credits": 2,
    "usage": {
      "inputTokens": 180,
      "outputTokens": 420
    },
    "replayed": false
  }
}
```

The same completed idempotency key returns the stored output with
`"replayed": true`. A request replayed while the original is still running
returns `409`.

The request cannot select a model or override its credit cost. Both values come
from the published Agent and are revalidated against `src/shared/ai-models.ts`
before every run. Retired or underpriced Agent configurations fail closed.

## Rate limits

External Agent execution uses the `AI_RATE_LIMITER` binding. General account,
file, billing, and key-management writes use `API_RATE_LIMITER`; authentication
writes use `AUTH_RATE_LIMITER`. A limited response returns `429`, a
`Retry-After: 60` header, and this body:

```json
{
  "error": "rate_limited",
  "message": "Too many requests. Try again shortly.",
  "scope": "external_agent_run"
}
```

Rate limits are abuse controls, not billing counters. Credit spends, refunds,
and replay protection are enforced independently by D1 constraints.
Stripe webhooks use their own rate-limit namespace and a five-minute processing
lease, separate from authenticated API traffic.

## Error envelope

```json
{
  "error": "insufficient_credits",
  "message": "Insufficient credits"
}
```

Common statuses are `400` for invalid input or attachments, `401` for invalid
credentials, `402` for insufficient credits, `403` for missing scopes, `404` for
tenant-scoped missing resources, `409` for unavailable Agents or in-flight
idempotency keys, and `429` for rate-limited requests.
