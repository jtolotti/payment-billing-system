# Payment & Billing System

A production-pattern billing system built with NestJS, Prisma, Postgres, and Next.js. Implements a double-entry accounting ledger, multi-gateway payment processing (card + crypto), atomic webhook deduplication, and a full chargeback/dispute lifecycle.

Built as a portfolio project demonstrating senior billing engineering patterns: money correctness under concurrency, idempotent retry design, crash-safe transaction ordering, and production incident runbooks.

---

## What's implemented

### Core billing engine
- **Double-entry ledger** (`LedgerService`) — every money movement is a balanced DEBIT/CREDIT pair. Enforced at the service level: unbalanced transactions are rejected before touching the DB.
- **Credits system** (`CreditsService`) — flat user balance synchronized with the ledger. Uses `SELECT FOR UPDATE` + `ReadCommitted` isolation to prevent double-spend races.
- **Subscription lifecycle** — `PENDING → ACTIVE → CANCELED`. No retry dunning: a failed charge cancels immediately.

### Payment refunds
Three-step admin workflow (`PENDING → APPROVED → PROCESSED`):
- Calls `AuthorizeNetGateway` or `SolanaGateway` via a shared `PaymentGatewayAdapter` interface.
- Gateway-first ordering: the external call happens before the DB transaction, so retries can't double-refund.
- `paymentRefundId` guard handles crash between DB commit and status update (two distinct recovery paths).
- `processAttempts` + `lastProcessError` on `RefundRequest` — admins see stuck refunds in the UI without log access.

### Chargeback / dispute lifecycle
- `chargeback.received` webhook handler runs inside the existing atomic dedup `$transaction` — dispute creation, ledger reversal, and credits deduction are all-or-nothing with the dedup row.
- `setOutcome('WON')` — reversal-of-reversal restores revenue and credits.
- `setOutcome('LOST')` — original reversal stands, $15 fee recorded as an EXPENSE entry.
- State machine validates transitions: `OPEN / EVIDENCE_SUBMITTED → WON | LOST` (terminal). Prevents ledger corruption from double-resolution.

### Admin UI (`@billing/ui` component library)
- `/admin/refunds` — lists all refund requests, processes PAYMENT refunds, shows `gatewayRefundId` and error details.
- `/admin/disputes` — lists all disputes by status.
- `/admin/disputes/[id]` — dispute detail with evidence upload and outcome recording.

### Tests
56 unit tests across 7 spec files, all passing. Coverage includes crash recovery paths, gateway errors, P2002 race conditions, idempotent webhook replays, and invalid state transitions.

---

## Architecture

See [docs/architecture.md](./docs/architecture.md) for a full tour of:
- The two parallel money systems (ledger + credits)
- The gateway abstraction (`PaymentGatewayAdapter`)
- The webhook dedup pattern
- The refund and chargeback flows
- Known architecture gaps and planned improvements

Improvement roadmap: [docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md)

Solution design decisions: [docs/SOLUTION.md](./docs/SOLUTION.md)

---

## Quick start

```bash
# From the repo root:
docker compose up -d         # Postgres on port 5433
npm run setup                # install, migrate, seed
npm run dev                  # api on :4000, web on :3000
```

Open http://localhost:3000, pick a seeded user, explore. Run tests with `npm run test`.

Full setup details in [SETUP.md](./SETUP.md).

