# Architecture

System overview for the Payment & Billing System. Covers the money model, gateway abstraction, webhook processing, and the full refund/chargeback lifecycle.

## Stack

- **API:** NestJS 11 + Prisma + Postgres (in Docker)
- **Web:** Next.js 14 (App Router) + Tailwind + `@billing/ui`
- **UI library:** `@billing/ui`, a local package of 10 Radix-based primitives (`Button`, `Input`, `Card`, `Dialog`, `Table`, `Badge`, `Spinner`, `Alert`, `Form`, `Select`).
- **Auth:** `x-user-id` header middleware. Development stub — see [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for planned JWT migration.

## Two parallel money systems

### The Ledger (`src/billing/ledger.service.ts`)

Formal double-entry accounting. Every user has a set of `LedgerAccount` rows keyed by `(userId, accountType)`. Account types:

| Type | Normal balance | What it represents |
|---|---|---|
| `ASSET` | Debit | User's held credits (money we owe them) |
| `LIABILITY` | Credit | Escrowed credits pending resolution |
| `REVENUE` | Credit | Realized revenue |
| `EXPENSE` | Debit | Costs (chargeback fees, refund fees) |
| `EQUITY` | Credit | Unused in the trial baseline |

Every transaction is at least two entries. Debits must equal credits. The service enforces this invariant in `recordTransaction` — if you try to record an unbalanced transaction, it rejects with `BadRequestException` before touching the DB.

Balance arithmetic:
- **Debit-normal accounts** (ASSET, EXPENSE): DEBIT increases balance, CREDIT decreases.
- **Credit-normal accounts** (LIABILITY, REVENUE, EQUITY): CREDIT increases balance, DEBIT decreases.

`calculateBalanceChange` in the service encodes this.

### The Credits system (`src/billing/credits.service.ts`)

Simpler flat balance. One `Credits` row per user with an `Int balance`. Each mutation logs a `CreditTransaction` with the operation type and an idempotency key stored in JSONB metadata.

**Why two systems?** The ledger is the formal record for auditing and money correctness. The credits system is the user-facing "how many credits do I have left" number. They move together: when a credit purchase webhook fires, we update both. You'll need to reason about keeping them in sync when implementing your refunds.

### Idempotency pattern

Every mutating method on `CreditsService` takes an `idempotencyKey: string`. Convention is `{source}_{externalId}`:
- `authorize_net_charge_{transactionId}`
- `authorize_net_refund_{transactionId}`
- `solana_charge_{txHash}`
- `refund_{refundRequestId}`
- Your new code: invent consistent keys that follow this pattern.

The idempotency check is inside the `$transaction`, not outside. If you check first and then mutate, two concurrent replays can both pass the check and both insert.

`CreditsService.deductCredits` additionally uses `SELECT ... FOR UPDATE` with `ReadCommitted` isolation to row-lock the credits row. This prevents a double-spend race between two simultaneous deductions.

## The gateway abstraction

`src/gateways/gateway.interface.ts` defines `PaymentGatewayAdapter`:

```typescript
interface PaymentGatewayAdapter {
  readonly gateway: PaymentGateway
  createSubscription(params): Promise<{ gatewaySubscriptionId, gatewayCustomerId, gatewayData }>
  cancelSubscription(params): Promise<void>
  refundCharge(params): Promise<{ gatewayRefundId, refundedAmount }>
}
```

Two implementations:

### `AuthorizeNetGateway`

Simulates a push-style, HMAC-webhook processor. `buildSignedWebhook` returns a `{ body, signature }` pair that can be delivered into the webhook controller. The simulator uses this to fire events.

Event types: `subscription.created`, `subscription.renewed`, `subscription.canceled`, `charge.approved`, `charge.refunded`, `charge.failed`, `chargeback.received`.

### `SolanaGateway`

Simulates an on-chain confirmation-depth model. `buildConfirmationEvent` returns an event with a `confirmations` count. The confirmation controller only materializes side effects once `confirmations >= SOLANA_REQUIRED_CONFIRMATIONS` (default 3).

Dedup on the Solana side is by `txHash` (the on-chain tx hash is globally unique).

### Refunds work across both

`PaymentGatewayAdapter.refundCharge` is the method your `processPaymentRefund` implementation will call. Both mock implementations are idempotent on `idempotencyKey` — if you pass the same key twice, you get the same `gatewayRefundId` back without double-refunding the fake gateway.

## The webhook dedup pattern

Both webhook controllers follow the exact same pattern. Do not deviate from it:

```typescript
// 1. Verify HMAC signature (card path only — Solana is unsigned)
if (!verifyHmac(req.rawBody, signature, secret)) throw new BadRequestException(...)

// 2. Fast-path dedup check OUTSIDE the transaction
const existing = await prisma.processedWebhook.findUnique({ where: { id: event.eventId } })
if (existing) return { received: true, skipped: true }

// 3. Atomic: write the dedup row + apply the side effect in ONE $transaction
try {
  await prisma.$transaction(async (tx) => {
    await tx.processedWebhook.create({ data: { id: event.eventId, source, eventType } })
    await applyEvent(tx, event)
  })
} catch (err) {
  // 4. Race condition fallback: if two replays both pass the fast-path check,
  //    the unique constraint on processed_webhooks.id will fire P2002 on one of them.
  if (err?.code === 'P2002') return { received: true, skipped: true }
  throw err
}
```

**Why this pattern:** If the side effect fails, the `processed_webhooks` row is rolled back and the event will be retried. This prevents "we logged that we processed it but the actual side effect never happened" bugs — which is the single most common cause of missing credits in a real billing system.

**Do not** break this pattern by moving the side effect outside the transaction, or by doing the dedup check and the dedup row insert in separate transactions. Both are subtly broken in ways that are very expensive to debug in production.

## The three-step refund workflow

`src/refunds/refunds.service.ts` implements:

```
createRefundRequest(user)   → PENDING
     ↓
approveRefund(admin)        → APPROVED
     ↓
processRefund(admin)        → PROCESSED
```

Both CREDITS and PAYMENT refunds are fully implemented. PAYMENT refunds execute via the gateway adapter, write a balanced ledger reversal, and deduct credits atomically. See `processPaymentRefund` in `refunds.service.ts`.

## No retry dunning

`SubscriptionsService.cancelImmediately` is the only path for handling failed charges. A failed charge cancels the sub and drops the plan to BASIC immediately — no grace period, no retry schedule, no `past_due` dwell state. Enforced in `subscriptions.service.spec.ts` and the `charge.failed` webhook handler.

This means most refund/chargeback targets will be against already-canceled subscriptions. Both flows handle this as normal, not an edge case — the ledger entries are the same regardless of subscription state.

## Implemented features

### Payment refund workflow (`processPaymentRefund`)

Three-step admin workflow: `PENDING → APPROVED → PROCESSED`. The `processPaymentRefund` method:

1. **Gateway-first** — calls `adapter.refundCharge()` with idempotency key `refund_{refundId}` before any DB writes. Avoids holding Postgres locks during external HTTP.
2. **Crash-safe DB transaction** — ledger reversal + `paymentRefundId` update in one `$transaction`. If the status update after the transaction crashes, the `paymentRefundId` guard skips re-processing on the next retry.
3. **Process attempt tracking** — `processAttempts` and `lastProcessError` on `RefundRequest` so admins see stuck refunds in the UI without log access.
4. **Partial refunds** — `refundedAmount` comes from the gateway response, not the request amount.

Crash recovery paths:

| Failure Point | State After | Recovery |
|---|---|---|
| Gateway OK → DB `$transaction` fails | `paymentRefundId` = NULL (rolled back) | Full retry safe — gateway returns cached result |
| DB OK → status update fails | `paymentRefundId` = SET | Guard fires on retry — skips to status update only |

### Chargeback / dispute lifecycle

The `chargeback.received` webhook handler runs **inside** the existing dedup `$transaction`:

1. Insert dedup row (`processed_webhooks`)
2. `createDispute` — idempotent by `gatewayDisputeId`
3. Ledger reversal: DEBIT Revenue + CREDIT User ASSET
4. Store `ledgerReversalTxnId` on the dispute (for WON unwinding)
5. Deduct credits (warn + continue on insufficient balance)

Outcome handling (`setOutcome`):

- **WON** — reversal-of-reversal (DEBIT User ASSET + CREDIT Revenue) + restore credits
- **LOST** — original reversal stands + record $15 chargeback fee (DEBIT Expense + CREDIT User ASSET)
- State machine: `OPEN / EVIDENCE_SUBMITTED → WON | LOST` (terminal). Invalid transitions reject with 400.

## Module dependency graph

```
AppModule
├── BillingModule
│   ├── LedgerService      ← used by refunds, disputes, webhook
│   ├── CreditsService     ← used by refunds, disputes, webhook
│   ├── SubscriptionsService
│   └── PlansService
│
├── GatewaysModule (imports: BillingModule, DisputesModule)
│   ├── AuthorizeNetGateway          ← used by refunds
│   ├── SolanaGateway                ← used by refunds
│   ├── AuthorizeNetWebhookController  ← injects LedgerService + DisputesService
│   └── SolanaConfirmationController
│
├── RefundsModule (imports: BillingModule, GatewaysModule)
│   └── RefundsService     ← injects AN/Solana gateways + LedgerService
│
├── DisputesModule (imports: BillingModule)
│   └── DisputesService    ← injects LedgerService + CreditsService
│
└── SimulatorModule
```

No circular dependencies. Dependency direction: `RefundsModule → GatewaysModule → DisputesModule → BillingModule`.

## File tour

```
apps/api/src/
├── main.ts                              ← bootstrap, raw body for HMAC
├── app.module.ts
├── common/
│   ├── prisma.service.ts                ← Prisma client
│   ├── fake-auth.middleware.ts          ← x-user-id → req.user (dev stub)
│   ├── current-user.decorator.ts        ← @CurrentUser(), @AdminUser()
│   └── hmac.util.ts                     ← signHmac, verifyHmac
├── billing/
│   ├── billing.module.ts
│   ├── billing.controller.ts            ← GET /billing/* endpoints
│   ├── ledger.service.ts                ← Double-entry ledger
│   ├── credits.service.ts               ← Flat credits balance + SELECT FOR UPDATE
│   ├── subscriptions.service.ts         ← Sub lifecycle (no retry dunning)
│   └── plans.service.ts
├── gateways/
│   ├── gateway.interface.ts             ← PaymentGatewayAdapter
│   ├── authorize-net/
│   │   ├── authorize-net.gateway.ts     ← Mock card gateway (in-memory)
│   │   └── authorize-net-webhook.controller.ts  ← HMAC webhook + dedup + chargeback
│   └── solana/
│       ├── solana.gateway.ts            ← Mock crypto gateway (confirmation-depth)
│       └── solana-confirmation.controller.ts    ← Confirmation-depth receiver
├── refunds/
│   ├── refunds.service.ts               ← 3-step workflow + processPaymentRefund
│   └── refunds.controller.ts
├── disputes/
│   ├── disputes.service.ts              ← Full OPEN→EVIDENCE→WON/LOST lifecycle
│   └── disputes.controller.ts
└── simulator/
    ├── simulator.service.ts             ← Deterministic event triggering
    └── simulator.controller.ts          ← POST /__simulator__/* endpoints

apps/web/src/app/
├── page.tsx                             ← Landing + dev user switcher
├── billing/page.tsx                     ← Sub + credits view
├── billing/refund-request/page.tsx      ← User refund form
├── admin/refunds/page.tsx               ← Admin refund dashboard (shows gatewayRefundId)
├── admin/disputes/page.tsx              ← Admin disputes list
└── admin/disputes/[id]/page.tsx         ← Dispute detail: evidence upload + outcome

packages/trial-ui/src/                   ← 10 Radix-based primitives (npm: @billing/ui)
├── button.tsx
├── input.tsx
├── textarea.tsx
├── select.tsx
├── card.tsx
├── dialog.tsx
├── form.tsx
├── table.tsx
├── alert.tsx
├── badge.tsx
└── spinner.tsx
```

## Architecture gaps & planned improvements

The following are known limitations with improvement proposals. Full prioritized plan in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

### 1. Synchronous webhook processing (highest risk)

The entire webhook handler — dedup check, dispute creation, ledger writes, credits — runs synchronously inside `$transaction` before returning 200 to the gateway. Under load: slow ledger writes or row-level lock contention causes gateway HTTP timeout → gateway retries → thundering-herd spiral.

**Planned fix:** Persist raw payload immediately, ack 200 within milliseconds, process async via BullMQ job queue. Workers handle idempotency and retry with exponential backoff.

### 2. Independent ledger idempotency key (defense-in-depth)

Ledger entries are currently only protected by the outer flow's dedup (gateway idempotency for refunds, `processed_webhooks` for chargebacks). A future code path that writes ledger entries outside those guards could produce duplicates.

**Planned fix:** Add `idempotency_key VARCHAR UNIQUE` column to `ledger_transactions`. One migration + small change to `recordTransaction`. One-line change with high safety value.

### 3. `originalGatewayTransactionId` populated manually

Admins must supply the original gateway transaction ID when creating a PAYMENT refund request. This is error-prone and blocks automation.

**Planned fix:** Store the transaction ID on the `charge.approved` webhook event in a new `ChargeRecord` table keyed by `(userId, gatewayTransactionId)`. Auto-populate on refund creation.

### 4. Header-based auth stub

All routes are protected by an `x-user-id` header middleware — zero security. Not deployable.

**Planned fix:** Replace with `@nestjs/passport` + JWT strategy. Access tokens issued on `/auth/login`, refresh tokens in httpOnly cookies. `@CurrentUser()` decorator stays, backed by `JwtStrategy` instead of the header stub.

### 5. Hardcoded chargeback fee

`CHARGEBACK_FEE_CENTS = 1500` is a compile-time constant. Different processors charge different fees; some vary by card type.

**Planned fix:** Move to a `billing_config` table (key/value) or per-gateway config in `.env`. Query at runtime in `handleLost`.

### 6. Silent credits gap on insufficient balance

When a user has insufficient credits during a refund or chargeback, the system logs a warning and continues. The finance team has no visibility.

**Planned fix:** Emit a structured event (or enqueue a notification job) when the credits deduction catch block fires. Alert routed to a finance Slack channel or PagerDuty low-priority queue.

### 7. No dispute WON → access restoration workflow

When a dispute is won, subscription access is NOT automatically restored. The subscription may have been canceled for unrelated reasons; auto-restore would be incorrect.

**Planned fix:** On `setOutcome('WON')`, enqueue a `dispute_won_review` job. Admin reviews in a separate queue page: they can approve restoration (which calls `subscriptions.reactivate`) or dismiss. User gets an email notification either way.

### 8. No automated reconciliation

Missed chargebacks (webhook failures, network gaps) are not caught proactively.

**Planned fix:** Scheduled job (NestJS `@Cron`) to compare the gateway's dispute list (via polling API) against the `disputes` table. Raise an alert for gaps older than 24 hours.
