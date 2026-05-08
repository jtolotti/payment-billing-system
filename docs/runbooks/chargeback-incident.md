# Chargeback Received: Dispute Created by Gateway Webhook

> **Purpose:** Respond to a chargeback event, verify the dispute was created correctly, gather evidence, and resolve the dispute.
> **Frequency:** ~2-5 per month in a healthy system. Spikes indicate fraud or service issues.
> **Expected duration:** Initial triage: 10 minutes. Evidence gathering: 1-3 business days. Resolution: depends on processor timeline.
> **Prerequisites:** DB read access, gateway dashboard access, admin UI access, familiarity with dispute resolution process.

---

## 1. Severity classification

| Scenario | Severity | Action |
|---|---|---|
| Single chargeback, < $100 | **P3** | Respond within 4 business hours, gather evidence within 1 business day |
| 3+ chargebacks from different users in 24h | **P2** | Investigate for fraud pattern or service outage before individual responses |
| Chargeback rate exceeds 1% of transactions in a week | **P1** | Incident channel, page on-call, contact payment processor — risk of account suspension |

If you're not sure, default up one level.

## 2. Diagnosis

### 2.1 Confirm the dispute was created

When a `chargeback.received` webhook fires, the system automatically:
1. Creates a `Dispute` row (idempotent by `gatewayDisputeId`)
2. Writes a ledger reversal (DEBIT Revenue, CREDIT User ASSET)
3. Records `ledgerReversalTxnId` on the dispute
4. Deducts credits (graceful failure if insufficient)

Verify all of this happened:

```sql
-- Find the dispute
SELECT id, user_id, status, amount, gateway_dispute_id,
       original_transaction_id, ledger_reversal_txn_id, opened_at
FROM disputes
WHERE gateway_dispute_id = 'an_dispute_<transactionId>';

-- Verify the ledger reversal
SELECT lt.id, lt.description, le.entry_type, le.amount, la.account_type
FROM ledger_transactions lt
JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
JOIN ledger_accounts la ON la.id = le.account_id
WHERE lt.id = '<ledger_reversal_txn_id>';

-- Verify credits were deducted
SELECT ct.amount, ct.description, ct.metadata
FROM credit_transactions ct
JOIN credits c ON c.id = ct.credits_id
WHERE c.user_id = '<user-id>'
  AND ct.metadata->>'idempotencyKey' = 'chargeback_<transactionId>';
```

### 2.2 If the dispute was NOT created

Check if the webhook was received at all:

```sql
SELECT id, event_type, processed_at
FROM processed_webhooks
WHERE id = '<eventId>'
  AND source = 'authorize_net';
```

- **No row:** Webhook wasn't delivered or failed HMAC verification. Check API logs for 400 responses on `/webhooks/authorize-net`. Consider replaying from the gateway dashboard.
- **Row exists but no dispute:** The `applyEvent` transaction threw an error after the dedup row was committed. Check API error logs. The dedup row will prevent automatic replay — you may need to delete it and replay, or create the dispute manually.

### 2.3 Confirm the original charge at the gateway

Open the Authorize.net dashboard and look up the original transaction:
- Transaction ID, amount, date
- Customer name / email
- Whether the chargeback reason code suggests fraud vs. legitimate dispute
- Processor deadline for evidence submission

## 3. Evidence Gathering

Use the admin UI at `/admin/disputes/<id>` to submit evidence. Common evidence types:

| Type | What to include |
|---|---|
| `access_log` | User login/activity records showing service was delivered and used |
| `communications` | Emails, support tickets showing user acknowledged the charge |
| `terms_accepted` | Timestamp and IP of terms-of-service acceptance, cancellation policy |
| `other` | Delivery confirmation, screenshots, receipts |

```typescript
// Or via API directly:
await api.post(`/admin/disputes/${disputeId}/evidence`, {
  evidenceType: 'access_log',
  content: 'User logged in 47 times between 2026-01-01 and 2026-02-01. Last job submitted: 2026-01-28.'
})
```

**Tip:** Include specific dates, counts, and job IDs. Vague evidence ("user used the service") is weaker than specific evidence ("user submitted 12 jobs totaling $340 in the disputed period").

## 4. Resolution

### 4.1 We won the dispute

Use the admin UI or API:

```typescript
await api.post(`/admin/disputes/${disputeId}/outcome`, { outcome: 'WON' })
```

This automatically:
- Writes a reversal-of-reversal ledger entry (DEBIT User ASSET, CREDIT Revenue — revenue restored)
- Restores credits to the user (idempotent via `dispute_won_<disputeId>` key)
- Marks the dispute as WON

**Important:** Subscription access is NOT automatically restored. The subscription may have been canceled for unrelated reasons or the period may have expired. Review manually before restoring access.

Verify:

```sql
SELECT status, resolved_at FROM disputes WHERE id = '<disputeId>';
-- Should be: WON, with a resolved_at timestamp

-- Verify credits were restored
SELECT balance FROM credits WHERE user_id = '<user-id>';
```

### 4.2 We lost the dispute

```typescript
await api.post(`/admin/disputes/${disputeId}/outcome`, { outcome: 'LOST' })
```

This automatically:
- Keeps the original ledger reversal in place (revenue stays reduced)
- Records a $15.00 (1500 cents) chargeback fee as an expense (DEBIT Expense, CREDIT User ASSET)
- Marks the dispute as LOST

Verify:

```sql
SELECT status, resolved_at FROM disputes WHERE id = '<disputeId>';
-- Should be: LOST, with a resolved_at timestamp

-- Verify chargeback fee was recorded
SELECT lt.description, le.amount, la.account_type
FROM ledger_transactions lt
JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
JOIN ledger_accounts la ON la.id = le.account_id
WHERE lt.metadata->>'disputeId' = '<disputeId>'
  AND lt.metadata->>'type' = 'chargeback_fee';
```

## 5. User Communication

### If we won:

```
Subject: Dispute resolved in your favor

Hi <name>,

The payment dispute for $<X.XX> on <date> has been resolved. No further
action is needed on your end.

If you have questions about your account, please reach out.

— <company> Billing
```

### If we lost:

```
Subject: Payment dispute update

Hi <name>,

We were unable to resolve the dispute for $<X.XX> on <date> in our
favor. A $15.00 chargeback fee has been applied to your account.

If you believe this is an error, please contact support.

— <company> Billing
```

## 6. Prevention

After resolving any chargeback, check for patterns:

```sql
-- Chargeback rate over the last 30 days
SELECT
  COUNT(*) AS total_chargebacks,
  SUM(amount) AS total_cents,
  COUNT(DISTINCT user_id) AS unique_users
FROM disputes
WHERE opened_at > NOW() - INTERVAL '30 days';

-- Repeat offenders
SELECT user_id, COUNT(*) AS dispute_count, SUM(amount) AS total_cents
FROM disputes
WHERE opened_at > NOW() - INTERVAL '90 days'
GROUP BY user_id
HAVING COUNT(*) > 1
ORDER BY dispute_count DESC;
```

If chargeback rate is climbing:
- Review sign-up flow for fraud signals
- Check if cancellation flow is clear (confused users dispute instead of canceling)
- Consider adding pre-charge email reminders
- Contact payment processor proactively if rate approaches 1%

## 7. What to log when closing the ticket

- Dispute id
- User id
- Amount
- Original gateway transaction id
- Outcome (WON / LOST)
- Evidence submitted (types and summary)
- Chargeback reason code from processor
- Whether this user has prior disputes
- One-line root cause ("friendly fraud", "service not delivered", "billing confusion", "unknown")
