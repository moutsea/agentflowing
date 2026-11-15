# Changelog

All notable changes to AgentFlowing will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to follow [Semantic Versioning](https://semver.org/) after the first stable release.

## [Unreleased]

### Added

- English and Simplified Chinese open-source documentation.
- GitHub contribution, security, conduct, issue, and pull-request templates.

### Fixed

- T7/R1: reconcile failed Stripe attempts and release coupon reservations only after confirmed cancellation.
- T7/R2: keep orders and coupon reservations pending when Stripe search has not indexed the payment.
- T7/R3: persist rediscovered PaymentIntent IDs and continue cancellation/reconciliation for payable intents.
- T7/R4: redact code-bearing admin/external request paths and hash credential identifiers in error logs.
- T7/R6: report domain-derived current redemption-code state consistently on issuance replay and lookup.
- T7/R8: preserve malformed-JSON client errors as bilingual 400 invalid_request responses.
- T7/R9: propagate coupon database failures instead of reporting nonexistent codes.
- T7/R5: connect user coupon preview/QR checkout and redemption preview/claim with workspace balance refresh.
- T7/R7: persist issuance keys together with normalized parameters and provide explicit original-request recovery after refresh.
- T7/N3: keep SQL-bound credentials out of global failure logs; return bilingual retryable errors with request IDs and credential digests.
- T7/N1: release definitively rejected Stripe creates and persist exact requests for bounded idempotent recovery before cancellation or settlement.
- T7/N2: allow correcting definitively unissued admin requests while retaining original request recovery for unknown outcomes.
- T7/F1: release coupons on definitive initial Stripe authorization rejection without treating later retry rejection as proof of non-payment.
- T7/F2: share coupon origin protection with QR creation/cancellation before any payment or reservation side effects.

## [0.1.0] - 2026-08-07

### Added

- Cloudflare-native React and Hono application shell.
- Better Auth email/password, optional OAuth, Magic Link, and password reset.
- Organization workspaces and tenant-aware Agent management.
- Durable Object conversations with Workers AI streaming.
- D1 credit ledger, Stripe subscriptions, idempotent billing, and stale-run refunds.
- R2 file context, hashed API keys, external Agent API, rate limits, and observability.
- English and Simplified Chinese product UI.
- Workers-runtime tests and GitHub Actions CI.
