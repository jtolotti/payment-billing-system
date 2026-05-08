# Manual Testing & Navigation Guide

> Step-by-step walkthrough to verify every feature we implemented. Follow these in order — each scenario builds on the previous one.

---

## Prerequisites

```bash
# 1. Start Postgres
docker compose up -d

# 2. Install, migrate, seed
npm run setup

# 3. Start dev servers (API :4000, Web :3000)
npm run dev

# 4. Run all tests (should be 56 passing)
npm run test
```

Open http://localhost:3000 in your browser. Select **test-user-1** as the active user.

---

## Scenario 1: Payment Refund — Full Lifecycle

### Goal
Verify `processPaymentRefund` executes the gateway refund, writes ledger entries, deducts credits, and updates the UI.

### Steps

**1.1 — Create a charge to refund against**

```bash
curl -X POST http://localhost:4000/__simulator__/card/rebill \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","plan":"STANDARD","amountCents":1000}'
```

**Expected**: 200 OK. Subscription created/renewed. Credits granted.

**1.2 — Check credits balance**

```bash
curl http://localhost:4000/credits \
  -H 'x-user-id: test-user-1'
```

**Expected**: Balance should include the credits from the charge.

**1.3 — Create a PAYMENT refund request**

Navigate to http://localhost:3000 → sign in as **test-user-1** → go to the refund request page (`/billing/refund-request`).

Or via API:

```bash
curl -X POST http://localhost:4000/refunds \
  -H 'content-type: application/json' \
  -H 'x-user-id: test-user-1' \
  -d '{
    "type": "PAYMENT",
    "amount": 1000,
    "reason": "Testing payment refund flow",
    "gatewayType": "AUTHORIZE_NET",
    "originalGatewayTransactionId": "an_txn_test_001"
  }'
```

**Expected**: 201 Created. Refund status = PENDING.

**1.4 — Approve the refund (admin)**

Navigate to http://localhost:3000/admin/refunds (you may need to switch user context — the admin endpoints use the `x-user-id` header and the seeded admin user).

Or via API:

```bash
curl -X POST http://localhost:4000/refunds/admin/<REFUND_ID>/approve \
  -H 'content-type: application/json' \
  -H 'x-user-id: test-admin-1' \
  -d '{"notes": "Approved for testing"}'
```

**Expected**: Refund status = APPROVED.

**1.5 — Process the refund (admin)**

Click "Process" on the admin refunds page, or:

```bash
curl -X POST http://localhost:4000/refunds/admin/<REFUND_ID>/process \
  -H 'x-user-id: test-admin-1'
```

**Expected**:
- Refund status = PROCESSED
- `paymentRefundId` is set (visible in admin UI under the status badge)
- Credits balance decreased by 1000
- A ledger reversal transaction was created

**1.6 — Verify in admin UI**

Go to http://localhost:3000/admin/refunds

**Expected**: The row shows:
- Status badge: "PROCESSED" (green)
- Below status: "Refund: gw-refund-..." (the gateway refund ID)

**1.7 — Verify idempotency (double-click protection)**

Try processing again:

```bash
curl -X POST http://localhost:4000/refunds/admin/<REFUND_ID>/process \
  -H 'x-user-id: test-admin-1'
```

**Expected**: Error — "Only approved refund requests can be processed" (status is already PROCESSED).

---

## Scenario 2: Chargeback — Full Lifecycle

### Goal
Verify the `chargeback.received` handler creates a dispute, writes ledger reversal, deducts credits, and the admin can manage the dispute.

### Steps

**2.1 — Ensure the user has a charge to dispute**

If you didn't run Scenario 1, create a charge first:

```bash
curl -X POST http://localhost:4000/__simulator__/card/rebill \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","plan":"STANDARD","amountCents":2000}'
```

**2.2 — Trigger a chargeback**

