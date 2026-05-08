# Billing Trial — Refunds & Chargeback Lifecycle

> **Loom walkthrough**: https://www.loom.com/share/f5c86b733186446989b6253627e93285

---

## What I built

### Task 1: `processPaymentRefund` — gateway execution + ledger reversal
- Implemented the stubbed `processPaymentRefund` method in `refunds.service.ts`
- Calls the appropriate gateway adapter (`AuthorizeNetGateway` or `SolanaGateway`) via `refundCharge()` with idempotency key `refund_{refundRequestId}`
- Writes a balanced double-entry ledger reversal: DEBIT Revenue, CREDIT User ASSET
- Records the returned `gatewayRefundId` on `refund_requests.payment_refund_id`
- Deducts virtual credits with graceful handling for insufficient balance
- Added `originalGatewayTransactionId` column via additive migration to link refunds to the original charge
- Added `processAttempts` and `lastProcessError` columns for operational visibility — every failed process attempt is recorded so admins see error details and attempt count directly in the UI

### Task 2: `chargeback.received` webhook handler + dispute lifecycle
- Wired the `chargeback.received` case inside the existing webhook controller's `$transaction` and dedup pattern
- Creates a `Dispute` record via `DisputesService.createDispute` (idempotent by `gatewayDisputeId`)
- Writes a balanced ledger reversal and stores `ledgerReversalTxnId` on the dispute for future unwinding
- Deducts user credits atomically with the dedup row

### Dispute outcome handling (`setOutcome`)
- **WON**: Writes a reversal-of-reversal (DEBIT User ASSET, CREDIT Revenue) + restores credits
- **LOST**: Keeps the original reversal + records $15 chargeback fee (DEBIT Expense, CREDIT System ASSET)
- Added state transition validation — WON and LOST are terminal states; prevents ledger corruption from double-resolution

### Admin UI
- Extended `/admin/refunds` to show the gateway refund ID for processed PAYMENT refunds
- Built `/admin/disputes/[id]` with dispute overview, evidence upload form, and outcome recording buttons
- Used `@trial/ui` components exclusively — no raw HTML for interactive elements
- State-aware: evidence form and action buttons hide after resolution

### Tests
- 28 new tests across 3 spec files (56 total passing)
- Coverage: crash recovery paths, gateway errors, insufficient credits, idempotent webhook replays, P2002 race conditions, invalid state transitions, HMAC signature verification

### Documentation
- `docs/runbooks/chargeback-incident.md` — production incident playbook with severity classification, diagnosis queries, recovery steps, user communication templates, and prevention measures
- `docs/SOLUTION.md` — full architecture document with design decisions, ledger mappings, idempotency map, and failure recovery matrix
- `docs/SOLUTION_DIAGRAMS.md` — mermaid flow diagrams for `processPaymentRefund`, `chargeback.received`, and `setOutcome`

---

## Design decisions

### 1. Gateway call BEFORE the database transaction (Task 1)

The gateway is the irreversible external side-effect — once money leaves Authorize.Net, we can't uncommit it. Placing the call before the `$transaction`:

- Avoids holding Postgres row-level locks during an HTTP call (recipe for timeouts under concurrent load)
- Makes retry safe: gateway is idempotent on key `refund_{id}`, returns the cached `gatewayRefundId` without double-refunding
- Keeps the DB transaction fast and lock-free

If the gateway succeeds but the DB transaction fails, the admin retries and the gateway returns the same cached result. No double-refund, no orphaned state.

### 2. `paymentRefundId` guard for crash recovery

I identified a gap: `processRefund()` does the `status = PROCESSED` update as a separate DB call after `processPaymentRefund()` returns. If the inner `$transaction` commits but the status update crashes, on retry the refund is still APPROVED → re-enters `processPaymentRefund()` → creates duplicate ledger entries.

**Fix**: One-line guard at the top — if `paymentRefundId` is already set, skip the entire gateway + ledger + credits block and jump straight to the status update. This gives us two clean crash recovery paths:

| Failure Point | State After | Recovery |
|---|---|---|
| Gateway OK → DB fails | `paymentRefundId` = NULL (rolled back) | Full retry safe — gateway returns cached result, DB transaction runs fresh |
| DB OK → status update fails | `paymentRefundId` = SET | Guard fires → skip to status update. No duplicate ledger entries |

### 3. Chargeback handler inside the existing `$transaction` (Task 2)

Unlike the refund (gateway first, then DB), the chargeback handler has no external call — the webhook IS the external event. All five operations run inside the scaffold's existing `$transaction`:

1. Insert dedup row (`processed_webhooks`)
2. Create dispute (idempotent by `gatewayDisputeId`)
3. Write ledger reversal (DEBIT Revenue, CREDIT User ASSET)
4. Link `ledgerReversalTxnId` to dispute
5. Deduct credits

If any step fails → dedup row rolls back → gateway retries → full atomicity preserved.

### 4. Dispute state transition validation

The existing `setOutcome` had no status guards. Without one, calling WON then LOST would fire both the revenue restoration AND the chargeback fee — restoring credits AND recording an expense — corrupting the ledger.

