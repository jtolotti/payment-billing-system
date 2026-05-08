# Solution Architecture — Refunds & Chargeback Lifecycle

> Design document covering the architecture, flows, design decisions, and edge case handling for the implemented billing features.

---

## 1. What Was Built

| # | Deliverable | Files |
|---|-------------|-------|
| 1 | **`processPaymentRefund`** — gateway execution + ledger reversal + idempotency | `refunds.service.ts`, `refunds.module.ts`, `refunds.controller.ts` |
| 2 | **Schema: `originalGatewayTransactionId`** — links refunds to the original charge | `schema.prisma`, migrations |
| 3 | **`chargeback.received` handler** — dispute creation + ledger reversal + credits deduction | `authorize-net-webhook.controller.ts` |
| 4 | **`setOutcome` (WON/LOST)** — ledger adjustments + transition validation | `disputes.service.ts` |
| 5 | **Unit tests** — 56 tests across 7 spec files | `refunds.service.spec.ts`, `disputes.service.spec.ts`, `authorize-net-webhook.controller.spec.ts` |
| 6 | **Admin refunds page** — show gateway refund ID for processed PAYMENT refunds | `admin/refunds/page.tsx` |
| 7 | **Admin dispute detail page** — overview, evidence upload, outcome recording | `admin/disputes/[id]/page.tsx`, `admin/disputes/page.tsx` |
| 8 | **Chargeback incident runbook** | `docs/runbooks/chargeback-incident.md` |
| 9 | **Ledger idempotency key** — `idempotency_key UNIQUE` on `ledger_transactions`; all callers pass named keys | `ledger.service.ts`, all `recordTransaction` callers, migration `20260507000001` |
| 10 | **ChargeRecord** — settled charge log; auto-populates `originalGatewayTransactionId` on refund creation | `schema.prisma`, `authorize-net-webhook.controller.ts`, `solana-confirmation.controller.ts`, `refunds.service.ts` |
| 11 | **BillingConfigService** — runtime-configurable billing params (`billing_config` table) | `billing-config.service.ts`, `billing.module.ts`, `disputes.service.ts` |

---

## 2. Architecture Overview

### Two Parallel Money Systems

The system maintains two synchronized representations of value:

- **Ledger** (`LedgerService`): Formal double-entry accounting. Every transaction has balanced DEBIT/CREDIT entries. Account types: ASSET (user credits held), LIABILITY, REVENUE (realized income), EXPENSE (costs), EQUITY.
- **Credits** (`CreditsService`): Simpler flat balance per user. Must stay in sync with the ledger.

Both systems are updated atomically during refunds and chargebacks. A refund that updates one but not the other leaves the system inconsistent.

### Module Dependency Graph

```
AppModule
├── BillingModule
│   ├── LedgerService         ← double-entry ledger; idempotencyKey on every write
│   ├── CreditsService        ← flat credit balance
│   ├── SubscriptionsService
│   ├── PlansService
│   └── BillingConfigService  ← runtime config from billing_config table
│
├── GatewaysModule (imports: BillingModule, DisputesModule)
│   ├── AuthorizeNetGateway          ← used by refunds
│   ├── SolanaGateway                ← used by refunds
│   ├── AuthorizeNetWebhookController  ← injects LedgerService; writes ChargeRecord
│   └── SolanaConfirmationController   ← writes ChargeRecord on confirmation
│
├── RefundsModule (imports: BillingModule, GatewaysModule)
│   └── RefundsService  ← auto-populates originalGatewayTransactionId from ChargeRecord
│
├── DisputesModule (imports: BillingModule)
│   └── DisputesService ← injects BillingConfigService for configurable chargeback fee
│
└── SimulatorModule
```

**No circular dependencies.** The arrow goes one way:
`RefundsModule → GatewaysModule → DisputesModule → BillingModule`

---

## 3. Design Decisions

### 3.1 Gateway Call BEFORE DB Transaction (Task 1)

The gateway call is the external side-effect we can't roll back. Placing it before the DB transaction:

1. **Call gateway first** — idempotent, safe to retry
2. **Then do the DB transaction** — ledger reversal + record `paymentRefundId` + deduct credits
3. **If DB fails after gateway succeeds** — retry is safe because gateway returns cached result (same `gatewayRefundId`)

This pattern avoids holding DB transaction locks during external HTTP calls.

### 3.2 `originalGatewayTransactionId` — Auto-populated via ChargeRecord

**Problem**: The `RefundRequest` model didn't store the original gateway transaction ID needed for `adapter.refundCharge()`. Admins had to supply it manually — error-prone and incompatible with automated refund workflows.