```bash
curl -X POST http://localhost:4000/__simulator__/card/chargeback \
  -H 'content-type: application/json' \
  -d '{
    "userId": "test-user-1",
    "originalTransactionId": "an_txn_test_002",
    "amountCents": 2000,
    "reason": "fraudulent"
  }'
```

**Expected**: 200 OK with `{ "received": true }`.

**2.3 — Verify dispute in admin UI**

Navigate to http://localhost:3000/admin/disputes

**Expected**:
- A new row appears for **test-user-1**
- Status: "OPEN" (amber badge)
- Amount: $20.00
- Click the row → goes to detail page

**2.4 — View dispute detail**

On the detail page at `/admin/disputes/<DISPUTE_ID>`:

**Expected**:
- **Overview card**: Shows user, gateway (AUTHORIZE_NET), amount, status, opened date, gateway dispute ID, original transaction ID, ledger reversal txn ID
- **Evidence card**: "0 items submitted"
- **Resolve Dispute card**: "Mark as WON" and "Mark as LOST" buttons

**2.5 — Submit evidence**

On the detail page:
1. Select evidence type: "Access Log"
2. Type: "User logged in 47 times between 2026-01-01 and 2026-04-01. Last job submitted 2026-03-28."
3. Click "Submit Evidence"

**Expected**:
- Evidence appears in the list with type badge, timestamp, and content
- Dispute status changes to "EVIDENCE_SUBMITTED" (blue badge)

**2.6 — Test idempotent replay (same chargeback)**

Fire the same chargeback simulator again:

```bash
curl -X POST http://localhost:4000/__simulator__/card/chargeback \
  -H 'content-type: application/json' \
  -d '{
    "userId": "test-user-1",
    "originalTransactionId": "an_txn_test_002",
    "amountCents": 2000,
    "reason": "fraudulent"
  }'
```

**Expected**: 200 OK, but with `{ "received": true, "skipped": true }` — the duplicate was caught by the dedup pattern. No second dispute or ledger entry.

---

## Scenario 3: Dispute Resolution — WON

### Goal
Verify that marking a dispute as WON reverses the ledger reversal and restores credits.

### Steps

**3.1 — Note the user's credits balance before resolution**

```bash
curl http://localhost:4000/credits \
  -H 'x-user-id: test-user-1'
```

**3.2 — Mark dispute as WON**

On the dispute detail page, click "Mark as WON".

Or via API:

```bash
curl -X POST http://localhost:4000/admin/disputes/<DISPUTE_ID>/outcome \
  -H 'content-type: application/json' \
  -H 'x-user-id: test-admin-1' \
  -d '{"outcome": "WON"}'
```

**Expected**:
- Dispute status changes to "WON" (green badge)
- Resolved date populated
- "Resolve Dispute" card disappears (dispute is terminal)
- Evidence form disappears

**3.3 — Verify credits were restored**

```bash
curl http://localhost:4000/credits \
  -H 'x-user-id: test-user-1'
```

**Expected**: Credits balance increased by the dispute amount (2000).

**3.4 — Verify double-WON is rejected**

```bash
curl -X POST http://localhost:4000/admin/disputes/<DISPUTE_ID>/outcome \
  -H 'content-type: application/json' \
  -H 'x-user-id: test-admin-1' \
  -d '{"outcome": "LOST"}'
```

**Expected**: 400 error — "Invalid dispute transition: WON → LOST"

---

## Scenario 4: Dispute Resolution — LOST

### Goal
Verify that marking a dispute as LOST records the chargeback fee.

### Steps

**4.1 — Create a fresh chargeback**

```bash
# Reset user state first (optional, for clean test)
curl -X POST http://localhost:4000/__simulator__/reset \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1"}'

# Create a charge
curl -X POST http://localhost:4000/__simulator__/card/rebill \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","plan":"STANDARD","amountCents":3000}'

# Trigger chargeback
curl -X POST http://localhost:4000/__simulator__/card/chargeback \
  -H 'content-type: application/json' \
  -d '{
    "userId": "test-user-1",
    "originalTransactionId": "an_txn_test_003",
    "amountCents": 3000,
    "reason": "product_not_received"
  }'
```