Added a transition map: OPEN and EVIDENCE_SUBMITTED can move to WON or LOST. WON and LOST are terminal — any further transition is rejected with 400.

### 5. No automatic access restoration on dispute WON

I deliberately did NOT auto-restore subscription access when a dispute is won. The subscription might be canceled for unrelated reasons (charge failure, user request, plan change). Auto-restoring would override those decisions. This requires human review.

### 6. Credits deduction — graceful failure

For both refunds and chargebacks, if the user has insufficient credits: log a warning and continue. A $50 real money refund shouldn't be blocked because the user already spent virtual credits. In production, this would trigger a finance team alert.

### 7. `originalGatewayTransactionId` as explicit column

The gateway adapter's `refundCharge()` needs the original transaction ID. I chose an explicit nullable column on `RefundRequest` over alternatives like pulling from ledger metadata or `GatewaySubscription.gatewayData` — those are fragile when users have multiple transactions. The additive migration follows the scaffold's pattern.

### 8. Process attempt tracking for operational visibility

When `processRefund` fails (gateway error, DB crash, validation error), the refund stays APPROVED with no record of what went wrong. Admins had to check server logs to understand why a refund was stuck.

Added `processAttempts` (Int, default 0) and `lastProcessError` (String, nullable) on `RefundRequest`. On every failure: increment the counter, save the error message, re-throw. On success: clear the error. The admin UI shows error details and attempt count in red on any APPROVED refund that has previously failed. This surfaces persistent failures (gateway consistently declining) vs. transient issues (one-time network timeout) without requiring log access.

---

## What I didn't build

- **Automatic access restoration on dispute WON** — Deliberately excluded. Requires human review (see Design Decision #5).
- **Solana chargeback handling** — Only Authorize.Net has chargebacks in this scaffold. Solana uses confirmation-depth events, not dispute workflows.
- **Async webhook processing** — The scaffold explicitly says "do not modify this pattern." The mock gateways are in-process, so there's no real timeout risk. Called out as a production concern below.
- **Retry/dunning logic** — Hard constraint against this. Failed charge = immediate cancellation. Chargebacks against canceled subscriptions are handled as normal flow, not edge cases.

---

## How to verify

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Install, migrate, seed
npm run setup

# 3. Run all tests (56 passing)
npm run test

# 4. Start dev servers (API :4000, Web :3000)
npm run dev
```

### End-to-end verification via simulator

```bash
# Reset user state
curl -X POST http://localhost:4000/__simulator__/reset \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1"}'

# Create a charge to dispute
curl -X POST http://localhost:4000/__simulator__/card/rebill \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","plan":"STANDARD","amountCents":2000}'

# Trigger chargeback
curl -X POST http://localhost:4000/__simulator__/card/chargeback \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","originalTransactionId":"<txn_id_from_rebill>","amountCents":2000,"reason":"fraudulent"}'
```

Then open http://localhost:3000, select `test-admin-1`, navigate to `/admin/disputes`, and walk through: view dispute → submit evidence → mark as WON → verify credits restored.

Postman collection available at `docs/Billing_Trial_Demo.postman_collection.json`.

---

## Known gaps / follow-ups

| Gap | Impact | Suggested Fix |
|-----|--------|---------------|
| `originalGatewayTransactionId` populated manually | Admin must provide it at refund creation | Auto-populate from charge webhook metadata |
| Chargeback fee ($15) is hardcoded | Inflexible for different processors/networks | Move to config table or per-gateway settings |
| Synchronous webhook processing | Risk of gateway timeouts and retry storms under load | Persist raw payload → ack 200 → process via async job queue |
| Credits deduction silently continues on insufficient balance | Finance team unaware of balance gaps | Add alert/notification for the finance team |
| No automated reconciliation | Missed chargebacks not caught proactively | Scheduled job to compare gateway records vs disputes table |
| Ledger entries not independently deduped | Relies on outer flow dedup — new code paths could bypass it | Add `idempotency_key` column to `ledger_transactions` with unique constraint |

---

## One thing I'd do differently

Add an independent `idempotency_key` column directly on `ledger_transactions`. Currently, ledger writes are only protected by the outer flow's deduplication (gateway idempotency for refunds, `processed_webhooks` for chargebacks). If a future code path writes ledger entries without those outer guards, duplicates are possible. A unique constraint on the ledger itself would be a defense-in-depth safety net — one migration and a small change to `recordTransaction`.

## One production concern

**Synchronous webhook processing.** The current architecture processes the entire event — dedup check, dispute creation, ledger writes, credits adjustments — inside a single `$transaction`, blocking until everything completes before returning 200 to the gateway.

Under load, if ledger writes are slow or there's row-level lock contention, the gateway's HTTP request times out. It retries, adding more requests, more contention — a thundering-herd spiral.

The fix is the industry standard: persist the raw webhook payload to a durable store immediately, ack with 200 within milliseconds, then process the event asynchronously via a job queue (Bull, SQS, Pub/Sub). I didn't change this because the scaffold explicitly says "do not modify this pattern," but I documented it in the chargeback incident runbook.