**Decision**: Add an optional `originalGatewayTransactionId` column (auditable, explicit). Additionally, add a `ChargeRecord` table: every settled charge event (`charge.approved`, `subscription.renewed`, Solana confirmation) upserts a row keyed by `(gatewayType, gatewayTransactionId)`. When `createRefundRequest` is called without `originalGatewayTransactionId`, it looks up the most recent `ChargeRecord` for the user + gateway and auto-populates the field. Admins can still override.

**Alternative rejected**: Pulling from ledger metadata or `GatewaySubscription.gatewayData` — fragile when a user has multiple transactions. ChargeRecord is an explicit, queryable audit trail.

### 3.3 `paymentRefundId` Guard (Crash Recovery)

**Problem discovered during design**: The `processRefund()` caller does the `status = PROCESSED` update as a separate DB call after `processPaymentRefund()` returns. If the inner `$transaction` succeeds but the status update fails, on retry the refund is still APPROVED → re-enters `processPaymentRefund()` → would create duplicate ledger entries.

**Solution**: At the top of `processPaymentRefund`, check if `refund.paymentRefundId` is already set. If yes, skip to status update — ledger and credits were already written.

This gives us two crash recovery paths:

| Failure Point | State | Recovery |
|---|---|---|
| Gateway OK, DB `$transaction` fails | `paymentRefundId` = NULL (rolled back) | Error recorded (processAttempts++, lastProcessError saved). Full retry safe: gateway idempotent, DB runs fresh |
| DB OK, status update fails | `paymentRefundId` = SET | Error recorded. Guard fires → skip gateway/ledger/credits → only status update runs. lastProcessError cleared on success |

### 3.4 Chargeback Handler Inside Existing Transaction (Task 2)

The handler runs inside the webhook controller's existing `$transaction` (the `tx` parameter). All DB operations use `tx`, not `this.prisma`. This ensures atomicity with the dedup row — if anything fails, the dedup row rolls back and the gateway retries.

### 3.5 No Automatic Access Restoration on Dispute WON

We do NOT automatically restore subscription access when a dispute is won. Reasons:

1. The sub may have been canceled for a different reason (user-initiated, charge failure)
2. The billing period may have expired
3. Automatic reactivation without the user's consent risks confusion
4. In production, a human should review and decide

This is documented as a TODO comment in the code.

### 3.6 Dispute State Transition Validation

**Observation**: The existing `setOutcome` had zero status validation. Without a guard, calling WON then LOST would fire both revenue restoration AND fee expense — corrupting the ledger.

**Solution**: Added a transition map scoped to disputes only:

```
OPEN                → [WON, LOST, EVIDENCE_SUBMITTED]
EVIDENCE_SUBMITTED  → [WON, LOST]
WON                 → [] (terminal)
LOST                → [] (terminal)
```

Existing refund status checks are scaffold code — left untouched.

### 3.7 Credits Deduction — Graceful Failure

For both refunds and chargebacks, if the user has insufficient credits:

- **Log a warning and continue** — the real money refund/chargeback takes priority
- We don't block a $50 refund because the user already spent their virtual credits
- In production, this would warrant an alert for the finance team

### 3.8 Process Attempt Tracking (Operational Visibility)

**Problem identified during review**: When `processRefund` fails (gateway error, DB failure, validation error), the refund stays in APPROVED status with no record of what went wrong or how many times it was attempted. Admins have no visibility into stuck refunds and must rely on server logs.

**Solution**: Added `processAttempts` (Int, default 0) and `lastProcessError` (String, nullable) columns to `RefundRequest`. The `processRefund` method wraps the process call in a try/catch:

- On failure: increment `processAttempts`, save the error message to `lastProcessError`, then re-throw
- On success: clear `lastProcessError` (set to null)
- Admin UI: shows error message (red) and attempt count on APPROVED refunds that have failed

This gives admins immediate visibility into why a refund is stuck without requiring log access. The attempt count also surfaces persistent failures (e.g., gateway consistently declining) vs. transient issues.

### 3.9 Webhook Processing Model — Synchronous by Design Choice

Webhooks are processed synchronously inside `$transaction` before returning 200 to the gateway. In production this risks gateway HTTP timeouts under load — the industry best-practice is: persist raw payload → ack 200 → process async via job queue (BullMQ/SQS).

**We kept synchronous processing** because:
- Mock gateways are in-process with no real HTTP timeout
- The existing dedup + atomicity guarantees are simpler to reason about in isolation
- Adding BullMQ requires Redis infra and a worker process — a deliberate follow-on change

This is documented as the P1 improvement in `IMPLEMENTATION_PLAN.md #1` with a full migration plan.

---