**4.2 — Mark dispute as LOST**

Navigate to `/admin/disputes` → click the new dispute → click "Mark as LOST".

**Expected**:
- Dispute status = "LOST" (red badge)
- Resolved date populated
- A $15 (1500 cents) chargeback fee was recorded as an expense in the ledger

**4.3 — Verify no credits restoration**

Credits should NOT be restored when we lose. The credits deducted at chargeback time stay deducted.

---

## Scenario 5: Chargeback on Already-Canceled Subscription

### Goal
Verify the normal case — most chargebacks arrive 30-45 days after the charge, on subscriptions that are already canceled.

### Steps

**5.1 — Create and cancel a subscription**

```bash
# Create subscription
curl -X POST http://localhost:4000/__simulator__/card/rebill \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","plan":"STANDARD","amountCents":1500}'

# Simulate a failed charge (triggers immediate cancellation per no-dunning policy)
curl -X POST http://localhost:4000/__simulator__/card/charge-failure \
  -H 'content-type: application/json' \
  -d '{"userId":"test-user-1","reason":"declined_insufficient_funds"}'
```

**Expected**: Subscription is now canceled.

**5.2 — Trigger a chargeback against the earlier charge**

```bash
curl -X POST http://localhost:4000/__simulator__/card/chargeback \
  -H 'content-type: application/json' \
  -d '{
    "userId": "test-user-1",
    "originalTransactionId": "an_txn_test_canceled",
    "amountCents": 1500,
    "reason": "fraudulent"
  }'
```

**Expected**: Dispute created successfully. The sub being canceled does NOT block chargeback processing. Ledger reversal written. Credits deducted (or warned if insufficient).

---

## Scenario 6: CREDITS Refund (Existing, Verify Not Broken)

### Goal
Verify the existing CREDITS refund path still works after our changes.

### Steps

```bash
# Create a CREDITS refund request
curl -X POST http://localhost:4000/refunds \
  -H 'content-type: application/json' \
  -H 'x-user-id: test-user-1' \
  -d '{"type": "CREDITS", "amount": 500, "reason": "Testing credits refund"}'

# Approve
curl -X POST http://localhost:4000/refunds/admin/<REFUND_ID>/approve \
  -H 'content-type: application/json' \
  -H 'x-user-id: test-admin-1' \
  -d '{"notes": "Approved"}'

# Process
curl -X POST http://localhost:4000/refunds/admin/<REFUND_ID>/process \
  -H 'x-user-id: test-admin-1'
```

**Expected**: Refund processed. Credits added back to user. No gateway interaction (CREDITS type doesn't touch gateway).

---

## Quick Verification Checklist

| # | What to verify | How | Expected |
|---|----------------|-----|----------|
| 1 | All tests pass | `npm run test` | 56 passed, 0 failed |
| 2 | PAYMENT refund processes | Admin UI → Process button | Status = PROCESSED, gateway refund ID shown |
| 3 | Chargeback creates dispute | Simulator → check admin disputes page | New OPEN dispute with correct amount |
| 4 | Chargeback is idempotent | Fire same chargeback twice | Second returns `{skipped: true}` |
| 5 | Dispute WON reverses ledger | Mark WON → check credits | Credits restored |
| 6 | Dispute LOST records fee | Mark LOST | $15 fee in ledger |
| 7 | Invalid transitions rejected | Try WON→LOST | 400 error |
| 8 | Evidence upload works | Submit on detail page | Evidence appears in list |
| 9 | Credits refund still works | Full CREDITS refund flow | No errors, credits returned |
| 10 | Canceled sub chargeback works | Cancel sub → chargeback | Dispute created normally |