> **Note:** Authentication is currently a header stub (`x-user-id`). JWT migration is planned — see [IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md#2-jwt-authentication).

---

## Design decisions

### Money correctness under failure

**Gateway-first refund ordering.** The gateway call happens before the `$transaction`. If the DB fails after the gateway succeeds, retry is safe: the gateway mock returns the cached `gatewayRefundId`. If the status update fails after the DB transaction commits, the `paymentRefundId` guard detects the prior write and skips straight to status update — no duplicate ledger entries.

**Chargeback handler inside the existing transaction.** Unlike the refund, the chargeback has no external HTTP call to worry about. All five operations (dedup row, dispute creation, ledger reversal, txn ID link, credits deduction) run inside one `$transaction`. If any step fails, the dedup row rolls back and the gateway retries cleanly.

**No automatic access restoration on dispute WON.** The subscription may have been canceled for unrelated reasons. Auto-restore without human review risks giving unearned service. Tracked as a planned improvement (see [IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md#7-dispute-won--access-restoration-workflow)).

### Idempotency map

| Operation | Key | Enforced by |
|-----------|-----|-------------|
| Gateway `refundCharge` | `refund_{refundRequestId}` | Gateway mock (in-memory Map) |
| Credits deduction on refund | `refund_deduct_{refundRequestId}` | CreditsService (JSONB inside `$transaction`) |
| Chargeback webhook | `eventId` (gateway event ID) | `processed_webhooks` PK + P2002 fallback |
| Dispute creation | `gatewayDisputeId` (unique column) | DisputesService `findUnique` check |
| Credits restore on WON | `dispute_won_{disputeId}` | CreditsService (JSONB inside `$transaction`) |

### Ledger entries

| Event | Debit | Credit |
|-------|-------|--------|
| Payment refund | Revenue | User ASSET |
| Chargeback received | Revenue | User ASSET |
| Dispute WON | User ASSET | Revenue |
| Dispute LOST (fee) | Expense | User ASSET |

---

## The simulator — how to test

The simulator exposes POST endpoints that deterministically fire webhook/confirmation events into the system so you don't need real gateways. You can call these from curl, from Postman, or from integration tests.

```bash
# Card: simulate a successful rebill
curl -X POST http://localhost:4000/__simulator__/card/rebill \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","plan":"STANDARD","amountCents":1000}'

# Card: fire the same rebill twice to test idempotency (should grant credits exactly once)
curl -X POST http://localhost:4000/__simulator__/card/rebill/duplicate \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","plan":"STANDARD","amountCents":1000}'

# Card: simulate a chargeback against a previous transaction
curl -X POST http://localhost:4000/__simulator__/card/chargeback \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","originalTransactionId":"an_txn_abc","amountCents":1000,"reason":"fraudulent"}'

# Card: simulate a failed charge (should cancel the sub immediately per no-dunning policy)
curl -X POST http://localhost:4000/__simulator__/card/charge-failure \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","reason":"declined_insufficient_funds"}'

# Solana: simulate a confirmation at depth 1 (not settled yet)
curl -X POST http://localhost:4000/__simulator__/solana/confirmation \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","amount":1000,"confirmations":1,"plan":"STANDARD"}'

# Solana: simulate the same tx at depth 3 (settled, credits granted)
curl -X POST http://localhost:4000/__simulator__/solana/confirmation \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","amount":1000,"confirmations":3,"txHash":"TxAbc...","plan":"STANDARD"}'

# Reset all simulator state for a user (clears sub, credits, ledger, refunds, disputes)
curl -X POST http://localhost:4000/__simulator__/reset \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1"}'
```

---

## Docs index

| File | Contents |
|------|----------|
| [docs/architecture.md](./docs/architecture.md) | Full system architecture, module graph, ledger model, webhook pattern, gaps & improvements |
| [docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md) | Prioritized roadmap of 10 improvements (P1–P3) with affected files and complexity estimates |
| [docs/SOLUTION.md](./docs/SOLUTION.md) | Design decisions, ledger entry reference, idempotency map, failure/recovery matrix |
| [docs/SOLUTION_DIAGRAMS.md](./docs/SOLUTION_DIAGRAMS.md) | Mermaid flow diagrams for all three main flows |
| [docs/runbooks/chargeback-incident.md](./docs/runbooks/chargeback-incident.md) | Production incident runbook: severity classification, diagnosis queries, recovery steps |
| [docs/Billing_Trial_Demo.postman_collection.json](./docs/Billing_Trial_Demo.postman_collection.json) | Postman collection for end-to-end manual testing |
| [SETUP.md](./SETUP.md) | Detailed setup, environment variables, migration and seed steps |