## 4. Ledger Entries Reference

All entries balance: total DEBITs = total CREDITs.

### Entry Summary

| Event | Entry 1 | Entry 2 |
|-------|---------|---------|
| **Payment Refund** | DEBIT Revenue (revenue decreases) | CREDIT User ASSET (money returned) |
| **Chargeback** | DEBIT Revenue (revenue reversed) | CREDIT User ASSET (money disputed) |
| **Dispute WON** | DEBIT User ASSET (take back) | CREDIT Revenue (revenue re-recognized) |
| **Dispute LOST** (fee) | DEBIT Expense ($15 fee) | CREDIT User ASSET (cash left system) |

### Accounting Logic Explained

- **ASSET** is debit-normal → DEBIT increases it, CREDIT decreases it
- **REVENUE** is credit-normal → CREDIT increases it, DEBIT decreases it
- **EXPENSE** is debit-normal → DEBIT increases it (records a cost)

For refunds and chargebacks: `DEBIT Revenue + CREDIT User ASSET` = "revenue goes down, user's held credits go down." The `CREDIT User ASSET` means money is leaving our system back to the customer.

For dispute WON: the exact opposite — money comes back.

For dispute LOST fee: `DEBIT Expense + CREDIT User ASSET` = "$15 processor fee recorded as a business cost."

---

## 5. Flow Diagrams

### 5.1 processPaymentRefund Flow

```
Admin clicks "Process"
    │
    ▼
processRefund() — status == APPROVED?
    │ Yes
    ▼
refund.type == PAYMENT?
    │ Yes
    ▼
processPaymentRefund()
    │
    ├── Guard: paymentRefundId already set? ──Yes──► Skip to mark PROCESSED
    │                                                (crash recovery path 2)
    │ No
    ▼
Resolve gateway adapter (AUTHORIZE_NET or SOLANA)
    │
    ▼
Call adapter.refundCharge(idempotencyKey: refund_{id})
    │
    ├── Gateway error ──► Throw, refund stays APPROVED
    │
    │ Success: { gatewayRefundId }
    ▼
DB $transaction:
    ├── 1. Get/create ledger accounts
    ├── 2. Record ledger reversal (DEBIT Revenue, CREDIT User ASSET)
    ├── 3. Update refund: paymentRefundId = gatewayRefundId
    └── 4. Deduct credits (warn + continue if insufficient)
    │
    ▼
Mark refund status = PROCESSED
```

### 5.2 chargeback.received Flow

```
Webhook arrives → HMAC verified
    │
    ▼
Fast-path dedup: processed_webhooks has eventId?
    ├── Yes → return {skipped: true}
    │
    │ No
    ▼
$transaction:
    ├── Insert dedup row (processed_webhooks)
    ├── createDispute(tx) — idempotent by gatewayDisputeId
    │       ├── Already exists + has ledgerReversalTxnId? → Skip ledger
    │       └── New dispute created
    ├── Ledger reversal (DEBIT Revenue, CREDIT User ASSET)
    ├── Update dispute: ledgerReversalTxnId = txn.id
    └── Deduct credits (warn + continue if insufficient)
    │
    ▼
Return {received: true}
```

### 5.3 setOutcome Flow

```
Admin records outcome
    │
    ▼
Validate transition (OPEN/EVIDENCE_SUBMITTED → WON/LOST)
    │
    ├── WON:
    │   ├── Reversal-of-reversal (DEBIT User ASSET, CREDIT Revenue)
    │   ├── Restore credits (idempotent key: dispute_won_{id})
    │   └── Update dispute: status=WON, resolvedAt=now
    │
    └── LOST:
        ├── Original reversal stays (revenue already reduced)
        ├── Record $15 chargeback fee (DEBIT Expense, CREDIT User ASSET)
        └── Update dispute: status=LOST, resolvedAt=now
```

---

## 6. Idempotency Map

Every mutating operation and its protection:

| Operation | Idempotency Key | Where Enforced |
|-----------|----------------|---------------|
| Gateway `refundCharge()` | `refund_{refundRequestId}` | Gateway mock (in-memory Map) |
| Credits deduction (refund) | `refund_deduct_{refundRequestId}` | CreditsService (JSONB inside `$transaction`) |
| Chargeback webhook dedup | `eventId` (gateway event ID) | `processed_webhooks` unique PK + P2002 fallback |
| Dispute creation | `gatewayDisputeId` (unique column) | DisputesService (`findUnique` check) |
| Credits deduction (chargeback) | `chargeback_{transactionId}` | CreditsService (JSONB inside `$transaction`) |
| Credits restore (dispute WON) | `dispute_won_{disputeId}` | CreditsService (JSONB inside `$transaction`) |
| **Ledger — payment refund** | `refund_{refundId}_ledger` | `ledger_transactions.idempotency_key` UNIQUE |
| **Ledger — chargeback reversal** | `chargeback_{transactionId}_reversal_ledger` | `ledger_transactions.idempotency_key` UNIQUE |
| **Ledger — dispute WON** | `dispute_won_{disputeId}_ledger` | `ledger_transactions.idempotency_key` UNIQUE |
| **Ledger — dispute LOST fee** | `dispute_lost_{disputeId}_fee_ledger` | `ledger_transactions.idempotency_key` UNIQUE |
| ChargeRecord upsert | `(gatewayType, gatewayTransactionId)` | `charge_records` composite UNIQUE |

---

## 7. Failure & Recovery Matrix

| Failure Point | State After Failure | Recovery | Data Consistency |
|---|---|---|---|
| **Refund: gateway fails** | Refund=APPROVED, processAttempts++, lastProcessError saved | Admin sees error in UI, retries "Process" | Clean — nothing written |
| **Refund: gateway OK, DB fails** | Refund=APPROVED, processAttempts++, gateway DID refund | Admin sees error in UI, retries — gateway returns cached result | No double-refund |
| **Refund: DB OK, status update fails** | Refund=APPROVED, processAttempts++, ledger written | `paymentRefundId` guard fires on retry — skips to status update. lastProcessError cleared | No duplicate ledger |
| **Chargeback: handler throws** | No dedup row, no dispute | Gateway retries webhook | Full rollback via `$transaction` |
| **Chargeback: two concurrent replays** | One wins, one gets P2002 | Loser returns `{skipped: true}` | Exactly-once via unique constraint |
| **Outcome: DB write fails** | Dispute unchanged | Admin retries outcome | Ledger + credits use idempotency keys |

---

## 8. What We Didn't Build & Known Gaps

### Not built (by design)

- **Automatic access restoration on dispute WON** — requires human review (see Section 3.5)
- **Solana chargeback handling** — only Authorize.Net has chargebacks in this scaffold
- **Email notifications** — out of scope
- **Retry/dunning logic** — intentionally omitted; failed charge = immediate cancellation

### Implemented improvements (beyond initial scope)

| Improvement | What changed |
|---|---|
| Ledger idempotency key | `idempotency_key UNIQUE` on `ledger_transactions`; all callers pass named keys |
| ChargeRecord + auto-populate | Settled charges logged; `createRefundRequest` auto-looks up txn ID |
| Configurable chargeback fee | `billing_config` table + `BillingConfigService`; no compile-time constants |

### Remaining gaps for production

| Gap | Impact | Planned Follow-up |
|-----|--------|-------------------|
| No async webhook processing | Risk of gateway timeouts under load | IMPLEMENTATION_PLAN.md #1 (BullMQ) |
| Header-based auth stub | Not deployable to real environments | IMPLEMENTATION_PLAN.md #2 (JWT) |
| Credits gap — silent warn only | Finance team has no visibility | IMPLEMENTATION_PLAN.md #6 (finance alert queue) |
| Dispute WON → access restoration | Manual admin intervention required | IMPLEMENTATION_PLAN.md #7 |
| No automated reconciliation | Missed chargebacks not caught proactively | IMPLEMENTATION_PLAN.md #8 |

---

## 9. Testing Summary

### Unit Tests (56 total, all passing)

| Spec File | Tests | Coverage |
|-----------|-------|----------|
| `refunds.service.spec.ts` | 14 | Happy path, crash recovery, gateway errors, missing fields, insufficient credits |
| `disputes.service.spec.ts` | 9 | Idempotency, evidence, WON/LOST outcomes, invalid transitions, not-found |
| `authorize-net-webhook.controller.spec.ts` | 5 | Chargeback flow, idempotent replay, dedup fast-path, P2002 race, credits failure |
| `credits.service.spec.ts` | 10 | (existing) |
| `ledger.service.spec.ts` | 4 | (existing) |
| `subscriptions.service.spec.ts` | 10 | (existing) |
| `hmac.util.spec.ts` | 4 | (existing) |

### Edge Cases Covered by Tests

- Crash recovery path 2 (`paymentRefundId` already set)
- Gateway errors propagate without touching DB
- Missing `gatewayType` / `originalGatewayTransactionId` validation
- DB transaction failure after gateway success
- Insufficient credits — graceful continuation
- Duplicate chargeback webhook (fast-path dedup)
- P2002 unique constraint race condition
- Invalid dispute state transitions (WON→LOST)
- Idempotent dispute creation (existing `gatewayDisputeId`)

